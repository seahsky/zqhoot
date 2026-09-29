import { describe, expect, it } from 'vitest';
import { TIMING } from '@zqhoot/protocol';
import { HostCloseMsg, HostStatsMsg } from '@zqhoot/protocol';
import {
  CLOSE_RETRY_MAX_MS,
  CLOSE_RETRY_MS,
  IDLE_DRIVER,
  REWALK_MS,
  driverQuestionOf,
  driverStep,
} from '../src/state/driver.ts';
import type {
  DriverCommand,
  DriverInput,
  DriverQuestion,
  DriverState,
} from '../src/state/driver.ts';
import { openQ, singleQ, wordCloudQ } from '../src/dev/fixtures/hostSnapshots.ts';

const T = 1_000_000;
const question = (over: Partial<DriverQuestion> = {}): DriverQuestion => ({
  index: 2,
  openAt: T + 1_500,
  deadline: T + 1_500 + 20_000,
  multiEntry: false,
  ...over,
});

/** Feeds inputs one after another, each at its own time, and collects every command. */
function drive(
  steps: Array<[time: number, input: DriverInput]>,
  from: DriverState = IDLE_DRIVER,
): { state: DriverState; commands: DriverCommand[] } {
  let state = from;
  const commands: DriverCommand[] = [];
  for (const [time, input] of steps) {
    const r = driverStep(state, input, time);
    state = r.state;
    commands.push(...r.commands);
  }
  return { state, commands };
}

const sync = (q: DriverQuestion | null = question()): DriverInput => ({
  type: 'sync',
  question: q,
});
const tick: DriverInput = { type: 'tick' };
const stats = (
  answered: number,
  totalPlayers: number,
  cursor: string | null = null,
  index = 2,
): DriverInput => ({
  type: 'stats',
  questionIndex: index,
  answered,
  totalPlayers,
  cursor,
});

describe('starting and stopping with the phase', () => {
  it('does nothing until a question is synced', () => {
    expect(drive([[T, tick]]).commands).toEqual([]);
  });

  it('starts polling when options open, not when the question appears', () => {
    const { commands } = drive([
      [T, sync()],
      [T + 500, tick],
      [T + 1_499, tick],
    ]);
    expect(commands).toEqual([]);
    const later = drive([
      [T, sync()],
      [T + 1_500, tick],
    ]);
    expect(later.commands).toEqual([{ type: 'host.stats', questionIndex: 2 }]);
  });

  it('polls once per statsPollMs', () => {
    const { commands } = drive([
      [T, sync()],
      [T + 1_500, tick],
      [T + 1_750, tick],
      [T + 2_499, tick],
      [T + 2_500, tick],
      [T + 3_499, tick],
      [T + 3_500, tick],
    ]);
    expect(commands.filter((c) => c.type === 'host.stats')).toHaveLength(3);
    expect(TIMING.statsPollMs).toBe(1000);
  });

  it('stops outside the question phase and forgets the question', () => {
    const s1 = drive([
      [T, sync()],
      [T + 2_000, tick],
    ]).state;
    const { state, commands } = drive(
      [
        [T + 2_100, sync(null)],
        [T + 5_000, tick],
      ],
      s1,
    );
    expect(commands).toEqual([]);
    expect(state).toEqual(IDLE_DRIVER);
  });

  it('a different question starts over: new poll time, no cursor, the close is armed again', () => {
    const closed = drive([
      [T, sync()],
      [T + 30_000, tick],
    ]);
    expect(closed.state.closeSent).toBe(true);
    const next = question({ index: 3, openAt: T + 40_000, deadline: T + 60_000 });
    const r = drive([[T + 31_000, sync(next)]], closed.state);
    expect(r.state).toMatchObject({ closeSent: false, cursor: null, nextPollAt: T + 40_000 });
  });

  it('a repeated sync of the same question keeps its state', () => {
    const polling = drive([
      [T, sync()],
      [T + 2_000, tick],
      [T + 2_100, stats(1, 5, 'cur-1')],
    ]).state;
    const again = driverStep(polling, sync(question({ deadline: T + 99_000 })), T + 2_200).state;
    expect(again.cursor).toBe('cur-1');
    expect(again.question?.deadline).toBe(T + 99_000);
  });
});

