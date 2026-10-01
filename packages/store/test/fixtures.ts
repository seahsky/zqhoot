import type {
  ConnectionRecord,
  PlayerRecord,
  QuizSnapshot,
  ResponseRecord,
  Scoreboard,
  SessionMeta,
  StoredQuestionResult,
} from '@zqhoot/engine';
import type { Question, Quiz, QuizSettings } from '@zqhoot/protocol';

export interface TestClock {
  now: () => number;
  set(ms: number): void;
}

/**
 * Far in the future so that DynamoDB Local's own TTL sweeper never deletes test items, and a
 * multiple of 1000 so that second-granular DynamoDB expiry matches millisecond expiry exactly.
 */
export const CLOCK_START = 4_102_444_800_000;
export const DAY_MS = 86_400_000;

export function createClock(start = CLOCK_START): TestClock {
  let current = start;
  return {
    now: () => current,
    set(ms: number) {
      current = ms;
    },
  };
}

const RUN = Math.random().toString(36).slice(2, 8);
let counter = 0;
/** IDs are unique per process run, so tests can share one DynamoDB table. */
export const uid = (prefix: string): string => `${prefix}-${RUN}-${++counter}`;

export const settings: QuizSettings = {
  streakBonus: true,
  showQuestionOnDevices: false,
  readSeconds: 5,
};

/** One question of every type, with optional fields both present and absent. */
export function allQuestions(): Question[] {
  return [
    {
      id: 'q-single',
      type: 'single',
      prompt: 'Capital of France?',
      imageKey: 'media/owner1/image1.png',
      timeLimitSec: 20,
      options: [
        { id: 'opt-paris', text: 'Paris' },
        { id: 'opt-rome', text: 'Rome' },
      ],
      correctOptionId: 'opt-paris',
      points: 2,
    },
    {
      id: 'q-tf',
      type: 'truefalse',
      prompt: 'The sky is green.',
      timeLimitSec: null,
      correct: false,
      points: 1,
    },
    {
      id: 'q-poll',
      type: 'poll',
      prompt: 'Favourite colour?',
      timeLimitSec: 30,
      options: [
        { id: 'opt-red', text: 'Red' },
        { id: 'opt-blue', text: 'Blue' },
        { id: 'opt-green', text: 'Green' },
      ],
    },
    { id: 'q-cloud', type: 'wordcloud', prompt: 'One word', timeLimitSec: 45, maxEntries: 3 },
    {
      id: 'q-open',
      type: 'open',
      prompt: 'Any thoughts?',
      imageKey: 'media/owner1/image2.webp',
      timeLimitSec: null,
      maxEntries: 2,
      requireApproval: true,
    },
    {
      id: 'q-rating',
      type: 'rating',
      prompt: 'Rate the talk',
      timeLimitSec: 60,
      max: 5,
      minLabel: 'Poor',
      maxLabel: 'Great',
    },
    { id: 'q-rating2', type: 'rating', prompt: 'Rate again', timeLimitSec: 60, max: 10 },
  ];
}

export function makeQuiz(ownerId: string, over: Partial<Quiz> = {}): Quiz {
  return {
    id: uid('quiz'),
    ownerId,
    title: 'Friday quiz',
    questions: allQuestions(),
    settings,
    version: 0,
    createdAt: CLOCK_START,
    updatedAt: CLOCK_START,
    ...over,
  };
}

export function makeSnapshot(quizId = uid('quiz')): QuizSnapshot {
  return { quizId, title: 'Friday quiz', questions: allQuestions(), settings };
}

/** A fully populated session (timings set). Pass `over` to change any field. */
export function makeMeta(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: uid('sess'),
    pin: uid('pin'),
    hostId: uid('host'),
    quizId: uid('quiz'),
    quizTitle: 'Friday quiz',
    totalQuestions: 7,
    hasScoredQuestions: true,
    settings,
    phase: 'question',
    questionIndex: 2,
    openAt: CLOCK_START + 1_000,
    deadline: CLOCK_START + 21_000,
    closedAt: null,
    locked: true,
    maxPlayers: 500,
    skipped: [1, 4],
    version: 3,
    createdAt: CLOCK_START,
    // Not a whole second: expiresAt round-trips in milliseconds even though DynamoDB stores seconds.
    expiresAt: CLOCK_START + 30 * DAY_MS + 123,
    endedAt: null,
    ...over,
  };
}

