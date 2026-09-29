import type {
  HostSnapshot,
  LeaderboardEntry,
  OpenResponseView,
  Question,
  QuestionResult,
  RosterEntry,
} from '@zqhoot/protocol';
import { DEFAULT_QUIZ_SETTINGS } from '@zqhoot/protocol';
import { NOW, QUIZ_TITLE, SESSION_ID } from './common.ts';

/**
 * Host-side data for fixtures and tests: full questions (with their answers, as hosts receive
 * them), rosters, and snapshot builders. Plain TypeScript, so unit tests import it too.
 */

export const HOST_PIN = '482915';
export const QUIZ_ID = 'quiz-demo-0001';
export const IMAGE_KEY = 'media/demo-host/planets-01.png';

const base = { timeLimitSec: 20 } as const;

export const singleQ: Extract<Question, { type: 'single' }> = {
  ...base,
  id: 'question-planet',
  type: 'single',
  prompt: 'Which planet is closest to the Sun?',
  points: 1,
  options: [
    { id: 'option-mercury', text: 'Mercury' },
    { id: 'option-venus', text: 'Venus' },
    { id: 'option-earth', text: 'Earth' },
    { id: 'option-mars', text: 'Mars' },
  ],
  correctOptionId: 'option-mercury',
};

export const singleImageQ: Extract<Question, { type: 'single' }> = {
  ...singleQ,
  id: 'question-planet-img',
  prompt: 'Which planet is shown in this picture?',
  imageKey: IMAGE_KEY,
  options: [
    { id: 'option-saturn', text: 'Saturn' },
    { id: 'option-jupiter', text: 'Jupiter' },
    { id: 'option-neptune', text: 'Neptune' },
    { id: 'option-uranus', text: 'Uranus' },
  ],
  correctOptionId: 'option-saturn',
};

/** A 200-character prompt and four 80-character options: the protocol maxima. */
export const singleLongQ: Extract<Question, { type: 'single' }> = {
  ...base,
  timeLimitSec: 30,
  id: 'question-long-host',
  type: 'single',
  prompt:
    'Why did the lighthouse company change its opening hours last spring, after a committee reviewed the visitor numbers from three consecutive summers and also compared them with the neighbouring harbour?',
  points: 1,
  options: [
    {
      id: 'option-long-a',
      text: 'The committee approved the plan only after a third round of very careful review.',
    },
    {
      id: 'option-long-b',
      text: "It shortens the time between a customer's request and the moment we can respond.",
    },
    {
      id: 'option-long-c',
      text: 'Nobody knows for certain, but the oldest records suggest it began beside rivers.',
    },
    {
      id: 'option-long-d',
      text: 'All of the above, although the first two matter far more than the last one does.',
    },
  ],
  correctOptionId: 'option-long-b',
};

export const trueFalseQ: Extract<Question, { type: 'truefalse' }> = {
  ...base,
  timeLimitSec: 10,
  id: 'question-wall',
  type: 'truefalse',
  prompt: 'The Great Wall of China can be seen from the Moon with the naked eye.',
  correct: false,
  points: 1,
};

export const pollQ: Extract<Question, { type: 'poll' }> = {
  ...base,
  id: 'question-lunch',
  type: 'poll',
  prompt: 'Where should we eat lunch?',
  options: [
    { id: 'option-cafe', text: 'The cafe' },
    { id: 'option-park', text: 'Picnic in the park' },
    { id: 'option-deli', text: 'The deli on the corner' },
  ],
};

export const wordCloudQ: Extract<Question, { type: 'wordcloud' }> = {
  ...base,
  timeLimitSec: 45,
  id: 'question-weather',
  type: 'wordcloud',
  prompt: 'Describe this week in one word.',
  maxEntries: 3,
};

export const openQ: Extract<Question, { type: 'open' }> = {
  ...base,
  timeLimitSec: 90,
  id: 'question-offsite',
  type: 'open',
  prompt: 'What should we do at the next team offsite?',
  maxEntries: 2,
  requireApproval: true,
};

