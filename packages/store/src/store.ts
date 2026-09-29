/**
 * Storage contract shared by the DynamoDB and in-memory implementations.
 * Both must pass the same contract test suite (see ADR-0003 for the DynamoDB key design).
 *
 * Consistency rules every implementation must honour:
 * - Reads of SessionMeta, Scoreboard, responses and players are strongly consistent.
 * - Conditional operations are atomic.
 * - Records past `expiresAt` must not be returned (DynamoDB TTL deletes lazily).
 */
import type {
  ConnectionRecord,
  PlayerRecord,
  QuizSnapshot,
  ResponseRecord,
  Scoreboard,
  SessionMeta,
  StoredQuestionResult,
} from '@zqhoot/engine';
import type { ModerationStatus, Quiz, QuizSummary, SessionSummary } from '@zqhoot/protocol';

/** Thrown when an optimistic-concurrency check fails. Callers re-read and re-decide. */
export class ConflictError extends Error {
  constructor(message = 'version conflict') {
    super(message);
    this.name = 'ConflictError';
  }
}

export type PutResponseResult = { created: true } | { created: false; existing: ResponseRecord };

export type AddPlayerResult = 'ok' | 'nickname-taken' | 'session-full';

export interface Store {
  // --- Quizzes (durable, no expiry) -------------------------------------------------
  listQuizzes(ownerId: string): Promise<QuizSummary[]>;
  getQuiz(ownerId: string, quizId: string): Promise<Quiz | null>;
  /**
   * Create when `expectedVersion` is undefined (fails with ConflictError if the id exists).
   * Otherwise replace only if the stored version equals `expectedVersion`.
   * The caller sets `quiz.version` to the new value.
   */
  putQuiz(quiz: Quiz, expectedVersion?: number): Promise<void>;
  deleteQuiz(ownerId: string, quizId: string): Promise<void>;

  // --- Sessions --------------------------------------------------------------------
  /** Atomically claim a PIN for a session. False if another live session holds it. */
  reservePin(pin: string, sessionId: string, expiresAt: number): Promise<boolean>;
  /** Delete the PIN claim if it is held by `sessionId`; no-op otherwise. */
  releasePin(pin: string, sessionId: string): Promise<void>;
  getSessionIdByPin(pin: string): Promise<string | null>;
  /** Writes meta and the immutable snapshot. Fails with ConflictError if the session exists. */
  createSession(meta: SessionMeta, snapshot: QuizSnapshot): Promise<void>;
  getSession(sessionId: string): Promise<SessionMeta | null>;
  /** Replace meta only if the stored version equals `expectedVersion`; else ConflictError. */
  updateSession(meta: SessionMeta, expectedVersion: number): Promise<void>;
  getSnapshot(sessionId: string): Promise<QuizSnapshot | null>;
  /** Newest first. */
  listSessionsByHost(hostId: string, limit: number): Promise<SessionSummary[]>;

  // --- Players ---------------------------------------------------------------------
  /**
   * Atomically inserts the player and reserves `player.nicknameKey` within the session.
   * A taken nickname gives `'nickname-taken'`; an existing `playerId` throws ConflictError.
   *
   * With `maxPlayers` the admission itself is conditional: however many calls run at once, at
   * most `maxPlayers` of them get `'ok'` and the rest `'session-full'`, which is decided before
   * the nickname is looked at. A seat is held while its join is in flight and given back when it
   * is refused, or fails in a way that proves nothing was written (throttled, invalid). An error
   * that does not, such as a timeout or a 5xx, keeps it. So a refusal that overlaps other joins
   * near the cap may say `'session-full'` where it would otherwise say `'nickname-taken'`. Kicked players occupy a seat like any other. A session
   * must be filled with `maxPlayers` on every call or on none: an uncapped insert is not counted
   * toward the cap of later capped ones in `DynamoStore`. Players of one session are expected to
   * share one expiry (the session's); the cap counts seats, so an earlier-expiring player would
   * keep its seat there.
   */
  addPlayer(player: PlayerRecord, expiresAt: number, maxPlayers?: number): Promise<AddPlayerResult>;
  getPlayer(sessionId: string, playerId: string): Promise<PlayerRecord | null>;
  /** Throws NotFoundError if the player does not exist. */
  updatePlayer(
    sessionId: string,
    playerId: string,
    patch: Partial<Pick<PlayerRecord, 'kicked' | 'lastSeenAt'>>,
  ): Promise<void>;
  /** Includes kicked players; callers filter. */
  listPlayers(sessionId: string): Promise<PlayerRecord[]>;
  countPlayers(sessionId: string): Promise<number>;

  // --- Connections -----------------------------------------------------------------
  putConnection(conn: ConnectionRecord): Promise<void>;
  getConnection(connectionId: string): Promise<ConnectionRecord | null>;
  /** Idempotent. */
  deleteConnection(connectionId: string): Promise<void>;
  listConnections(sessionId: string): Promise<ConnectionRecord[]>;

  // --- Responses -------------------------------------------------------------------
  /** First write wins for a given (session, question, player, slot). */
  putResponse(response: ResponseRecord, expiresAt: number): Promise<PutResponseResult>;
  listResponses(sessionId: string, questionIndex: number): Promise<ResponseRecord[]>;
  listPlayerResponses(
    sessionId: string,
    questionIndex: number,
    playerId: string,
  ): Promise<ResponseRecord[]>;
  /**
   * `responseId` is `{playerId}-{slot}`, split on the last `-`. Throws NotFoundError when no
   * such response exists.
   */
  setResponseStatus(
    sessionId: string,
    questionIndex: number,
    responseId: string,
    status: ModerationStatus,
  ): Promise<void>;

  // --- Results ---------------------------------------------------------------------
  putQuestionResult(result: StoredQuestionResult, expiresAt: number): Promise<void>;
  getQuestionResult(sessionId: string, questionIndex: number): Promise<StoredQuestionResult | null>;
  listQuestionResults(sessionId: string): Promise<StoredQuestionResult[]>;
  getScoreboard(sessionId: string): Promise<Scoreboard | null>;
  /**
   * Create when `expectedVersion` is undefined (ConflictError if one exists), else
   * replace only if the stored version equals `expectedVersion`.
   */
  putScoreboard(
    scoreboard: Scoreboard,
    expectedVersion: number | undefined,
    expiresAt: number,
  ): Promise<void>;

  // --- Rate limiting ---------------------------------------------------------------
  /**
   * Fixed-window counter. Increments the counter for `key` in the window containing
   * `now` and returns true while the count is within `limit`.
   */
  hitRateLimit(key: string, limit: number, windowMs: number, now: number): Promise<boolean>;
  /**
   * Read-only companion to `hitRateLimit`: true while the current window's count for `key` is
   * within `limit`. Does not increment. A missing or expired window counts as 0.
   */
  peekRateLimit(key: string, limit: number, windowMs: number, now: number): Promise<boolean>;
}
