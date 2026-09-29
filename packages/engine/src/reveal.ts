import type { OutboundMessage, PlayerOutcome, Question, QuestionResult } from '@zqhoot/protocol';
import {
  booleanCounts,
  openViews,
  optionCounts,
  ratingStats,
  tally,
  wordCounts,
} from './aggregate.ts';
import type { Tally } from './aggregate.ts';
import type {
  PlayerRecord,
  PlayerScore,
  ResponseRecord,
  Scoreboard,
  SessionMeta,
  StoredQuestionResult,
  QuizSnapshot,
} from './model.ts';
import { isScoringQuestion, pointsMultiplier } from './questions.ts';
import { EMPTY_SCORE, rankEntries, streakBonus } from './scoring.ts';

export interface PlayerMessage {
  playerId: string;
  message: OutboundMessage;
}

export interface RevealOutput {
  /** Phase 'reveal', version + 1. */
  meta: SessionMeta;
  /** Host-view result plus per-player outcomes. */
  stored: StoredQuestionResult;
  /** `appliedThrough` = questionIndex. */
  scoreboard: Scoreboard;
  hostResult: QuestionResult;
  /** One 'reveal' per non-kicked player. */
  playerMessages: PlayerMessage[];
}

function buildResult(q: Question, t: Tally): QuestionResult {
  const head = { answered: t.answered, totalPlayers: t.totalPlayers };
  switch (q.type) {
    case 'single':
      return {
        type: 'single',
        ...head,
        correctOptionId: q.correctOptionId,
        counts: optionCounts(q, t),
      };
    case 'truefalse':
      return { type: 'truefalse', ...head, correct: q.correct, counts: booleanCounts(t) };
    case 'poll':
      return { type: 'poll', ...head, counts: optionCounts(q, t) };
    case 'wordcloud':
      return { type: 'wordcloud', ...head, words: wordCounts(t) };
    case 'open':
      return { type: 'open', ...head, responses: openViews(t) };
    case 'rating':
      return { type: 'rating', ...head, ...ratingStats(q, t) };
  }
}

/** Open-ended: only moderated-visible entries and no nicknames. Everything else is already public. */
export function toPlayerResult(result: QuestionResult): QuestionResult {
  if (result.type !== 'open') return result;
  return {
    ...result,
    responses: result.responses
      .filter((r) => r.status === 'visible')
      .map(({ nickname: _nickname, ...rest }) => rest),
  };
}

function revealMessages(
  version: number,
  questionIndex: number,
  hostResult: QuestionResult,
  outcomes: Record<string, PlayerOutcome>,
  players: PlayerRecord[],
): PlayerMessage[] {
  const result = toPlayerResult(hostResult);
  const messages: PlayerMessage[] = [];
  for (const p of players) {
    const you = outcomes[p.playerId];
    if (p.kicked || you === undefined) continue;
    messages.push({
      playerId: p.playerId,
      message: { type: 'reveal', sv: version, index: questionIndex, result, you },
    });
  }
  return messages;
}

/**
 * Preconditions are service bugs, not user errors, so they throw: the phase must be
 * 'revealing' and the scoreboard must not already include this question (a retried reveal
 * would otherwise score twice).
 */
