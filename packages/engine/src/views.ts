import { LIMITS } from '@zqhoot/protocol';
import type {
  AnswerPayload,
  FinalStanding,
  HostSnapshot,
  LeaderboardEntry,
  LiveStats,
  OpenResponseView,
  OutboundMessage,
  PlayerOutcome,
  PlayerSnapshot,
  PlayerStanding,
  Question,
  QuestionResult,
  RosterEntry,
} from '@zqhoot/protocol';
import {
  allOpenViews,
  booleanCounts,
  compareByArrival,
  expectedAnswerers,
  optionCounts,
  ratingStats,
  revealedScoredCount,
  tally,
  wordCounts,
} from './aggregate.ts';
import type {
  PlayerRecord,
  PlayerScore,
  QuizSnapshot,
  ResponseRecord,
  Scoreboard,
  SessionMeta,
  StoredQuestionResult,
} from './model.ts';
import { isScoringQuestion, toPublicQuestion } from './questions.ts';
import { toPlayerResult } from './reveal.ts';
import type { PlayerMessage } from './reveal.ts';
import { EMPTY_SCORE, rankEntries } from './scoring.ts';
import { base64UrlDecode, base64UrlEncode, compareCodePoints, jsonBytes } from './util.ts';

const HOST_LEADERBOARD_SIZE = 10;

/**
 * `host.state` is one WebSocket message and API Gateway rejects anything over 128 KB (ADR-0004).
 * A roster of 500 nicknames at `LIMITS.nicknameMaxBytes` (96 UTF-8 bytes) takes about 82 KB of
 * it, so the open-ended responses share what is left; this keeps headroom for the envelope the
 * transport wraps around the snapshot. The budget bounds only the responses: the roster is
 * bounded by the nickname byte cap, not trimmed here.
 */
const HOST_STATE_MAX_BYTES = 120 * 1024;

const scoreOf = (board: Scoreboard | null, playerId: string): PlayerScore =>
  board?.players[playerId] ?? EMPTY_SCORE;

type RankedPlayer = LeaderboardEntry;

/** Every non-kicked player ranked by total score; players without a scoreboard entry count as 0. */
function rankPlayers(players: PlayerRecord[], board: Scoreboard | null): RankedPlayer[] {
  return rankEntries(
    players
      .filter((p) => !p.kicked)
      .map((p) => {
        const s = scoreOf(board, p.playerId);
        return { playerId: p.playerId, nickname: p.nickname, score: s.score, delta: s.lastDelta };
      }),
  );
}

function standingOf(ranked: RankedPlayer[], me: RankedPlayer): PlayerStanding {
  const standing: PlayerStanding = { score: me.score, rank: me.rank };
  // Nearest strictly-higher score: the last entry of the tie group directly above.
  const groupStart = ranked.findIndex((e) => e.rank === me.rank);
  const above = ranked[groupStart - 1];
  if (above !== undefined)
    standing.behind = { nickname: above.nickname, points: above.score - me.score };
  return standing;
}

function forEachActive(
  players: PlayerRecord[],
  ranked: RankedPlayer[],
  build: (me: RankedPlayer) => OutboundMessage,
): PlayerMessage[] {
  const byId = new Map(ranked.map((e) => [e.playerId, e]));
  const messages: PlayerMessage[] = [];
  for (const p of players) {
    const me = byId.get(p.playerId);
    if (me !== undefined) messages.push({ playerId: p.playerId, message: build(me) });
  }
  return messages;
}

function currentQuestion(meta: SessionMeta, snapshot: QuizSnapshot): Question {
  const q = snapshot.questions[meta.questionIndex];
  if (q === undefined) throw new Error(`no question at index ${meta.questionIndex}`);
  return q;
}

export function buildQuestionMessage(meta: SessionMeta, snapshot: QuizSnapshot): OutboundMessage {
  if (meta.openAt === null) throw new Error('question has no openAt');
  return {
    type: 'question',
    sv: meta.version,
    index: meta.questionIndex,
    total: meta.totalQuestions,
    question: toPublicQuestion(currentQuestion(meta, snapshot), snapshot.settings),
    openAt: meta.openAt,
    deadline: meta.deadline,
  };
}

