import type { Phase } from '@zqhoot/protocol';
import type { PlayerScreen } from './player.ts';

/**
 * ADR-0008: the proactive reconnect that beats API Gateway's 2-hour cutoff belongs between
 * questions. `Connection` asks these before it goes ahead (and again every few seconds, up to a
 * limit), so a phone or a projector is never cut off while a question is being answered.
 */

/**
 * `true` where `screen` is one the player is answering, or about to: an offline moment there
 * costs an answer. Between questions (the lobby, times-up, reveal, leaderboard) it costs nothing.
 */
const HOLDS_PLAYER: Record<PlayerScreen, boolean> = {
  connecting: false,
  lobby: false,
  'get-ready': true,
  answering: true,
  submitted: true,
  'times-up': false,
  reveal: false,
  leaderboard: false,
  ended: false,
  kicked: false,
  'session-over': false,
  'out-of-date': false,
};

export function playerMayReconnect(screen: PlayerScreen): boolean {
  return !HOLDS_PLAYER[screen];
}

/**
 * Hosts hold from the moment the question opens until its results are out. Both the control
 * page and the presenter close the question on the deadline and poll its figures, so a gap in
 * that window shows on the projector. Before the first snapshot there is no game to protect.
 */
const HOLDS_HOST: Record<Phase, boolean> = {
  lobby: false,
  question: true,
  revealing: true,
  reveal: false,
  leaderboard: false,
  ended: false,
};

export function hostMayReconnect(phase: Phase | null): boolean {
  return phase === null || !HOLDS_HOST[phase];
}
