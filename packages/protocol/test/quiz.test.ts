import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUIZ_SETTINGS,
  LIMITS,
  Question,
  Quiz,
  QuizInput,
  QuizSettings,
  SCORED_TYPES,
  TIME_LIMITS_SEC,
  isScoredType,
} from '../src/index.ts';
import { settings } from './fixtures.ts';

const opt = (id: string, text = id) => ({ id, text });
const options = (n: number) =>
  Array.from({ length: n }, (_, i) => opt(`option-${i}`, `Option ${i}`));

const single = (over: Record<string, unknown> = {}) => ({
  id: 'q-single',
  type: 'single',
  prompt: 'Pick one',
  timeLimitSec: 20,
  options: options(3),
  correctOptionId: 'option-1',
  points: 1,
  ...over,
});
const truefalse = (over: Record<string, unknown> = {}) => ({
  id: 'q-truefalse',
  type: 'truefalse',
  prompt: 'True?',
  timeLimitSec: 10,
  correct: true,
  points: 2,
  ...over,
});
const poll = (over: Record<string, unknown> = {}) => ({
  id: 'q-poll',
  type: 'poll',
  prompt: 'Vote',
  timeLimitSec: null,
  options: options(3),
  ...over,
});
const wordcloud = (over: Record<string, unknown> = {}) => ({
  id: 'q-wordcloud',
  type: 'wordcloud',
  prompt: 'One word',
  timeLimitSec: 30,
  maxEntries: 3,
  ...over,
});
const open = (over: Record<string, unknown> = {}) => ({
  id: 'q-open',
  type: 'open',
  prompt: 'Thoughts?',
  timeLimitSec: 60,
  maxEntries: 2,
  requireApproval: true,
  ...over,
});
const rating = (over: Record<string, unknown> = {}) => ({
  id: 'q-rating',
  type: 'rating',
  prompt: 'Rate it',
  timeLimitSec: 15,
  max: 5,
  ...over,
});

const ok = (schema: { safeParse(v: unknown): { success: boolean } }, v: unknown) =>
  schema.safeParse(v).success;
const quiz = (questions: unknown[], over: Record<string, unknown> = {}) => ({
  title: 'A quiz',
  questions,
  settings,
  ...over,
});

describe('Question: one valid sample per type', () => {
  it.each([
    ['single', single()],
    ['truefalse', truefalse()],
    ['poll', poll()],
    ['wordcloud', wordcloud()],
    ['open', open()],
    ['rating', rating({ minLabel: 'Bad', maxLabel: 'Great' })],
  ])('%s', (_type, q) => {
    expect(ok(Question, q)).toBe(true);
  });

  it('rejects an unknown type and a missing type', () => {
    expect(ok(Question, { ...single(), type: 'ranking' })).toBe(false);
    expect(ok(Question, { id: 'q-single', prompt: 'x', timeLimitSec: null })).toBe(false);
  });

  it('rejects fields of another type standing in for required ones', () => {
    expect(ok(Question, single({ correctOptionId: undefined }))).toBe(false);
    expect(ok(Question, truefalse({ correct: 'yes' }))).toBe(false);
    expect(ok(Question, open({ requireApproval: undefined }))).toBe(false);
  });
});

