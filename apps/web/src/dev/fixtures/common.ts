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