export function computeReveal(i: {
  meta: SessionMeta;
  snapshot: QuizSnapshot;
  responses: ResponseRecord[];
  players: PlayerRecord[];
  scoreboard: Scoreboard | null;
  now: number;
}): RevealOutput {
  const { meta, snapshot, players } = i;
  const qi = meta.questionIndex;
  if (meta.phase !== 'revealing') {
    throw new Error(`computeReveal: phase is '${meta.phase}', expected 'revealing'`);
  }
  if (i.scoreboard !== null && i.scoreboard.appliedThrough >= qi) {
    throw new Error(
      `computeReveal: question ${qi} already applied (appliedThrough ${i.scoreboard.appliedThrough})`,
    );
  }
  const q = snapshot.questions[qi];
  if (q === undefined) throw new Error(`computeReveal: no question at index ${qi}`);

  const t = tally(
    players,
    i.responses.filter((r) => r.questionIndex === qi),
  );
  const hostResult = buildResult(q, t);

  const active = players.filter((p) => !p.kicked);
  const scoring = isScoringQuestion(q);
  const multiplier = pointsMultiplier(q);
  const prior = i.scoreboard?.players ?? {};
  const next: Record<string, PlayerScore> = {};
  for (const [id, s] of Object.entries(prior)) next[id] = { ...s };

  // Slot 0 is the only response of a scored question.
  const firstResponse = new Map<string, ResponseRecord>();
  for (const r of t.responses) {
    const seen = firstResponse.get(r.playerId);
    if (seen === undefined || r.slot < seen.slot) firstResponse.set(r.playerId, r);
  }

  const awarded = new Map<string, { base: number; bonus: number; correct: boolean }>();
  if (scoring) {
    for (const p of active) {
      const s = (next[p.playerId] ??= { ...EMPTY_SCORE });
      const r = firstResponse.get(p.playerId);
      const correct = r?.correct === true;
      const streak = correct ? s.streak + 1 : 0;
      const base = correct && r !== undefined ? r.points : 0;
      const bonus = correct
        ? streakBonus({ streak, multiplier, enabled: snapshot.settings.streakBonus })
        : 0;
      s.streak = streak;
      s.score += base + bonus;
      s.lastDelta = base + bonus;
      s.answeredScored += r === undefined ? 0 : 1;
      s.correct += correct ? 1 : 0;
      awarded.set(p.playerId, { base, bonus, correct });
    }
    const ranked = rankEntries(
      active.map((p) => ({
        playerId: p.playerId,
        nickname: p.nickname,
        score: (next[p.playerId] as PlayerScore).score,
      })),
    );
    for (const e of ranked) (next[e.playerId] as PlayerScore).lastRank = e.rank;
  }

  const outcomes: Record<string, PlayerOutcome> = {};
  for (const p of active) {
    const s = next[p.playerId] ?? EMPTY_SCORE;
    const won = awarded.get(p.playerId);
    const outcome: PlayerOutcome = {
      answered: t.answeredIds.has(p.playerId),
      points: won?.base ?? 0,
      streakBonus: won?.bonus ?? 0,
      score: s.score,
      rank: s.lastRank,
      streak: s.streak,
    };
    if (won !== undefined) outcome.correct = won.correct;
    outcomes[p.playerId] = outcome;
  }

  const newMeta: SessionMeta = { ...meta, phase: 'reveal', version: meta.version + 1 };
  return {
    meta: newMeta,
    stored: {
      sessionId: meta.sessionId,
      questionIndex: qi,
      closedAt: meta.closedAt ?? i.now,
      computedAt: i.now,
      result: hostResult,
      outcomes,
    },
    scoreboard: {
      sessionId: meta.sessionId,
      version: (i.scoreboard?.version ?? 0) + 1,
      appliedThrough: qi,
      players: next,
    },
    hostResult,
    playerMessages: revealMessages(newMeta.version, qi, hostResult, outcomes, players),
  };
}

/** Reveal already computed and stored (retry after a crash): rebuild the meta transition and messages. */
export function revealFromStored(i: {
  meta: SessionMeta;
  stored: StoredQuestionResult;
  players: PlayerRecord[];
}): {
  meta: SessionMeta;
  hostResult: QuestionResult;
  playerMessages: PlayerMessage[];
} {
  const { meta, stored } = i;
  if (meta.phase !== 'revealing' || stored.questionIndex !== meta.questionIndex) {
    throw new Error(
      `revealFromStored: stored result ${stored.questionIndex} does not match '${meta.phase}' ${meta.questionIndex}`,
    );
  }
  const newMeta: SessionMeta = { ...meta, phase: 'reveal', version: meta.version + 1 };
  return {
    meta: newMeta,
    hostResult: stored.result,
    playerMessages: revealMessages(
      newMeta.version,
      stored.questionIndex,
      stored.result,
      stored.outcomes,
      i.players,
    ),
  };
}