describe('QuizInput refinements', () => {
  it('accepts a valid quiz with every question type', () => {
    const q = quiz([single(), truefalse(), poll(), wordcloud(), open(), rating()]);
    expect(QuizInput.safeParse(q).success).toBe(true);
  });

  it('rejects duplicate question ids', () => {
    const result = QuizInput.safeParse(quiz([single(), truefalse({ id: 'q-single' })]));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('duplicate question id');
  });

  it('rejects duplicate option ids in single and poll questions', () => {
    const dup = [opt('option-a'), opt('option-a', 'again')];
    const s = QuizInput.safeParse(quiz([single({ options: dup, correctOptionId: 'option-a' })]));
    expect(s.success).toBe(false);
    expect(s.error?.issues.map((i) => i.message)).toContain('duplicate option id');
    expect(ok(QuizInput, quiz([poll({ options: dup })]))).toBe(false);
  });

  it('rejects a single-choice question whose correct option does not exist', () => {
    const result = QuizInput.safeParse(quiz([single({ correctOptionId: 'option-zzz' })]));
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.message)).toContain(
      'correctOptionId must match an option',
    );
    expect(ok(QuizInput, quiz([single({ correctOptionId: 'short' })]))).toBe(false);
  });

  it('bounds the number of options: 2-4 for single, 2-6 for poll', () => {
    for (const n of [0, 1, 5])
      expect(ok(QuizInput, quiz([single({ options: options(n) })])), `single ${n}`).toBe(false);
    for (const n of [2, 3, 4])
      expect(ok(QuizInput, quiz([single({ options: options(n) })])), `single ${n}`).toBe(true);
    for (const n of [0, 1, 7])
      expect(ok(QuizInput, quiz([poll({ options: options(n) })])), `poll ${n}`).toBe(false);
    for (const n of [2, 5, 6])
      expect(ok(QuizInput, quiz([poll({ options: options(n) })])), `poll ${n}`).toBe(true);
  });

  it.each([
    [5, true],
    [10, true],
    [15, true],
    [20, true],
    [30, true],
    [45, true],
    [60, true],
    [90, true],
    [120, true],
    [180, true],
    [240, true],
    [null, true],
    [0, false],
    [1, false],
    [7, false],
    [25, false],
    [241, false],
    [300, false],
    [-5, false],
    [5.5, false],
    ['20', false],
    [Number.NaN, false],
  ])('time limit %j is valid: %s', (timeLimitSec, valid) => {
    expect(ok(QuizInput, quiz([single({ timeLimitSec })]))).toBe(valid);
  });

  it('accepts exactly the documented time limits', () => {
    expect([...TIME_LIMITS_SEC]).toEqual([5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240]);
    for (const t of TIME_LIMITS_SEC)
      expect(ok(QuizInput, quiz([poll({ timeLimitSec: t })]))).toBe(true);
  });

  it('requires at least one question and at most 100', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => poll({ id: `poll-${i}-x` }));
    expect(ok(QuizInput, quiz([]))).toBe(false);
    expect(ok(QuizInput, quiz(many(1)))).toBe(true);
    expect(ok(QuizInput, quiz(many(LIMITS.questionsMax)))).toBe(true);
    expect(ok(QuizInput, quiz(many(LIMITS.questionsMax + 1)))).toBe(false);
  });

  it('requires a title and settings', () => {
    expect(ok(QuizInput, { questions: [poll()], settings })).toBe(false);
    expect(ok(QuizInput, { title: 'x', questions: [poll()] })).toBe(false);
    expect(ok(QuizInput, quiz([poll()], { title: '   ' }))).toBe(false);
  });
});

