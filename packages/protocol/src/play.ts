import { z } from 'zod';
import { EpochMs, Id, MediaKey, Phase, Pin } from './common.ts';
import { LIMITS } from './limits.ts';
import { ChoiceOption, PointsMultiplier, Question, QuizSettings } from './quiz.ts';

// ---------------------------------------------------------------------------
// Question as players see it: never contains the correct answer (ADR-0004).
// ---------------------------------------------------------------------------

const publicBase = {
  id: Id,
  /** Omitted when the quiz hides question text on devices. */
  prompt: z.string().optional(),
  imageKey: MediaKey.optional(),
  timeLimitSec: z.number().int().nullable(),
};

export const PublicQuestion = z.discriminatedUnion('type', [
  z.object({
    ...publicBase,
    type: z.literal('single'),
    options: z.array(ChoiceOption),
    points: PointsMultiplier,
  }),
  z.object({ ...publicBase, type: z.literal('truefalse'), points: PointsMultiplier }),
  z.object({ ...publicBase, type: z.literal('poll'), options: z.array(ChoiceOption) }),
  z.object({ ...publicBase, type: z.literal('wordcloud'), maxEntries: z.number().int() }),
  z.object({ ...publicBase, type: z.literal('open'), maxEntries: z.number().int() }),
  z.object({
    ...publicBase,
    type: z.literal('rating'),
    max: z.number().int(),
    minLabel: z.string().optional(),
    maxLabel: z.string().optional(),
  }),
]);
export type PublicQuestion = z.infer<typeof PublicQuestion>;

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

export const AnswerPayload = z.discriminatedUnion('kind', [
  /** single, poll */
  z.object({ kind: z.literal('choice'), optionId: Id }),
  /** truefalse */
  z.object({ kind: z.literal('boolean'), value: z.boolean() }),
  /** wordcloud (one entry per message), open */
  z.object({ kind: z.literal('text'), text: z.string().min(1).max(LIMITS.openTextMax) }),
  /** rating */
  z.object({ kind: z.literal('rating'), value: z.number().int().min(1).max(LIMITS.ratingMaxMax) }),
]);
export type AnswerPayload = z.infer<typeof AnswerPayload>;

export const AnswerRejectReason = z.enum(['not-open', 'too-early', 'too-late', 'invalid', 'limit']);
export type AnswerRejectReason = z.infer<typeof AnswerRejectReason>;

export const ModerationStatus = z.enum(['visible', 'pending', 'hidden']);
export type ModerationStatus = z.infer<typeof ModerationStatus>;

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

const resultCounts = {
  /** Players who submitted at least one accepted response. */
  answered: z.number().int(),
  /** Non-kicked players in the session when the question closed. */
  totalPlayers: z.number().int(),
};

export const WordCount = z.object({ text: z.string(), count: z.number().int() });
export type WordCount = z.infer<typeof WordCount>;

export const OpenResponseView = z.object({
  id: Id,
  text: z.string(),
  status: ModerationStatus,
  /** Present only in host views. */
  nickname: z.string().optional(),
  receivedAt: EpochMs,
});
export type OpenResponseView = z.infer<typeof OpenResponseView>;

/**
 * Outcome of a closed question. Hosts receive open-ended responses of every status, bounded;
 * players receive none (only the count of visible ones in `omitted`), because responses are
 * anonymous and phones do not render them.
 */
export const QuestionResult = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('single'),
    ...resultCounts,
    correctOptionId: Id,
    counts: z.record(z.string(), z.number().int()),
  }),
  z.object({
    type: z.literal('truefalse'),
    ...resultCounts,
    correct: z.boolean(),
    counts: z.object({ true: z.number().int(), false: z.number().int() }),
  }),
  z.object({
    type: z.literal('poll'),
    ...resultCounts,
    counts: z.record(z.string(), z.number().int()),
  }),
  z.object({ type: z.literal('wordcloud'), ...resultCounts, words: z.array(WordCount) }),
  z.object({
    type: z.literal('open'),
    ...resultCounts,
    /**
     * Host views hold the newest `LIMITS.openRevealMax` visible responses and a bounded number
     * of pending/hidden ones, oldest first; player views hold none. The list in a `host.state`
     * snapshot can be shorter still (the oldest responses of any status are dropped so the
     * message fits one WebSocket frame), so a host cannot assume the moderation queue is
     * complete there; it can page through `host.stats` for the rest.
     */
    responses: z.array(OpenResponseView),
    /**
     * Responses not included in `responses`. For players, the count of visible responses.
     * Absent means none.
     */
    omitted: z.number().int().min(0).optional(),
  }),
  z.object({
    type: z.literal('rating'),
    ...resultCounts,
    /** histogram[i] = number of ratings equal to i + 1 */
    histogram: z.array(z.number().int()),
    average: z.number().nullable(),
  }),
]);
export type QuestionResult = z.infer<typeof QuestionResult>;

