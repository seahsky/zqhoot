export interface EngineConfig {
  /** `TIMING.minLeadMs.lambda` or `.node`. */
  minLeadMs: number;
  /** `TIMING.answerGraceMs`. */
  answerGraceMs: number;
  /** Lifetime of session records; `expiresAt = createdAt + sessionTtlMs`. */
  sessionTtlMs: number;
}

/** 30 days: the CSV export window (ARCHITECTURE choice 5). */
export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
