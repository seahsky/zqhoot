import { z } from 'zod';
import { Id, MediaKey } from './common.ts';
import { LIMITS, TIME_LIMITS_SEC } from './limits.ts';

const Text = (max: number) => z.string().trim().min(1).max(max);

export const TimeLimitSec = z
  .number()
  .int()
  .refine((v) => (TIME_LIMITS_SEC as readonly number[]).includes(v), 'unsupported time limit')
  .nullable();

/** 0 = no points, 1 = standard, 2 = double. */
export const PointsMultiplier = z.union([z.literal(0), z.literal(1), z.literal(2)]);
export type PointsMultiplier = z.infer<typeof PointsMultiplier>;

export const ChoiceOption = z.object({
  id: Id,
  text: Text(LIMITS.optionTextMax),
});
export type ChoiceOption = z.infer<typeof ChoiceOption>;

const base = {
  id: Id,
  prompt: Text(LIMITS.questionPromptMax),
  imageKey: MediaKey.optional(),
  timeLimitSec: TimeLimitSec,
};

const uniqueOptionIds = (opts: ChoiceOption[]) =>
  new Set(opts.map((o) => o.id)).size === opts.length;

export const SingleChoiceQuestion = z
  .object({
    ...base,
    type: z.literal('single'),
    options: z.array(ChoiceOption).min(LIMITS.choiceOptionsMin).max(LIMITS.choiceOptionsMax),
    correctOptionId: Id,
    points: PointsMultiplier,
  })
  .refine((q) => uniqueOptionIds(q.options), { message: 'duplicate option id', path: ['options'] })
  .refine((q) => q.options.some((o) => o.id === q.correctOptionId), {
    message: 'correctOptionId must match an option',
    path: ['correctOptionId'],
  });

export const TrueFalseQuestion = z.object({
  ...base,
  type: z.literal('truefalse'),
  correct: z.boolean(),
  points: PointsMultiplier,
});

export const PollQuestion = z
  .object({
    ...base,
    type: z.literal('poll'),
    options: z.array(ChoiceOption).min(LIMITS.choiceOptionsMin).max(LIMITS.pollOptionsMax),
  })
  .refine((q) => uniqueOptionIds(q.options), { message: 'duplicate option id', path: ['options'] });

export const WordCloudQuestion = z.object({
  ...base,
  type: z.literal('wordcloud'),
  maxEntries: z.number().int().min(1).max(LIMITS.wordEntriesMax),
});

export const OpenQuestion = z.object({
  ...base,
  type: z.literal('open'),
  maxEntries: z.number().int().min(1).max(LIMITS.openEntriesMax),
  /** When true, responses stay hidden from the presenter until the host approves them. */
  requireApproval: z.boolean(),
});

export const RatingQuestion = z.object({
  ...base,
  type: z.literal('rating'),
  /** Scale runs from 1 to `max`. */
  max: z.number().int().min(LIMITS.ratingMaxMin).max(LIMITS.ratingMaxMax),
  minLabel: z.string().trim().max(LIMITS.ratingLabelMax).optional(),
  maxLabel: z.string().trim().max(LIMITS.ratingLabelMax).optional(),
});

export const Question = z.discriminatedUnion('type', [
  SingleChoiceQuestion,
  TrueFalseQuestion,
  PollQuestion,
  WordCloudQuestion,
  OpenQuestion,
  RatingQuestion,
]);
export type Question = z.infer<typeof Question>;
export type QuestionType = Question['type'];
export type SingleChoiceQuestion = z.infer<typeof SingleChoiceQuestion>;
export type TrueFalseQuestion = z.infer<typeof TrueFalseQuestion>;
export type PollQuestion = z.infer<typeof PollQuestion>;
export type WordCloudQuestion = z.infer<typeof WordCloudQuestion>;
export type OpenQuestion = z.infer<typeof OpenQuestion>;
export type RatingQuestion = z.infer<typeof RatingQuestion>;

/** Question types that award points. */
export const SCORED_TYPES = ['single', 'truefalse'] as const satisfies readonly QuestionType[];
export const isScoredType = (t: QuestionType): t is (typeof SCORED_TYPES)[number] =>
  (SCORED_TYPES as readonly string[]).includes(t);

export const QuizSettings = z.object({
  /** Extra points for consecutive correct answers. Off by default (see ADR-0005). */
  streakBonus: z.boolean(),
  /** Show question text on phones. When false, phones show answer options only. */
  showQuestionOnDevices: z.boolean(),
  /** Seconds the question is shown before options open. The server may enforce a higher floor. */
  readSeconds: z.number().int().min(0).max(LIMITS.readSecondsMax),
});
export type QuizSettings = z.infer<typeof QuizSettings>;

export const DEFAULT_QUIZ_SETTINGS: QuizSettings = {
  streakBonus: false,
  showQuestionOnDevices: true,
  readSeconds: 3,
};

/** Body of create/update requests. Server assigns ownership, version and timestamps. */
export const QuizInput = z
  .object({
    title: Text(LIMITS.quizTitleMax),
    questions: z.array(Question).min(1).max(LIMITS.questionsMax),
    settings: QuizSettings,
  })
  .refine((q) => new Set(q.questions.map((x) => x.id)).size === q.questions.length, {
    message: 'duplicate question id',
    path: ['questions'],
  });
export type QuizInput = z.infer<typeof QuizInput>;

export const Quiz = z.object({
  id: Id,
  ownerId: z.string().min(1).max(128),
  title: Text(LIMITS.quizTitleMax),
  questions: z.array(Question).min(1).max(LIMITS.questionsMax),
  settings: QuizSettings,
  /** Incremented on every write; used for optimistic concurrency. */
  version: z.number().int().nonnegative(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Quiz = z.infer<typeof Quiz>;

export const QuizSummary = z.object({
  id: Id,
  title: z.string(),
  questionCount: z.number().int(),
  updatedAt: z.number().int(),
  version: z.number().int(),
});
export type QuizSummary = z.infer<typeof QuizSummary>;
