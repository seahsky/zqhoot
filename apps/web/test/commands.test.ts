import { describe, expect, it } from 'vitest';
import { HostNextMsg } from '@zqhoot/protocol';
import type { HostSnapshot } from '@zqhoot/protocol';
import {
  LEADERBOARD,
  MERCURY_RESULT,
  PODIUM,
  hostSnapshot,
  openQ,
  pollQ,
  questionSnapshot,
  revealSnapshot,
  singleQ,
  trueFalseQ,
  LUNCH_RESULT,
} from '../src/dev/fixtures/hostSnapshots.ts';
import {
  closeCommand,
  endCommand,
  isLastQuestion,
  kickCommand,
  lockCommand,
  moderateCommand,
  nextAction,
  skipCommand,
} from '../src/state/commands.ts';

const revealing = (over: Partial<HostSnapshot> = {}) =>
  questionSnapshot(singleQ, 25_000, { phase: 'revealing', ...over });

describe('the Next button, phase by phase', () => {
  it('lobby: Start, guarded by the lobby and question -1', () => {
    const a = nextAction(hostSnapshot());
    expect(a.label).toBe('Start');
    expect(a.command).toEqual({ type: 'host.next', from: { phase: 'lobby', questionIndex: -1 } });
  });

  it('question: End question, guarded by that question', () => {
    const a = nextAction(questionSnapshot(singleQ, 5_000, {}, 4));
    expect(a.label).toBe('End question');
    expect(a.command?.from).toEqual({ phase: 'question', questionIndex: 4 });
  });

  it('revealing: Show results', () => {
    const a = nextAction(revealing());
    expect(a.label).toBe('Show results');
    expect(a.command?.from).toEqual({ phase: 'revealing', questionIndex: 2 });
  });

  it('reveal of a scored question: Leaderboard', () => {
    const a = nextAction(revealSnapshot(singleQ, MERCURY_RESULT));
    expect(a.label).toBe('Leaderboard');
    expect(a.command?.from).toEqual({ phase: 'reveal', questionIndex: 2 });
    expect(nextAction(revealSnapshot(trueFalseQ, MERCURY_RESULT)).label).toBe('Leaderboard');
  });

  it('reveal of a question that awards no points skips the leaderboard', () => {
    expect(nextAction(revealSnapshot(pollQ, LUNCH_RESULT)).label).toBe('Next question');
    expect(nextAction(revealSnapshot({ ...singleQ, points: 0 }, MERCURY_RESULT)).label).toBe(
      'Next question',
    );
    expect(nextAction(revealSnapshot(openQ, MERCURY_RESULT)).label).toBe('Next question');
  });

  it('leaderboard: Next question', () => {
    const a = nextAction(
      hostSnapshot({ phase: 'leaderboard', questionIndex: 2, leaderboard: LEADERBOARD }),
    );
    expect(a.label).toBe('Next question');
    expect(a.command?.from).toEqual({ phase: 'leaderboard', questionIndex: 2 });
  });

  it('the last question says Finish instead, from the reveal or the leaderboard', () => {
    const last = { questionIndex: 9, totalQuestions: 10 };
    expect(isLastQuestion(hostSnapshot(last))).toBe(true);
    expect(isLastQuestion(hostSnapshot({ questionIndex: 8, totalQuestions: 10 }))).toBe(false);
    expect(
      nextAction(hostSnapshot({ phase: 'leaderboard', leaderboard: LEADERBOARD, ...last })).label,
    ).toBe('Finish');
    expect(nextAction(revealSnapshot(pollQ, LUNCH_RESULT, last, 9)).label).toBe('Finish');
    // A scored last question still goes through its leaderboard first.
    expect(nextAction(revealSnapshot(singleQ, MERCURY_RESULT, last, 9)).label).toBe('Leaderboard');
  });

  it('ended: nothing to press', () => {
    const a = nextAction(hostSnapshot({ phase: 'ended', questionIndex: 9, podium: PODIUM }));
    expect(a.command).toBeNull();
    expect(a.label).toBe('Finished');
  });

  it('every command it builds is a valid host.next', () => {
    for (const snap of [
      hostSnapshot(),
      questionSnapshot(singleQ, 1_000),
      revealing(),
      revealSnapshot(singleQ, MERCURY_RESULT),
      hostSnapshot({ phase: 'leaderboard', questionIndex: 2, leaderboard: LEADERBOARD }),
    ]) {
      expect(HostNextMsg.safeParse(nextAction(snap).command).success).toBe(true);
    }
  });
});

describe('the other host commands', () => {
  it('Enter closes only while a question is open', () => {
    expect(closeCommand(questionSnapshot(singleQ, 5_000, {}, 3))).toEqual({
      type: 'host.close',
      questionIndex: 3,
      reason: 'manual',
    });
    expect(closeCommand(hostSnapshot())).toBeNull();
    expect(closeCommand(revealing())).toBeNull();
    expect(closeCommand(revealSnapshot(singleQ, MERCURY_RESULT))).toBeNull();
  });

  it('skip and moderate need an open question', () => {
    expect(skipCommand(questionSnapshot(singleQ, 5_000, {}, 3))).toEqual({
      type: 'host.skip',
      questionIndex: 3,
    });
    expect(skipCommand(hostSnapshot())).toBeNull();
    expect(
      moderateCommand(questionSnapshot(openQ, 5_000, {}, 3), 'player-0001-0', 'hidden'),
    ).toEqual({
      type: 'host.moderate',
      questionIndex: 3,
      responseId: 'player-0001-0',
      status: 'hidden',
    });
    expect(moderateCommand(hostSnapshot(), 'player-0001-0', 'hidden')).toBeNull();
  });

  it('end, lock and kick are plain', () => {
    expect(endCommand()).toEqual({ type: 'host.end' });
    expect(lockCommand(true)).toEqual({ type: 'host.lock', locked: true });
    expect(kickCommand('player-0001')).toEqual({ type: 'host.kick', playerId: 'player-0001' });
  });
});