describe('closing at the deadline', () => {
  it('sends host.close {timer} once, at the deadline, and no more polls after it', () => {
    const q = question();
    const { commands } = drive([
      [T, sync(q)],
      [(q.deadline as number) - 1, tick],
      [q.deadline as number, tick],
      [(q.deadline as number) + 250, tick],
      [(q.deadline as number) + 500, tick],
      [(q.deadline as number) + 5_000, tick],
    ]);
    const closes = commands.filter(
      (c): c is Extract<DriverCommand, { type: 'host.close' }> => c.type === 'host.close',
    );
    expect(closes).toEqual([{ type: 'host.close', questionIndex: 2, reason: 'timer' }]);
    const last = commands.at(-1);
    expect(last?.type).not.toBe('host.stats');
    expect(HostCloseMsg.safeParse(closes[0]).success).toBe(true);
  });

  it('an untimed question is never closed by the clock', () => {
    const { commands } = drive([
      [T, sync(question({ deadline: null }))],
      [T + 10 * 60_000, tick],
    ]);
    expect(commands.every((c) => c.type === 'host.stats')).toBe(true);
  });

  it('a close the socket refused is sent again on the next tick', () => {
    const q = question();
    let r = drive([
      [T, sync(q)],
      [q.deadline as number, tick],
    ]);
    expect(r.state.closeSent).toBe(true);
    r = drive(
      [
        [(q.deadline as number) + 10, { type: 'unsent', command: 'close' }],
        [(q.deadline as number) + 260, tick],
      ],
      r.state,
    );
    expect(r.commands).toEqual([{ type: 'host.close', questionIndex: 2, reason: 'timer' }]);
  });

  it('the timer fires even if no poll ever ran', () => {
    const q = question();
    const { commands } = drive([
      [T, sync(q)],
      [(q.deadline as number) + 100, tick],
    ]);
    expect(commands).toEqual([{ type: 'host.close', questionIndex: 2, reason: 'timer' }]);
  });
});

describe('closing when everybody has answered', () => {
  it('closes once when answered reaches the player count', () => {
    const { commands } = drive([
      [T, sync()],
      [T + 3_000, stats(9, 10)],
      [T + 4_000, stats(10, 10)],
      [T + 5_000, stats(10, 10)],
      [T + 6_000, stats(11, 10)],
    ]);
    expect(commands).toEqual([{ type: 'host.close', questionIndex: 2, reason: 'all-answered' }]);
  });

  it('never with no players', () => {
    expect(
      drive([
        [T, sync()],
        [T + 3_000, stats(0, 0)],
      ]).commands,
    ).toEqual([]);
  });

  it('the timer does not send a second close after an all-answered one', () => {
    const q = question();
    const { commands } = drive([
      [T, sync(q)],
      [T + 3_000, stats(4, 4)],
      [q.deadline as number, tick],
    ]);
    expect(commands.filter((c) => c.type === 'host.close')).toHaveLength(1);
  });

  it('ignores stats for another question', () => {
    expect(
      drive([
        [T, sync()],
        [T + 3_000, stats(4, 4, null, 7)],
      ]).commands,
    ).toEqual([]);
  });

  it('a question that takes several entries per player is not closed by the first round', () => {
    const multi = driverQuestionOf(wordCloudQ, 2, T + 1_500, T + 46_500);
    expect(multi.multiEntry).toBe(true);
    expect(
      drive([
        [T, sync(multi)],
        [T + 3_000, stats(10, 10)],
      ]).commands,
    ).toEqual([]);
    expect(driverQuestionOf(openQ, 2, 0, null).multiEntry).toBe(true);
    expect(driverQuestionOf({ ...openQ, maxEntries: 1 }, 2, 0, null).multiEntry).toBe(false);
    expect(driverQuestionOf(singleQ, 2, 0, 1).multiEntry).toBe(false);
  });

  it('a close refused by the socket is retried on the next stats reply', () => {
    let r = drive([
      [T, sync()],
      [T + 3_000, stats(4, 4)],
      [T + 3_010, { type: 'unsent', command: 'close' }],
    ]);
    expect(r.state.closeSent).toBe(false);
    r = drive([[T + 4_000, stats(4, 4)]], r.state);
    expect(r.commands).toEqual([{ type: 'host.close', questionIndex: 2, reason: 'all-answered' }]);
  });
});