export function buildLeaderboard(i: {
  meta: SessionMeta;
  scoreboard: Scoreboard;
  players: PlayerRecord[];
}): { entries: LeaderboardEntry[]; playerMessages: PlayerMessage[] } {
  const ranked = rankPlayers(i.players, i.scoreboard);
  const entries = ranked.slice(0, LIMITS.leaderboardSize);
  return {
    entries,
    playerMessages: forEachActive(i.players, ranked, (me) => ({
      type: 'leaderboard',
      sv: i.meta.version,
      index: i.meta.questionIndex,
      entries,
      you: standingOf(ranked, me),
    })),
  };
}

/**
 * Podium and final standings. Until a scoring question has been revealed (a quiz ended in the
 * lobby, say) everyone is tied on zero, so ranks and a podium would only reflect nickname order:
 * the podium stays empty and ranks are null.
 */
function endedView(i: {
  meta: SessionMeta;
  snapshot: QuizSnapshot;
  scoreboard: Scoreboard | null;
  players: PlayerRecord[];
}): {
  ranked: RankedPlayer[];
  podium: LeaderboardEntry[];
  standing: (me: RankedPlayer) => FinalStanding;
} {
  const ranked = rankPlayers(i.players, i.scoreboard);
  const scoredQuestions = revealedScoredCount(i.meta, i.snapshot, i.scoreboard);
  const podium =
    scoredQuestions > 0
      ? ranked.filter((e) => e.rank <= LIMITS.podiumSize).slice(0, LIMITS.podiumSize)
      : [];
  const standing = (me: RankedPlayer): FinalStanding => {
    const s = scoreOf(i.scoreboard, me.playerId);
    return {
      score: s.score,
      rank: scoredQuestions > 0 ? me.rank : null,
      correct: s.correct,
      answeredScored: s.answeredScored,
      scoredQuestions,
    };
  };
  return { ranked, podium, standing };
}

export function buildEnded(i: {
  meta: SessionMeta;
  snapshot: QuizSnapshot;
  scoreboard: Scoreboard | null;
  players: PlayerRecord[];
}): { podium: LeaderboardEntry[]; playerMessages: PlayerMessage[] } {
  const { ranked, podium, standing } = endedView(i);
  return {
    podium,
    playerMessages: forEachActive(i.players, ranked, (me) => ({
      type: 'ended',
      sv: i.meta.version,
      podium,
      totalPlayers: ranked.length,
      you: standing(me),
    })),
  };
}

export function buildRoster(
  players: PlayerRecord[],
  connectedPlayerIds: ReadonlySet<string>,
): RosterEntry[] {
  return players
    .filter((p) => !p.kicked)
    .sort((a, b) => a.joinedAt - b.joinedAt || compareCodePoints(a.playerId, b.playerId))
    .map((p) => ({
      playerId: p.playerId,
      nickname: p.nickname,
      connected: connectedPlayerIds.has(p.playerId),
    }));
}

/** Outcome for a player the stored result has no entry for (joined after the question closed). */
function fallbackOutcome(q: Question, s: PlayerScore): PlayerOutcome {
  const outcome: PlayerOutcome = {
    answered: false,
    points: 0,
    streakBonus: 0,
    score: s.score,
    rank: s.lastRank,
    streak: s.streak,
  };
  if (isScoringQuestion(q)) outcome.correct = false;
  return outcome;
}

