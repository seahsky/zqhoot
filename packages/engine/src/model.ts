/**
 * Server-side domain records. These are persisted by `@zqhoot/store` and never sent to
 * clients as-is: the engine projects them into protocol snapshots and messages.
 * All times are epoch milliseconds on the server clock.
 */
import type {
  AnswerPayload,
  ModerationStatus,
  Phase,
  PlayerOutcome,
  Question,
  QuestionResult,
  QuizSettings,
} from '@zqhoot/protocol';

export type Role = 'player' | 'host';
export type HostClient = 'control' | 'present';

/**
 * The only item written on phase transitions. Written exclusively by host commands and
 * the question timer, guarded by `version` (ADR-0003). Joins and answers never write it.
 */
export interface SessionMeta {
  sessionId: string;
  pin: string;
  hostId: string;
  quizId: string;
  quizTitle: string;
  totalQuestions: number;
  hasScoredQuestions: boolean;
  settings: QuizSettings;
  phase: Phase;
  /** -1 in the lobby. */
  questionIndex: number;
  /** Timing of the current question; null outside question/revealing/reveal. */
  openAt: number | null;
  deadline: number | null;
  closedAt: number | null;
  locked: boolean;
  maxPlayers: number;
  /** Indexes of questions discarded with host.skip. */
  skipped: number[];
  version: number;
  createdAt: number;
  /** Absolute expiry; stores map it to their TTL mechanism. */
  expiresAt: number;
  endedAt: number | null;
}

/** Quiz content frozen when the session starts. Immutable, so safe to cache per process. */
export interface QuizSnapshot {
  quizId: string;
  title: string;
  questions: Question[];
  settings: QuizSettings;
}

export interface PlayerRecord {
  sessionId: string;
  playerId: string;
  /** Sanitised display form. */
  nickname: string;
  /** Folded confusable skeleton; unique per session. */
  nicknameKey: string;
  /** SHA-256 (hex) of the resume token. The token itself is never stored. */
  tokenHash: string;
  joinedAt: number;
  kicked: boolean;
  lastSeenAt: number;
}

export interface ConnectionRecord {
  connectionId: string;
  sessionId: string;
  role: Role;
  /** Set for players. */
  playerId?: string;
  /** Set for hosts. */
  client?: HostClient;
  connectedAt: number;
  expiresAt: number;
}

/**
 * One accepted response. Identity is (sessionId, questionIndex, playerId, slot); the
 * store rejects a second write with the same identity (first write wins).
 */
export interface ResponseRecord {
  sessionId: string;
  questionIndex: number;
  playerId: string;
  /** 0 for single-response types; 0..maxEntries-1 for word cloud and open-ended. */
  slot: number;
  /** `${playerId}-${slot}`; matches the protocol `Id` pattern. */
  responseId: string;
  payload: AnswerPayload;
  /** Normalised word for word clouds; normalised text for open-ended. */
  normalizedText?: string;
  receivedAt: number;
  /** receivedAt - openAt, clamped to [0, limit]; null for untimed questions. */
  elapsedMs: number | null;
  /** Scored types only. */
  correct: boolean | null;
  /** Base points before any streak bonus; 0 for unscored types. */
  points: number;
  status: ModerationStatus;
}

export interface PlayerScore {
  score: number;
  streak: number;
  correct: number;
  answeredScored: number;
  /** Points gained on the most recent scored question (including streak bonus). */
  lastDelta: number;
  lastRank: number | null;
}

/** Written only at reveal, by the single host-command writer. */
export interface Scoreboard {
  sessionId: string;
  version: number;
  /** Highest question index already applied; guards against double scoring. */
  appliedThrough: number;
  players: Record<string, PlayerScore>;
}

export interface StoredQuestionResult {
  sessionId: string;
  questionIndex: number;
  closedAt: number;
  computedAt: number;
  /** Host view (all moderation statuses). */
  result: QuestionResult;
  /**
   * Open-ended questions only: how many responses are visible. `result` lists just the newest
   * ones, so this is the only exact total; players receive it as `omitted`.
   */
  visibleResponses?: number;
  /** Per-player outcome, so a player resuming during reveal gets their own result. */
  outcomes: Record<string, PlayerOutcome>;
}
