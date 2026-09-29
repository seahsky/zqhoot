/**
 * The quiz the host builds and what each of the five players does with it.
 *
 * Every outcome the suite asserts (who is right, the counts on the projector, the final order)
 * is derived from this one table, so the quiz in the editor, the answers on the phones and the
 * expectations cannot drift apart.
 */

/** Unique per run, so a repeated run on one server never finds the last one's quiz on the dashboard. */
export const quizTitle = (tag: string) => `Live suite quiz ${tag}`;

/** Seconds every timed question runs for. The poll is longer, see `POLL_LIMIT_SEC`. */
export const LIMIT_SEC = 10;
/**
 * The poll is the question during which three accessibility scans run (a phone, the projector
 * and the host). It ends the moment everybody has answered, so the longer limit costs no time;
 * it only keeps a slow scan from closing the question under the players. This is a deliberate
 * deviation from the task spec's 10 s (see the README).
 */
export const POLL_LIMIT_SEC = 60;

export type Slot = 'P1' | 'P2' | 'P3' | 'P4' | 'P5';
export const SLOTS: readonly Slot[] = ['P1', 'P2', 'P3', 'P4', 'P5'];

/**
 * Nicknames are in the order the ranking breaks ties (ADR-0005 shows tied players in nickname
 * order), so a tie between two players of the plan can only ever keep the planned order.
 */
export const NICKNAMES: Record<Slot, string> = {
  P1: 'Alice',
  P2: 'Bobby',
  P3: 'Cleo',
  P4: 'Dara',
  P5: 'Eve',
};

export interface PlayerRig {
  /** Phone or desktop: a viewport, and whether it has a touch screen and a mobile user agent. */
  viewport: { width: number; height: number };
  device?: 'iPhone SE' | 'iPhone 14';
  /** `link`: opens `/join?pin=` as a QR code would. `typed`: types the PIN on `/join`. */
  join: 'link' | 'typed';
}

export const RIGS: Record<Slot, PlayerRig> = {
  P1: { viewport: { width: 320, height: 568 }, device: 'iPhone SE', join: 'link' },
  P2: { viewport: { width: 390, height: 844 }, device: 'iPhone 14', join: 'typed' },
  P3: { viewport: { width: 768, height: 1024 }, join: 'link' },
  P4: { viewport: { width: 1366, height: 768 }, join: 'typed' },
  P5: { viewport: { width: 1920, height: 1080 }, join: 'link' },
};

export type Kind = 'single' | 'truefalse' | 'poll' | 'wordcloud' | 'rating';

export interface SingleQ {
  kind: 'single';
  prompt: string;
  options: readonly string[];
  /** Index into `options`. */
  correct: number;
  /** Points multiplier: 1 standard, 2 double. */
  multiplier: 1 | 2;
}
export interface TrueFalseQ {
  kind: 'truefalse';
  prompt: string;
  correct: boolean;
  multiplier: 1;
}
export interface PollQ {
  kind: 'poll';
  prompt: string;
  options: readonly string[];
}
export interface WordCloudQ {
  kind: 'wordcloud';
  prompt: string;
  maxEntries: number;
}
export interface RatingQ {
  kind: 'rating';
  prompt: string;
  max: number;
  minLabel: string;
  maxLabel: string;
}
export type Q = SingleQ | TrueFalseQ | PollQ | WordCloudQ | RatingQ;

/** No question text below mentions the word the presenter's answer marker is made of. */
export const QUESTIONS: readonly Q[] = [
  {
    kind: 'single',
    prompt: 'Which planet is closest to the Sun?',
    options: ['Venus', 'Earth', 'Mercury', 'Mars'],
    correct: 2,
    multiplier: 1,
  },
  { kind: 'truefalse', prompt: 'The Sun is a planet.', correct: false, multiplier: 1 },
  {
    kind: 'poll',
    prompt: 'Which language do you enjoy most?',
    options: ['TypeScript', 'Rust', 'Python'],
  },
  { kind: 'wordcloud', prompt: 'One word for this quiz?', maxEntries: 2 },
  {
    kind: 'single',
    prompt: 'Which is the largest ocean?',
    options: ['Atlantic', 'Indian', 'Arctic', 'Pacific'],
    correct: 3,
    multiplier: 2,
  },
  {
    kind: 'rating',
    prompt: 'How was this quiz?',
    max: 5,
    minLabel: 'Poor',
    maxLabel: 'Great',
  },
];

export function limitSec(q: Q): number {
  return q.kind === 'poll' ? POLL_LIMIT_SEC : LIMIT_SEC;
}

export function isScored(q: Q): q is SingleQ | TrueFalseQ {
  return q.kind === 'single' || q.kind === 'truefalse';
}

/** What one player does on one question. */
export type Move =
  | { skip: true }
  | { option: number }
  | { bool: boolean }
  | { words: readonly string[] }
  | { rating: number };

/**
 * P1: right every time. P2: wrong on Q2. P3: wrong on Q1 and Q5. P4: skips Q1 and is right on
 * the rest. P5: right every time, but always after P1 (see `DELAY`).
 */
export const MOVES: Record<Slot, readonly Move[]> = {
  P1: [
    { option: 2 },
    { bool: false },
    { option: 0 },
    { words: ['Fun'] },
    { option: 3 },
    { rating: 5 },
  ],
  P2: [
    { option: 2 },
    { bool: true },
    { option: 1 },
    { words: ['Fast'] },
    { option: 3 },
    { rating: 4 },
  ],
  P3: [
    { option: 0 },
    { bool: false },
    { option: 0 },
    { words: ['FUN'] },
    { option: 0 },
    { rating: 3 },
  ],
  P4: [
    { skip: true },
    { bool: false },
    { option: 2 },
    { words: ['Tricky'] },
    { option: 3 },
    { rating: 4 },
  ],
  P5: [
    { option: 2 },
    { bool: false },
    { option: 0 },
    { words: ['Smooth', 'Tense'] },
    { option: 3 },
    { rating: 5 },
  ],
};

/**
 * How long into the question a player waits before answering, in whole seconds, read off the
 * phone's own countdown. P5 waits one second and, besides, only starts once P1's answer has been
 * accepted, so it always answers after P1 and earns at most what P1 did. P4 waits three seconds,
 * which caps its points well below P2's (P2 answers as soon as the options open), so the order
 * of the plan holds by construction and never by a race between two Playwright clicks.
 */
export const DELAY: Record<Slot, number> = { P1: 0, P2: 0, P3: 0, P5: 1, P4: 3 };

/** Whether the move is a right answer. Only meaningful for the scored questions. */
export function isRight(q: Q, move: Move): boolean {
  if ('skip' in move) return false;
  if (q.kind === 'single') return 'option' in move && move.option === q.correct;
  if (q.kind === 'truefalse') return 'bool' in move && move.bool === q.correct;
  return false;
}
