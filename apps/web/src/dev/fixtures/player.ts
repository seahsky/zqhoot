import type {
  AnswerPayload,
  PlayerOutcome,
  PlayerSnapshot,
  PublicQuestion,
  QuestionResult,
  ServerMessage,
} from '@zqhoot/protocol';
import type { ConnectionStatus } from '../../net/connection.ts';
import { initialPlayerState, playerReducer } from '../../state/player.ts';
import type { PlayerState } from '../../state/player.ts';
import { ME, NOW, QUIZ_TITLE, SESSION_ID } from './common.ts';
import * as Q from './questions.ts';

/**
 * Player-screen fixtures are built by feeding real protocol messages through the real
 * reducer, so a fixture can never show a state the app cannot reach. Every message sent is
 * recorded in `FIXTURE_MESSAGES` for test/fixtures.test.ts to validate against the schemas.
 */
export const FIXTURE_MESSAGES: ServerMessage[] = [];

const SV = 20;
/** The player mid-game: every fixture that is not the lobby is seen from here. */
const you = { ...ME, score: 1240, rank: 4, streak: 0 };
/** Nothing is scored before the first question, so the lobby has no points and no rank. */
const inLobby = { ...ME, score: 0, rank: null, streak: 0 };

function snapshot(over: Partial<PlayerSnapshot>): PlayerSnapshot {
  return {
    sv: SV,
    sessionId: SESSION_ID,
    quizTitle: QUIZ_TITLE,
    phase: 'lobby',
    questionIndex: -1,
    totalQuestions: 10,
    you,
    ...over,
  };
}

function send(state: PlayerState, msg: ServerMessage): PlayerState {
  FIXTURE_MESSAGES.push(msg);
  return playerReducer(state, { type: 'message', msg });
}

function welcome(snap: PlayerSnapshot, connection: ConnectionStatus = 'open'): PlayerState {
  return send(initialPlayerState(connection), {
    type: 'welcome',
    ts: NOW,
    role: 'player',
    snapshot: snap,
  });
}

/**
 * A question phase snapshot taken `elapsedMs` after the options opened (negative: still
 * in the get-ready count-in). `NOW` is the server time the snapshot is stamped with.
 */
function questionSnapshot(
  question: PublicQuestion,
  elapsedMs: number,
  responses?: AnswerPayload[],
  index = 2,
): PlayerSnapshot {
  const openAt = NOW - elapsedMs;
  const limit = question.timeLimitSec;
  return snapshot({
    phase: 'question',
    questionIndex: index,
    question: { question, openAt, deadline: limit === null ? null : openAt + limit * 1000 },
    ...(responses ? { responses } : {}),
  });
}

/** A reveal that arrives after the question, so the reducer still knows the question. */
function revealed(
  question: PublicQuestion,
  result: QuestionResult,
  outcome: PlayerOutcome,
): PlayerState {
  const s = welcome(questionSnapshot(question, 12_000));
  return send(s, { type: 'reveal', ts: NOW + 10_000, sv: SV + 1, index: 2, result, you: outcome });
}

const counts = { answered: 18, totalPlayers: 22 };

const mercuryResult: QuestionResult = {
  type: 'single',
  ...counts,
  correctOptionId: 'option-mercury',
  counts: { 'option-mercury': 11, 'option-venus': 4, 'option-earth': 2, 'option-mars': 1 },
};

const pollResult: QuestionResult = {
  type: 'poll',
  answered: 20,
  totalPlayers: 22,
  counts: { 'option-cafe': 12, 'option-park': 8 },
};

const leaderboardEntries = [
  { playerId: 'player-ana-001', nickname: 'Ana', score: 3120, rank: 1, delta: 940 },
  { playerId: 'player-jo-0001', nickname: 'Jo', score: 2870, rank: 2, delta: 870 },
  { playerId: 'player-kim-001', nickname: 'Kim', score: 2220, rank: 3, delta: 0 },
  { ...ME, score: 2100, rank: 4, delta: 810 },
  { playerId: 'player-lee-001', nickname: 'Lee', score: 1990, rank: 5, delta: 0 },
];

