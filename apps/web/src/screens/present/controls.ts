import type { HostSnapshot } from '@zqhoot/protocol';
import { nextAction } from '../../state/commands.ts';

/** The parts of the control bar that follow the game, as opposed to the presenter's own settings. */
export interface BarState {
  /** Label of the big advance action ("Start", "End question", ...), or null when there is none. */
  nextLabel: string | null;
  /** A question is open, so the host may end it now. */
  canClose: boolean;
  /** Joining can still be locked: not once the game has ended. */
  canLock: boolean;
  locked: boolean;
}

/**
 * What the host's control bar offers for a snapshot. The real page and the gallery fixtures
 * both ask this, so a fixture shows what a host would see. Once the game has ended there is
 * nothing to advance to and nobody left to lock out, so both buttons go away.
 */
export function barStateFor(snap: HostSnapshot | null): BarState {
  const next = snap ? nextAction(snap) : null;
  return {
    nextLabel: next?.command ? next.label : null,
    canClose: snap?.phase === 'question',
    canLock: snap?.phase !== 'ended',
    locked: snap?.locked ?? false,
  };
}