describe('paging open-ended responses with the cursor', () => {
  it('sends no cursor at first, then the last non-null one', () => {
    const { commands } = drive([
      [T, sync()],
      [T + 1_500, tick],
      [T + 1_600, stats(3, 30, 'cursor-a')],
      [T + 1_700, tick],
      [T + 1_800, stats(3, 30, null)],
      [T + 2_800, tick],
    ]);
    expect(commands).toEqual([
      { type: 'host.stats', questionIndex: 2 },
      { type: 'host.stats', questionIndex: 2, after: 'cursor-a' },
      { type: 'host.stats', questionIndex: 2, after: 'cursor-a' },
    ]);
    for (const c of commands) expect(HostStatsMsg.safeParse(c).success).toBe(true);
  });

  it('asks for the next page at once when a reply says more is waiting', () => {
    const s = drive([
      [T, sync()],
      [T + 1_500, tick],
      [T + 1_520, stats(150, 200, 'cursor-a')],
    ]).state;
    const r = driverStep(s, tick, T + 1_530);
    expect(r.commands).toEqual([{ type: 'host.stats', questionIndex: 2, after: 'cursor-a' }]);
  });

  it('a resync starts again from the first page, straight away', () => {
    const s = drive([
      [T, sync()],
      [T + 1_500, tick],
      [T + 1_520, stats(150, 200, 'cursor-a')],
      [T + 1_530, tick],
    ]).state;
    const resynced = driverStep(s, { type: 'resync' }, T + 1_600);
    expect(resynced.state.cursor).toBeNull();
    const r = driverStep(resynced.state, tick, T + 1_610);
    expect(r.commands).toEqual([{ type: 'host.stats', questionIndex: 2 }]);
    expect(driverStep(IDLE_DRIVER, { type: 'resync' }, T).state).toBe(IDLE_DRIVER);
  });
});