describe('limits at their exact boundaries', () => {
  const text = (n: number) => 'a'.repeat(n);

  it('quiz title: 1-120 characters after trimming', () => {
    expect(ok(QuizInput, quiz([poll()], { title: text(LIMITS.quizTitleMax) }))).toBe(true);
    expect(ok(QuizInput, quiz([poll()], { title: text(LIMITS.quizTitleMax + 1) }))).toBe(false);
    expect(ok(QuizInput, quiz([poll()], { title: `  ${text(LIMITS.quizTitleMax)}  ` }))).toBe(true);
    expect(ok(QuizInput, quiz([poll()], { title: 'x' }))).toBe(true);
    expect(ok(QuizInput, quiz([poll()], { title: '' }))).toBe(false);
  });

  it('question prompt: 1-200 characters after trimming', () => {
    expect(ok(Question, poll({ prompt: text(LIMITS.questionPromptMax) }))).toBe(true);
    expect(ok(Question, poll({ prompt: text(LIMITS.questionPromptMax + 1) }))).toBe(false);
    expect(ok(Question, poll({ prompt: '' }))).toBe(false);
    expect(ok(Question, poll({ prompt: '   ' }))).toBe(false);
    expect(Question.parse(poll({ prompt: '  padded  ' })).prompt).toBe('padded');
  });

  it('option text: 1-80 characters', () => {
    const withText = (t: string) => poll({ options: [opt('option-a', t), opt('option-b')] });
    expect(ok(Question, withText(text(LIMITS.optionTextMax)))).toBe(true);
    expect(ok(Question, withText(text(LIMITS.optionTextMax + 1)))).toBe(false);
    expect(ok(Question, withText(''))).toBe(false);
  });

  it('ids: 6-32 characters from [A-Za-z0-9_-]', () => {
    const withId = (id: string) => poll({ id });
    expect(ok(Question, withId('abcde'))).toBe(false);
    expect(ok(Question, withId('abcdef'))).toBe(true);
    expect(ok(Question, withId('a'.repeat(32)))).toBe(true);
    expect(ok(Question, withId('a'.repeat(33)))).toBe(false);
    expect(ok(Question, withId('abc def'))).toBe(false);
    expect(ok(Question, withId('abc.def'))).toBe(false);
    expect(ok(Question, withId('Ab_-09'))).toBe(true);
  });

  it('word cloud entries: 1-5', () => {
    for (const [n, valid] of [
      [0, false],
      [1, true],
      [5, true],
      [6, false],
      [1.5, false],
    ] as const) {
      expect(ok(Question, wordcloud({ maxEntries: n })), `wordcloud ${n}`).toBe(valid);
    }
  });

  it('open-ended entries: 1-3', () => {
    for (const [n, valid] of [
      [0, false],
      [1, true],
      [3, true],
      [4, false],
    ] as const) {
      expect(ok(Question, open({ maxEntries: n })), `open ${n}`).toBe(valid);
    }
  });

  it('rating scale: 3-10 with labels up to 40 characters', () => {
    for (const [n, valid] of [
      [2, false],
      [3, true],
      [10, true],
      [11, false],
      [4.5, false],
    ] as const) {
      expect(ok(Question, rating({ max: n })), `rating ${n}`).toBe(valid);
    }
    expect(ok(Question, rating({ minLabel: text(LIMITS.ratingLabelMax) }))).toBe(true);
    expect(ok(Question, rating({ minLabel: text(LIMITS.ratingLabelMax + 1) }))).toBe(false);
    expect(ok(Question, rating({ maxLabel: text(LIMITS.ratingLabelMax + 1) }))).toBe(false);
    expect(ok(Question, rating({ minLabel: '' }))).toBe(true);
  });

  it('points multiplier: 0, 1 or 2', () => {
    for (const [n, valid] of [
      [0, true],
      [1, true],
      [2, true],
      [3, false],
      [-1, false],
      [1.5, false],
    ] as const) {
      expect(ok(Question, single({ points: n })), `single ${n}`).toBe(valid);
      expect(ok(Question, truefalse({ points: n })), `truefalse ${n}`).toBe(valid);
    }
  });

  it('read seconds: 0-10', () => {
    for (const [n, valid] of [
      [0, true],
      [10, true],
      [-1, false],
      [11, false],
      [2.5, false],
    ] as const) {
      expect(ok(QuizSettings, { ...settings, readSeconds: n }), `readSeconds ${n}`).toBe(valid);
    }
    expect(ok(QuizSettings, { ...settings, streakBonus: 'yes' })).toBe(false);
    expect(ok(QuizSettings, { streakBonus: false, readSeconds: 3 })).toBe(false);
  });

  it('image keys: media/<owner>/<id>.<png|jpg|webp|gif> only', () => {
    const withImage = (imageKey: string) => poll({ imageKey });
    expect(ok(Question, withImage('media/owner-1/abcdef.png'))).toBe(true);
    expect(ok(Question, withImage('media/owner-1/abcdef.webp'))).toBe(true);
    expect(ok(Question, withImage('media/owner-1/abcdef.svg'))).toBe(false);
    expect(ok(Question, withImage('media/owner-1/abcdef.PNG'))).toBe(false);
    expect(ok(Question, withImage('media/../abcdef.png'))).toBe(false);
    expect(ok(Question, withImage('https://evil.example/a.png'))).toBe(false);
    expect(ok(Question, withImage('media/owner-1/abc.png'))).toBe(false);
  });

  it('exposes the numbers the product documents', () => {
    expect(LIMITS).toMatchObject({
      pinLength: 6,
      nicknameMinGraphemes: 2,
      nicknameMaxGraphemes: 16,
      nicknameRawMaxLength: 64,
      wordMaxLength: 25,
      wordEntriesMax: 5,
      openTextMax: 200,
      openEntriesMax: 3,
      maxPlayersDefault: 500,
      clientMessageMaxBytes: 4096,
      leaderboardSize: 5,
      podiumSize: 3,
      wordCloudTopN: 60,
      statsResponsesPage: 100,
      openRevealMax: 100,
    });
  });
});

describe('Quiz (stored form)', () => {
  const stored = (over: Record<string, unknown> = {}) => ({
    id: 'quiz-0001',
    ownerId: 'local:admin',
    title: 'A quiz',
    questions: [poll()],
    settings,
    version: 0,
    createdAt: 1,
    updatedAt: 2,
    ...over,
  });

  it('accepts a stored quiz', () => {
    expect(ok(Quiz, stored())).toBe(true);
  });

  it.each([
    ['negative version', { version: -1 }],
    ['fractional version', { version: 1.5 }],
    ['empty owner', { ownerId: '' }],
    ['owner over 128 characters', { ownerId: 'o'.repeat(129) }],
    ['bad id', { id: 'x' }],
    ['no questions', { questions: [] }],
  ])('rejects %s', (_name, over) => {
    expect(ok(Quiz, stored(over))).toBe(false);
  });

  it('accepts a 128-character owner id', () => {
    expect(ok(Quiz, stored({ ownerId: 'o'.repeat(128) }))).toBe(true);
  });
});

describe('scored types and defaults', () => {
  it('only single and truefalse are scored', () => {
    expect([...SCORED_TYPES]).toEqual(['single', 'truefalse']);
    for (const t of ['single', 'truefalse'] as const) expect(isScoredType(t)).toBe(true);
    for (const t of ['poll', 'wordcloud', 'open', 'rating'] as const)
      expect(isScoredType(t)).toBe(false);
  });

  it('defaults are valid settings with the streak bonus off', () => {
    expect(QuizSettings.safeParse(DEFAULT_QUIZ_SETTINGS).success).toBe(true);
    expect(DEFAULT_QUIZ_SETTINGS.streakBonus).toBe(false);
  });
});