export const ratingQ: Extract<Question, { type: 'rating' }> = {
  ...base,
  timeLimitSec: null,
  id: 'question-rating',
  type: 'rating',
  prompt: 'How likely are you to recommend this workshop to a colleague?',
  max: 5,
  minLabel: 'Not at all likely',
  maxLabel: 'Extremely likely',
};

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

const FIRST = [
  'Ana',
  'Jo',
  'Kim',
  'Lee',
  'Riley',
  'Sam',
  'Noor',
  'Mateo',
  'Priya',
  'Tomas',
  'Yuki',
  'Amara',
  'Bjorn',
  'Chloe',
  'Dmitri',
  'Elena',
  'Farid',
  'Grace',
  'Hiro',
  'Ines',
];
const TAIL = ['', 'the Bold', '_99', 'Quizzer', ' K.', 'Fox', '2000', 'Rocket', '', 'Owl'];

/** `n` distinct, deterministic nicknames of 2 to 16 characters, in join order. */
export function names(n: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; out.length < n; i++) {
    const first = FIRST[i % FIRST.length] as string;
    const tail = TAIL[Math.floor(i / FIRST.length) % TAIL.length] as string;
    const round = Math.floor(i / (FIRST.length * TAIL.length));
    const name = `${first}${tail}${round > 0 ? round : ''}`.slice(0, 16);
    // Two empty tails and the truncation above can repeat a name; skip the repeat.
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export function roster(n: number, disconnected: readonly number[] = []): RosterEntry[] {
  return names(n).map((nickname, i) => ({
    playerId: `player-${String(i + 1).padStart(4, '0')}`,
    nickname,
    connected: !disconnected.includes(i),
  }));
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export const HOST_SV = 30;

export function hostSnapshot(over: Partial<HostSnapshot> = {}): HostSnapshot {
  return {
    sv: HOST_SV,
    sessionId: SESSION_ID,
    pin: HOST_PIN,
    quizId: QUIZ_ID,
    quizTitle: QUIZ_TITLE,
    settings: { ...DEFAULT_QUIZ_SETTINGS },
    phase: 'lobby',
    questionIndex: -1,
    totalQuestions: 10,
    locked: false,
    roster: roster(22),
    hasScoredQuestions: true,
    ...over,
  };
}

/**
 * A snapshot for a question `elapsedMs` after its options opened (negative: still in the
 * get-ready count-in), `NOW` being the server time it is stamped with.
 */
export function questionSnapshot(
  question: Question,
  elapsedMs: number,
  over: Partial<HostSnapshot> = {},
  index = 2,
): HostSnapshot {
  const openAt = NOW - elapsedMs;
  const limit = question.timeLimitSec;
  return hostSnapshot({
    phase: 'question',
    questionIndex: index,
    question: {
      question,
      openAt,
      deadline: limit === null ? null : openAt + limit * 1000,
      closedAt: null,
    },
    ...over,
  });
}

export function revealSnapshot(
  question: Question,
  result: QuestionResult,
  over: Partial<HostSnapshot> = {},
  index = 2,
): HostSnapshot {
  const openAt = NOW - 25_000;
  const limit = question.timeLimitSec;
  return hostSnapshot({
    phase: 'reveal',
    questionIndex: index,
    question: {
      question,
      openAt,
      deadline: limit === null ? null : openAt + limit * 1000,
      closedAt: NOW - 4_000,
    },
    result,
    ...over,
  });
}

export const MERCURY_RESULT: QuestionResult = {
  type: 'single',
  answered: 30,
  totalPlayers: 32,
  correctOptionId: 'option-mercury',
  counts: { 'option-mercury': 14, 'option-venus': 9, 'option-earth': 5, 'option-mars': 2 },
};

export const WALL_RESULT: QuestionResult = {
  type: 'truefalse',
  answered: 28,
  totalPlayers: 32,
  correct: false,
  counts: { true: 6, false: 22 },
};

export const LUNCH_RESULT: QuestionResult = {
  type: 'poll',
  answered: 31,
  totalPlayers: 32,
  counts: { 'option-cafe': 12, 'option-park': 15, 'option-deli': 4 },
};

export const WEATHER_WORDS = [
  ['busy', 12],
  ['sunny', 9],
  ['hectic', 7],
  ['productive', 6],
  ['long', 5],
  ['tiring', 4],
  ['fun', 4],
  ['stormy', 3],
  ['fast', 3],
  ['calm', 2],
  ['loud', 2],
  ['slow', 2],
  ['wet', 1],
  ['bright', 1],
  ['crowded', 1],
  ['windy', 1],
  ['quiet', 1],
  ['hopeful', 1],
] as const;

export const WEATHER_RESULT: QuestionResult = {
  type: 'wordcloud',
  answered: 29,
  totalPlayers: 32,
  words: WEATHER_WORDS.map(([text, count]) => ({ text, count })),
};

export const OFFSITE_TEXTS = [
  ['Ana', 'A day on the water, with a picnic and no slides at all.', 'visible'],
  ['Jo', 'Escape room, then dinner together.', 'visible'],
  ['Kim', 'Volunteer at the food bank for a morning.', 'visible'],
  ['Lee', 'Hackathon with a rule: nothing that has to ship.', 'visible'],
  ['Riley', 'A long walk and a proper lunch somewhere with a view.', 'pending'],
  ['Sam', 'Cooking class. Somebody will burn something and it will be great.', 'visible'],
  ['Noor', 'Board games afternoon, teams drawn at random.', 'visible'],
  ['Mateo', 'Karaoke. (Kidding. Mostly.)', 'hidden'],
  ['Priya', 'Visit the old observatory and stay for the evening telescope session.', 'visible'],
  ['Tomas', 'Just a quiet day in a park, no agenda.', 'pending'],
] as const;

export function openResponses(
  rows: ReadonlyArray<readonly [string, string, 'visible' | 'pending' | 'hidden']> = OFFSITE_TEXTS,
): OpenResponseView[] {
  return rows.map(([nickname, text, status], i) => ({
    id: `player-${String(i + 1).padStart(4, '0')}-0`,
    nickname,
    text,
    status,
    receivedAt: NOW - 60_000 + i * 4_000,
  }));
}

export const OFFSITE_RESULT: QuestionResult = {
  type: 'open',
  answered: 10,
  totalPlayers: 32,
  responses: openResponses(),
};

export const RATING_RESULT: QuestionResult = {
  type: 'rating',
  answered: 27,
  totalPlayers: 32,
  histogram: [1, 2, 6, 11, 7],
  average: 3.8,
};

export const LEADERBOARD: LeaderboardEntry[] = [
  { playerId: 'player-0001', nickname: 'Ana', score: 3120, rank: 1, delta: 940 },
  { playerId: 'player-0002', nickname: 'Jo', score: 2870, rank: 2, delta: 870 },
  { playerId: 'player-0003', nickname: 'Kim', score: 2220, rank: 3, delta: 0 },
  { playerId: 'player-0004', nickname: 'Riley', score: 2100, rank: 4, delta: 810 },
  { playerId: 'player-0005', nickname: 'Lee', score: 1990, rank: 5, delta: 0 },
  { playerId: 'player-0006', nickname: 'Sam', score: 1840, rank: 6, delta: 640 },
];

export const PODIUM: LeaderboardEntry[] = [
  { playerId: 'player-0001', nickname: 'Ana', score: 5400, rank: 1, delta: 0 },
  { playerId: 'player-0002', nickname: 'Jo', score: 5010, rank: 2, delta: 0 },
  { playerId: 'player-0004', nickname: 'Riley', score: 4560, rank: 3, delta: 0 },
];