describe('reading the first pages again', () => {
  /** A list of two pages: the first reply carries a cursor, the second none. */
  function twoPageWalk(from: number) {
    return [
      [from, tick],
      [from + 20, stats(150, 200, 'cursor-a')],
      [from + 30, tick],
      [from + 50, stats(150, 200, null)],
    ] satisfies Array<[number, DriverInput]>;
  }

  it('walks from the first page again once the last walk is REWALK_MS old', () => {
    const walked = drive([[T, sync()], ...twoPageWalk(T + 1_500)]);
    const endedAt = T + 1_550;
    expect(walked.commands).toEqual([
      { type: 'host.stats', questionIndex: 2 },
      { type: 'host.stats', questionIndex: 2, after: 'cursor-a' },
    ]);
    // In between, only the tail is asked for.
    const tail = drive(
      [
        [T + 2_550, tick],
        [T + 3_550, tick],
      ],
      walked.state,
    );
    expect(tail.commands).toEqual([
      { type: 'host.stats', questionIndex: 2, after: 'cursor-a' },
      { type: 'host.stats', questionIndex: 2, after: 'cursor-a' },
    ]);
    const again = drive([[endedAt + REWALK_MS, tick]], tail.state);
    expect(again.commands).toEqual([{ type: 'host.stats', questionIndex: 2 }]);
    for (const c of [...tail.commands, ...again.commands]) {
      expect(HostStatsMsg.safeParse(c).success).toBe(true);
    }
  });

  it('pages on from a re-walk and does not restart it, however long it takes', () => {
    const walked = drive([[T, sync()], ...twoPageWalk(T + 1_500)]);
    const start = T + 1_550 + REWALK_MS;
    // The re-walk's first page arrives, then the next request is due at once.
    const r = drive(
      [
        [start, tick],
        [start + 40, stats(150, 200, 'cursor-b')],
        [start + 50, tick],
        // A slow reply must not send the walk back to the first page.
        [start + 50 + REWALK_MS + 1_000, tick],
      ],
      walked.state,
    );
    expect(r.commands).toEqual([
      { type: 'host.stats', questionIndex: 2 },
      { type: 'host.stats', questionIndex: 2, after: 'cursor-b' },
      { type: 'host.stats', questionIndex: 2, after: 'cursor-b' },
    ]);
  });

  it('a list of one page is always read from the first page', () => {
    const { commands } = drive([
      [T, sync()],
      [T + 1_500, tick],
      [T + 1_520, stats(30, 40, null)],
      [T + 2_500, tick],
      [T + 12_000, tick],
    ]);
    expect(commands).toHaveLength(3);
    for (const c of commands) expect(c).toEqual({ type: 'host.stats', questionIndex: 2 });
  });

  it('a new question starts with a clean slate', () => {
    const walked = drive([[T, sync()], ...twoPageWalk(T + 1_500)]);
    const next = question({ index: 3, openAt: T + 9_000, deadline: T + 30_000 });
    const r = drive([[T + 8_000, sync(next)]], walked.state);
    expect(r.state).toMatchObject({ cursor: null, paging: false, rewalkAt: 0 });
  });
});

describe('a close the server refused', () => {
  const q = question();
  const deadline = q.deadline as number;
  const timerClose = { type: 'host.close', questionIndex: 2, reason: 'timer' };
  const refused: DriverInput = { type: 'close.refused' };

  it('is sent again after a wait, and the wait doubles up to a cap', () => {
    let r = drive([
      [T, sync(q)],
      [deadline, tick],
      [deadline + 100, refused],
    ]);
    expect(r.state.closeSent).toBe(false);
    // Too early: still backing off (polls are fine).
    r = drive([[deadline + 100 + CLOSE_RETRY_MS - 1, tick]], r.state);
    expect(r.commands.filter((c) => c.type === 'host.close')).toEqual([]);
    r = drive([[deadline + 100 + CLOSE_RETRY_MS, tick]], r.state);
    expect(r.commands).toEqual([timerClose]);

    // Refused again: the wait doubles.
    const second = deadline + 100 + CLOSE_RETRY_MS + 50;
    r = drive([[second, refused]], r.state);
    expect(r.state.closeRetryAt).toBe(second + 2 * CLOSE_RETRY_MS);

    // And never exceeds the cap.
    let state = r.state;
    let at = second;
    for (let i = 0; i < 8; i++) {
      at += 10;
      state = drive([[at, refused]], { ...state, closeSent: true }).state;
    }
    expect(state.closeRetryAt - at).toBe(CLOSE_RETRY_MAX_MS);
  });

  it('also retries an all-answered close, on the first reply after the wait', () => {
    let r = drive([
      [T, sync(q)],
      [T + 3_000, stats(4, 4)],
      [T + 3_050, refused],
    ]);
    expect(r.state.closeSent).toBe(false);
    r = drive([[T + 3_060, stats(4, 4)]], r.state);
    expect(r.commands).toEqual([]);
    r = drive([[T + 3_050 + CLOSE_RETRY_MS, stats(4, 4)]], r.state);
    expect(r.commands).toEqual([{ type: 'host.close', questionIndex: 2, reason: 'all-answered' }]);
  });

  it('is not ours to retry when this driver has sent no close', () => {
    const before = drive([[T, sync(q)]]).state;
    expect(driverStep(before, refused, T + 100).state).toBe(before);
    expect(driverStep(IDLE_DRIVER, refused, T).state).toBe(IDLE_DRIVER);
  });
});