export function makePlayer(sessionId: string, over: Partial<PlayerRecord> = {}): PlayerRecord {
  const playerId = over.playerId ?? uid('pl');
  return {
    sessionId,
    playerId,
    nickname: 'Alice',
    nicknameKey: uid('nick'),
    tokenHash: 'ab'.repeat(32),
    joinedAt: CLOCK_START + 5,
    kicked: false,
    lastSeenAt: CLOCK_START + 10,
    ...over,
  };
}

export function makeConnection(
  sessionId: string,
  over: Partial<ConnectionRecord> = {},
): ConnectionRecord {
  return {
    connectionId: uid('conn'),
    sessionId,
    role: 'player',
    playerId: uid('pl'),
    connectedAt: CLOCK_START + 7,
    expiresAt: CLOCK_START + 3 * 3_600_000,
    ...over,
  };
}

export function makeResponse(
  sessionId: string,
  questionIndex: number,
  playerId: string,
  over: Partial<ResponseRecord> = {},
): ResponseRecord {
  const slot = over.slot ?? 0;
  return {
    sessionId,
    questionIndex,
    playerId,
    slot,
    responseId: `${playerId}-${slot}`,
    payload: { kind: 'choice', optionId: 'opt-paris' },
    receivedAt: CLOCK_START + 2_000,
    elapsedMs: 1_000,
    correct: true,
    points: 900,
    status: 'visible',
    ...over,
  };
}

export function makeScoreboard(sessionId: string, version = 0): Scoreboard {
  return {
    sessionId,
    version,
    appliedThrough: 2,
    players: {
      'player-one': {
        score: 2_700,
        streak: 3,
        correct: 3,
        answeredScored: 3,
        lastDelta: 1_000,
        lastRank: 1,
      },
      'player-two': {
        score: 900,
        streak: 0,
        correct: 1,
        answeredScored: 3,
        lastDelta: 0,
        lastRank: null,
      },
    },
  };
}

const counts = { answered: 3, totalPlayers: 4 };

/** One stored result for each `QuestionResult` variant, indexed 0..5. */
export function allResults(sessionId: string): StoredQuestionResult[] {
  const base = { sessionId, closedAt: CLOCK_START + 30_000, computedAt: CLOCK_START + 31_000 };
  const outcomes = {
    'player-one': {
      answered: true,
      correct: true,
      points: 900,
      streakBonus: 100,
      score: 1_000,
      rank: 1,
      streak: 2,
    },
    'player-two': { answered: false, points: 0, streakBonus: 0, score: 0, rank: null, streak: 0 },
  };
  return [
    {
      ...base,
      questionIndex: 0,
      result: {
        type: 'single',
        ...counts,
        correctOptionId: 'opt-paris',
        counts: { 'opt-paris': 2, 'opt-rome': 1 },
      },
      outcomes,
    },
    {
      ...base,
      questionIndex: 1,
      result: { type: 'truefalse', ...counts, correct: false, counts: { true: 1, false: 2 } },
      outcomes,
    },
    {
      ...base,
      questionIndex: 2,
      result: { type: 'poll', ...counts, counts: { 'opt-red': 3 } },
      outcomes: {},
    },
    {
      ...base,
      questionIndex: 3,
      result: {
        type: 'wordcloud',
        ...counts,
        words: [
          { text: 'hello', count: 2 },
          { text: 'wörld', count: 1 },
        ],
      },
      outcomes,
    },
    {
      ...base,
      questionIndex: 4,
      result: {
        type: 'open',
        ...counts,
        responses: [
          {
            id: 'player-one-0',
            text: 'Nice',
            status: 'visible',
            nickname: 'Alice',
            receivedAt: CLOCK_START + 1,
          },
          { id: 'player-two-0', text: 'Meh', status: 'pending', receivedAt: CLOCK_START + 2 },
        ],
      },
      outcomes,
    },
    {
      ...base,
      questionIndex: 5,
      result: {
        type: 'rating',
        ...counts,
        histogram: [0, 1, 0, 1, 1],
        average: 3.6666666666666665,
      },
      outcomes,
    },
    {
      ...base,
      questionIndex: 6,
      result: { type: 'rating', answered: 0, totalPlayers: 4, histogram: [0, 0, 0], average: null },
      outcomes: {},
    },
  ];
}
