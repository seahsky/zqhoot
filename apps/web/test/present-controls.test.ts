import type { HostSnapshot } from '@zqhoot/protocol';
import { describe, expect, it } from 'vitest';
import {
  LUNCH_RESULT,
  MERCURY_RESULT,
  hostSnapshot,
  pollQ,
  questionSnapshot,
  revealSnapshot,
  singleQ,
} from '../src/dev/fixtures/hostSnapshots.ts';
import { PRESENT_FIXTURES } from '../src/dev/fixtures/present.ts';
import { barStateFor } from '../src/screens/present/controls.ts';
import { nextAction } from '../src/state/commands.ts';

describe('what the presenter control bar offers', () => {
  it('a lobby starts the game and may lock joining', () => {
    expect(barStateFor(hostSnapshot())).toEqual({
      nextLabel: 'Start',
      canClose: false,
      canLock: true,
      locked: false,
    });
  });

  it('an open question is ended by the primary button, and joining can still be locked', () => {
    expect(barStateFor(questionSnapshot(singleQ, 5_000))).toMatchObject({
      nextLabel: 'End question',
      canClose: true,
      canLock: true,
    });
  });

  it('results lead to the leaderboard for a scored question, or to the next question', () => {
    expect(barStateFor(revealSnapshot(singleQ, MERCURY_RESULT)).nextLabel).toBe('Leaderboard');
    expect(barStateFor(revealSnapshot(pollQ, LUNCH_RESULT)).nextLabel).toBe('Next question');
  });

  it('the last question finishes the game', () => {
    const last = hostSnapshot({ phase: 'leaderboard', questionIndex: 9 });
    expect(barStateFor(last).nextLabel).toBe('Finish');
  });

  it('once the game has ended there is nothing to advance to and nothing to lock', () => {
    for (const snap of [
      hostSnapshot({ phase: 'ended', questionIndex: 9 }),
      hostSnapshot({ phase: 'ended', questionIndex: 4, totalQuestions: 5 }),
    ]) {
      expect(barStateFor(snap)).toEqual({
        nextLabel: null,
        canClose: false,
        canLock: false,
        locked: false,
      });
    }
  });

  it('follows the lock, and before the first snapshot offers nothing to advance', () => {
    expect(barStateFor(hostSnapshot({ locked: true })).locked).toBe(true);
    expect(barStateFor(null)).toEqual({
      nextLabel: null,
      canClose: false,
      canLock: true,
      locked: false,
    });
  });

  it('the primary label is the one the real page sends with its command', () => {
    const phases = ['lobby', 'question', 'revealing', 'reveal', 'leaderboard', 'ended'] as const;
    for (const phase of phases) {
      const snap: HostSnapshot = hostSnapshot({ phase, questionIndex: phase === 'lobby' ? -1 : 2 });
      const next = nextAction(snap);
      expect(barStateFor(snap).nextLabel, phase).toBe(next.command ? next.label : null);
    }
  });

  it('every gallery fixture asks the same function, so the ended screens hide both buttons', () => {
    for (const id of ['present-podium', 'present-ended-unscored'] as const) {
      const state = barStateFor(PRESENT_FIXTURES[id].state.snapshot);
      expect(state.nextLabel, id).toBeNull();
      expect(state.canLock, id).toBe(false);
    }
    expect(barStateFor(PRESENT_FIXTURES['present-lobby'].state.snapshot).nextLabel).toBe('Start');
  });
});