export function buildPlayerSnapshot(i: {
  meta: SessionMeta;
  snapshot: QuizSnapshot;
  player: PlayerRecord;
  players: PlayerRecord[];
  scoreboard: Scoreboard | null;
  /** This player's, current question. */
  responses: ResponseRecord[];
  /** Current question's, if revealed. */
  result: StoredQuestionResult | null;
}): PlayerSnapshot {
  const { meta, snapshot, player } = i;
  const own = scoreOf(i.scoreboard, player.playerId);
  const out: PlayerSnapshot = {
    sv: meta.version,
    sessionId: meta.sessionId,
    quizTitle: meta.quizTitle,
    phase: meta.phase,
    questionIndex: meta.questionIndex,
    totalQuestions: meta.totalQuestions,
    you: {
      playerId: player.playerId,
      nickname: player.nickname,
      score: own.score,
      rank: own.lastRank,
      streak: own.streak,
    },
  };
  const hasQuestion =
    meta.phase === 'question' || meta.phase === 'revealing' || meta.phase === 'reveal';
  if (hasQuestion) {
    out.responses = [...i.responses]
      .sort((a, b) => a.slot - b.slot)
      .map((r): AnswerPayload => r.payload);
  }
  if ((meta.phase === 'question' || meta.phase === 'revealing') && meta.openAt !== null) {
    out.question = {
      question: toPublicQuestion(currentQuestion(meta, snapshot), snapshot.settings),
      openAt: meta.openAt,
      deadline: meta.deadline,
    };
  }
  if (meta.phase === 'reveal' && i.result !== null) {
    const q = currentQuestion(meta, snapshot);
    out.reveal = {
      result: toPlayerResult(i.result.result, i.result.visibleResponses),
      you: i.result.outcomes[player.playerId] ?? fallbackOutcome(q, own),
      // The answer is public now, and a phone resuming here has not seen the question.
      question: toPublicQuestion(q, snapshot.settings),
    };
  }
  if (meta.phase === 'leaderboard' && i.scoreboard !== null) {
    const ranked = rankPlayers(i.players, i.scoreboard);
    const me = ranked.find((e) => e.playerId === player.playerId);
    if (me !== undefined) {
      out.leaderboard = {
        entries: ranked.slice(0, LIMITS.leaderboardSize),
        you: standingOf(ranked, me),
      };
    }
  }
  if (meta.phase === 'ended') {
    const { ranked, podium, standing } = endedView(i);
    const me = ranked.find((e) => e.playerId === player.playerId);
    if (me !== undefined) {
      out.ended = { podium, totalPlayers: ranked.length, you: standing(me) };
    }
  }
  return out;
}

/**
 * Drops the oldest open-ended responses, whatever their status, until the snapshot fits the
 * `HOST_STATE_MAX_BYTES` budget. The count caps in `openViews` bound the normal case; this
 * shortens the list when a full roster and answers at the length limit would not fit one
 * WebSocket message. Dropped responses are added to `omitted`.
 */
function fitOpenResponses(
  snapshot: HostSnapshot,
  result: Extract<QuestionResult, { type: 'open' }>,
): QuestionResult {
  const { responses } = result;
  const omitted = result.omitted ?? 0;
  const room =
    HOST_STATE_MAX_BYTES -
    jsonBytes({
      ...snapshot,
      result: { ...result, responses: [], omitted: omitted + responses.length },
    });
  let used = 0;
  let first = responses.length;
  while (first > 0) {
    // One byte more than the response for the comma that separates it from the next.
    const size = jsonBytes(responses[first - 1]) + 1;
    if (used + size > room) break;
    used += size;
    first--;
  }
  if (first === 0) return result;
  return { ...result, responses: responses.slice(first), omitted: omitted + first };
}