const listening = questionSnapshot(Q.singleShort, 6_500);

export const PLAY_FIXTURES = {
  'play-lobby': welcome(snapshot({ you: inLobby })),
  'play-get-ready': welcome(questionSnapshot(Q.singleShort, -3_000)),
  'play-answer-single': welcome(listening),
  'play-answer-single-long': welcome(questionSnapshot(Q.singleLong, 9_000)),
  'play-answer-truefalse': welcome(questionSnapshot(Q.trueFalse, 4_000)),
  'play-answer-poll-6': welcome(questionSnapshot(Q.poll6, 7_000)),
  'play-answer-wordcloud': welcome(questionSnapshot(Q.wordCloud, 12_000)),
  'play-answer-open': welcome(questionSnapshot(Q.openEnded, 20_000)),
  'play-answer-rating': welcome(questionSnapshot(Q.rating, 5_000)),
  'play-submitted': welcome(
    questionSnapshot(Q.singleShort, 6_500, [{ kind: 'choice', optionId: 'option-mercury' }]),
  ),
  'play-times-up': welcome(questionSnapshot(Q.singleShort, 20_600)),
  'play-reveal-correct': revealed(Q.singleShort, mercuryResult, {
    answered: true,
    correct: true,
    points: 870,
    streakBonus: 0,
    score: 2340,
    rank: 2,
    streak: 3,
  }),
  'play-reveal-incorrect': revealed(Q.singleShort, mercuryResult, {
    answered: true,
    correct: false,
    points: 0,
    streakBonus: 0,
    score: 1240,
    rank: 6,
    streak: 0,
  }),
  'play-reveal-unscored': revealed(Q.pollShort, pollResult, {
    answered: true,
    points: 0,
    streakBonus: 0,
    score: 1240,
    rank: 4,
    streak: 0,
  }),
  'play-reveal-no-answer': revealed(Q.singleShort, mercuryResult, {
    answered: false,
    correct: false,
    points: 0,
    streakBonus: 0,
    score: 1240,
    rank: 9,
    streak: 0,
  }),
  'play-leaderboard': welcome(
    snapshot({
      phase: 'leaderboard',
      questionIndex: 2,
      you: { ...you, score: 2100, rank: 4 },
      leaderboard: {
        entries: leaderboardEntries,
        you: { score: 2100, rank: 4, behind: { nickname: 'Kim', points: 120 } },
      },
    }),
  ),
  'play-ended': welcome(
    snapshot({
      phase: 'ended',
      questionIndex: 9,
      you: { ...you, score: 4560, rank: 3 },
      ended: {
        podium: [
          { playerId: 'player-ana-001', nickname: 'Ana', score: 5400, rank: 1, delta: 0 },
          { playerId: 'player-jo-0001', nickname: 'Jo', score: 5010, rank: 2, delta: 0 },
          { ...ME, score: 4560, rank: 3, delta: 0 },
        ],
        totalPlayers: 22,
        you: { score: 4560, rank: 3, correct: 7, answeredScored: 9, scoredQuestions: 10 },
      },
    }),
  ),
  'play-reconnecting': welcome(listening, 'reconnecting'),
  // These can strike at any time; a question in progress keeps the score of a game under way.
  'play-kicked': send(welcome(listening), { type: 'kicked', ts: NOW + 1_000 }),
  'play-session-over': send(welcome(listening), {
    type: 'error',
    ts: NOW + 1_000,
    code: 'session-ended',
    message: 'The host ended the game.',
  }),
  'play-out-of-date': send(welcome(listening), {
    type: 'error',
    ts: NOW + 1_000,
    code: 'protocol-version',
    message: 'This server needs protocol version 2.',
  }),
} satisfies Record<string, PlayerState>;

export type PlayFixtureId = keyof typeof PLAY_FIXTURES;