/** Live view for hosts while a question is open. Same shape as a result, no correct answer. */
export const LiveStats = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('single'),
    ...resultCounts,
    counts: z.record(z.string(), z.number().int()),
  }),
  z.object({
    type: z.literal('truefalse'),
    ...resultCounts,
    counts: z.object({ true: z.number().int(), false: z.number().int() }),
  }),
  z.object({
    type: z.literal('poll'),
    ...resultCounts,
    counts: z.record(z.string(), z.number().int()),
  }),
  z.object({ type: z.literal('wordcloud'), ...resultCounts, words: z.array(WordCount) }),
  z.object({
    type: z.literal('open'),
    ...resultCounts,
    /** Responses received after the request's cursor, oldest first, at most one page. */
    responses: z.array(OpenResponseView),
    /** Pass back as `after` to fetch the next page. */
    cursor: z.string().nullable(),
  }),
  z.object({
    type: z.literal('rating'),
    ...resultCounts,
    histogram: z.array(z.number().int()),
    average: z.number().nullable(),
  }),
]);
export type LiveStats = z.infer<typeof LiveStats>;

// ---------------------------------------------------------------------------
// Players, leaderboard, outcomes
// ---------------------------------------------------------------------------

export const RosterEntry = z.object({
  playerId: Id,
  nickname: z.string(),
  connected: z.boolean(),
});
export type RosterEntry = z.infer<typeof RosterEntry>;

export const LeaderboardEntry = z.object({
  playerId: Id,
  nickname: z.string(),
  score: z.number().int(),
  /** Competition ranking: ties share a rank, the next rank skips (1, 2, 2, 4). */
  rank: z.number().int().min(1),
  /** Points gained on the most recent scored question. */
  delta: z.number().int(),
});
export type LeaderboardEntry = z.infer<typeof LeaderboardEntry>;

/** A player's own result for one question. */
export const PlayerOutcome = z.object({
  answered: z.boolean(),
  /** Present for scored questions only. */
  correct: z.boolean().optional(),
  points: z.number().int(),
  streakBonus: z.number().int(),
  score: z.number().int(),
  rank: z.number().int().nullable(),
  streak: z.number().int(),
});
export type PlayerOutcome = z.infer<typeof PlayerOutcome>;

export const PlayerStanding = z.object({
  score: z.number().int(),
  rank: z.number().int().nullable(),
  /** Nearest player ranked above, if any. */
  behind: z.object({ nickname: z.string(), points: z.number().int() }).optional(),
});
export type PlayerStanding = z.infer<typeof PlayerStanding>;

export const FinalStanding = z.object({
  score: z.number().int(),
  rank: z.number().int().nullable(),
  correct: z.number().int(),
  answeredScored: z.number().int(),
  scoredQuestions: z.number().int(),
});
export type FinalStanding = z.infer<typeof FinalStanding>;

export const OpenQuestionTiming = z.object({
  /** Server time at which options become answerable. */
  openAt: EpochMs,
  /** Server time after which answers are late. Null for untimed questions. */
  deadline: EpochMs.nullable(),
});
export type OpenQuestionTiming = z.infer<typeof OpenQuestionTiming>;

// ---------------------------------------------------------------------------
// Snapshots (sent on join/resume/host hello and to hosts after every transition)
// ---------------------------------------------------------------------------

export const PlayerSnapshot = z.object({
  /** Session state version; clients ignore state messages with a lower `sv`. */
  sv: z.number().int(),
  sessionId: Id,
  quizTitle: z.string(),
  phase: Phase,
  questionIndex: z.number().int(),
  totalQuestions: z.number().int(),
  you: z.object({
    playerId: Id,
    nickname: z.string(),
    score: z.number().int(),
    rank: z.number().int().nullable(),
    streak: z.number().int(),
  }),
  /** Present in phases question and revealing. */
  question: z.object({ question: PublicQuestion, ...OpenQuestionTiming.shape }).optional(),
  /** What this player has already submitted for the current question. */
  responses: z.array(AnswerPayload).optional(),
  /** Present in phase reveal. */
  reveal: z
    .object({
      result: QuestionResult,
      you: PlayerOutcome,
      /** The question just closed, so a player resuming here can show what was asked and the answer. */
      question: PublicQuestion.optional(),
    })
    .optional(),
  /** Present in phase leaderboard. */
  leaderboard: z.object({ entries: z.array(LeaderboardEntry), you: PlayerStanding }).optional(),
  /** Present in phase ended. */
  ended: z
    .object({
      podium: z.array(LeaderboardEntry),
      totalPlayers: z.number().int(),
      you: FinalStanding,
    })
    .optional(),
});
export type PlayerSnapshot = z.infer<typeof PlayerSnapshot>;

export const HostSnapshot = z.object({
  sv: z.number().int(),
  sessionId: Id,
  pin: Pin,
  quizId: Id,
  quizTitle: z.string(),
  settings: QuizSettings,
  phase: Phase,
  questionIndex: z.number().int(),
  totalQuestions: z.number().int(),
  locked: z.boolean(),
  roster: z.array(RosterEntry),
  /** Full question including the answer; hosts are trusted. Present in question/revealing/reveal. */
  question: z
    .object({ question: Question, ...OpenQuestionTiming.shape, closedAt: EpochMs.nullable() })
    .optional(),
  /** Present in phase reveal. */
  result: QuestionResult.optional(),
  /** Present in phase leaderboard. */
  leaderboard: z.array(LeaderboardEntry).optional(),
  /** Present in phase ended. */
  podium: z.array(LeaderboardEntry).optional(),
  /** Whether any question in the quiz is scored (controls leaderboard/podium display). */
  hasScoredQuestions: z.boolean(),
});
export type HostSnapshot = z.infer<typeof HostSnapshot>;
