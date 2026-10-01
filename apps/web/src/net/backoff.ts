export interface BackoffOptions {
  baseMs: number;
  capMs: number;
}

/**
 * Full-jitter delay (ADR-0008): uniform in [0, min(capMs, baseMs * 2^attempt)).
 * `attempt` is zero-based. Full jitter, rather than a fixed step plus noise, is what
 * spreads a whole class of phones that lost the same connection at the same instant.
 */
export function fullJitterDelay(
  attempt: number,
  { baseMs, capMs }: BackoffOptions,
  random: () => number = Math.random,
): number {
  const exp = Math.min(Math.max(0, Math.floor(attempt)), 30);
  const ceiling = Math.min(capMs, baseMs * 2 ** exp);
  return Math.floor(random() * ceiling);
}
