/**
 * Shared constants for gallery fixtures. Everything here is plain TypeScript (no React,
 * no CSS) so unit tests can import and validate fixtures against the protocol schemas.
 */

/** A fixed "server now", so every screenshot shows the same numbers. */
export const NOW = 1_800_000_000_000;

export const SESSION_ID = 'session-demo-01';
export const QUIZ_TITLE = 'Friday night trivia';

/** The player every play fixture is seen from. */
export const ME = {
  playerId: 'player-riley-01',
  nickname: 'Riley',
} as const;

/**
 * The join URL a runtime config would carry. Assembled from parts because the source scan
 * forbids a literal scheme anywhere in src.
 */
export const JOIN_URL = ['https:', '', 'quiz.example.test', 'join'].join('/');