export function buildHostSnapshot(i: {
  meta: SessionMeta;
  snapshot: QuizSnapshot;
  players: PlayerRecord[];
  connectedPlayerIds: ReadonlySet<string>;
  scoreboard: Scoreboard | null;
  result: StoredQuestionResult | null;
}): HostSnapshot {
  const { meta, snapshot } = i;
  const out: HostSnapshot = {
    sv: meta.version,
    sessionId: meta.sessionId,
    pin: meta.pin,
    quizId: meta.quizId,
    quizTitle: meta.quizTitle,
    settings: snapshot.settings,
    phase: meta.phase,
    questionIndex: meta.questionIndex,
    totalQuestions: meta.totalQuestions,
    locked: meta.locked,
    roster: buildRoster(i.players, i.connectedPlayerIds),
    hasScoredQuestions: meta.hasScoredQuestions,
  };
  const hasQuestion =
    meta.phase === 'question' || meta.phase === 'revealing' || meta.phase === 'reveal';
  if (hasQuestion && meta.openAt !== null) {
    out.question = {
      question: currentQuestion(meta, snapshot),
      openAt: meta.openAt,
      deadline: meta.deadline,
      closedAt: meta.closedAt,
    };
  }
  if (meta.phase === 'reveal' && i.result !== null) {
    out.result = i.result.result;
    if (out.result.type === 'open') out.result = fitOpenResponses(out, out.result);
  }
  if (meta.phase === 'leaderboard' && i.scoreboard !== null) {
    out.leaderboard = rankPlayers(i.players, i.scoreboard).slice(0, HOST_LEADERBOARD_SIZE);
  }
  if (meta.phase === 'ended') out.podium = endedView(i).podium;
  return out;
}

/** `after` cursor: `${receivedAt}:${responseId}`, base64url. Null when it does not decode to that shape. */
function decodeCursor(after: string): { receivedAt: number; id: string } | null {
  const text = base64UrlDecode(after);
  const match = text === null ? null : /^(\d+):(.+)$/s.exec(text);
  return match === null ? null : { receivedAt: Number(match[1]), id: match[2] as string };
}

function pageOpenResponses(
  views: OpenResponseView[],
  after: string | undefined,
): { responses: OpenResponseView[]; cursor: string | null } {
  const from = after === undefined ? null : decodeCursor(after);
  const rest = from === null ? views : views.filter((v) => compareByArrival(v, from) > 0);
  const responses = rest.slice(0, LIMITS.statsResponsesPage);
  const last = responses[responses.length - 1];
  const more = rest.length > responses.length;
  return {
    responses,
    cursor: more && last !== undefined ? base64UrlEncode(`${last.receivedAt}:${last.id}`) : null,
  };
}

/**
 * Same aggregation as the reveal, minus correctness. For open questions `cursor` is non-null
 * only while more responses wait beyond this page; a poller keeps its last non-null cursor
 * and de-duplicates by response id. Pages walk every response, not just the capped set a reveal
 * carries: each message is bounded by the page size, and a capped list would make the older
 * ones unreachable to a poller.
 *
 * `totalPlayers` is every non-kicked player, as in a result. With `connectedPlayerIds` the head
 * also carries `expected`, the players the question is waiting for (see `expectedAnswerers`), so
 * `answered >= expected` is exactly "every connected, non-kicked player has answered", the
 * condition hosts close early on (ADR-0006).
 */
export function computeLiveStats(i: {
  question: Question;
  responses: ResponseRecord[];
  players: PlayerRecord[];
  connectedPlayerIds?: ReadonlySet<string>;
  after?: string;
}): LiveStats {
  const q = i.question;
  const t = tally(i.players, i.responses);
  const head = {
    answered: t.answered,
    totalPlayers: t.totalPlayers,
    ...(i.connectedPlayerIds !== undefined
      ? { expected: expectedAnswerers(i.players, t.answeredIds, i.connectedPlayerIds) }
      : {}),
  };
  switch (q.type) {
    case 'single':
      return { type: 'single', ...head, counts: optionCounts(q, t) };
    case 'truefalse':
      return { type: 'truefalse', ...head, counts: booleanCounts(t) };
    case 'poll':
      return { type: 'poll', ...head, counts: optionCounts(q, t) };
    case 'wordcloud':
      return { type: 'wordcloud', ...head, words: wordCounts(t) };
    case 'open':
      return { type: 'open', ...head, ...pageOpenResponses(allOpenViews(t), i.after) };
    case 'rating':
      return { type: 'rating', ...head, ...ratingStats(q, t) };
  }
}
