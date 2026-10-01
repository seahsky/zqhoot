import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TIMING } from '@zqhoot/protocol';
import { HostCloseMsg, HostStatsMsg } from '@zqhoot/protocol';
import {
  CLOSE_RESEND_MAX_MS,
  CLOSE_RESEND_MS,
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

/** When the driver may close a timed question: the deadline plus the answer grace (ADR-0005). */
const closeTime = (q: DriverQuestion): number => (q.deadline as number) + TIMING.answerGraceMs;
const timerClose = { type: 'host.close', questionIndex: 2, reason: 'timer' } as const;
const closesIn = (commands: DriverCommand[]) => commands.filter((c) => c.type === 'host.close');

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
  expected?: number,
): DriverInput => ({
  type: 'stats',
  questionIndex: index,
  answered,
  totalPlayers,
  ...(expected === undefined ? {} : { expected }),
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

describe('closing once the answer grace after the deadline is over', () => {
  it('sends host.close {timer} once, at deadline + grace, and no more polls after it', () => {
    const q = question();
    const at = closeTime(q);
    const { commands } = drive([
      [T, sync(q)],
      [(q.deadline as number) - 1, tick],
      [q.deadline as number, tick],
      [at - 1, tick],
      [at, tick],
      [at + 250, tick],
      [at + 500, tick],
      [at + CLOSE_RESEND_MS - 1, tick],
    ]);
    const closes = commands.filter(
      (c): c is Extract<DriverCommand, { type: 'host.close' }> => c.type === 'host.close',
    );
    expect(closes).toEqual([timerClose]);
    const last = commands.at(-1);
    expect(last?.type).not.toBe('host.stats');
    expect(HostCloseMsg.safeParse(closes[0]).success).toBe(true);
  });

  it('does not close at the bare deadline, nor anywhere inside the grace', () => {
    const q = question();
    const deadline = q.deadline as number;
    expect(TIMING.answerGraceMs).toBe(750);
    const { commands } = drive([
      [T, sync(q)],
      [deadline, tick],
      [deadline + 50, tick],
      [deadline + 300, tick],
      [deadline + TIMING.answerGraceMs - 1, tick],
    ]);
    expect(closesIn(commands)).toEqual([]);
    // Polling carries on in the window, so an all-answered close can still come from it.
    expect(commands.every((c) => c.type === 'host.stats')).toBe(true);
    const at = drive([[deadline + TIMING.answerGraceMs, tick]], drive([[T, sync(q)]]).state);
    expect(closesIn(at.commands)).toEqual([timerClose]);
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
    const at = closeTime(q);
    let r = drive([
      [T, sync(q)],
      [at, tick],
    ]);
    expect(r.state.closeSent).toBe(true);
    r = drive(
      [
        [at + 10, { type: 'unsent', command: 'close' }],
        [at + 260, tick],
      ],
      r.state,
    );
    expect(r.commands).toEqual([timerClose]);
  });

  it('a close that never left the browser does not lengthen the wait for the next one', () => {
    const q = question();
    const at = closeTime(q);
    let state = drive([
      [T, sync(q)],
      [at, tick],
    ]).state;
    for (let i = 0; i < 4; i++) {
      state = driverStep(state, { type: 'unsent', command: 'close' }, at + 10 * (i + 1)).state;
      state = driverStep(state, tick, at + 10 * (i + 1) + 5).state;
    }
    expect(state.closeSends).toBe(1);
    expect(state.closeResendAt - (at + 45)).toBe(CLOSE_RESEND_MS);
  });

  it('the timer fires even if no poll ever ran', () => {
    const q = question();
    const { commands } = drive([
      [T, sync(q)],
      [closeTime(q) + 100, tick],
    ]);
    expect(commands).toEqual([timerClose]);
  });
});

describe('a close nobody confirmed is sent again (the server says nothing about a lost one)', () => {
  const q = question();
  const at = closeTime(q);
  const opened = () =>
    drive([
      [T, sync(q)],
      [at, tick],
    ]);

  it('after a few seconds, then after doubled waits up to a cap', () => {
    let { state } = opened();
    expect(state).toMatchObject({
      closeSent: true,
      closeSends: 1,
      closeResendAt: at + CLOSE_RESEND_MS,
    });
    expect(CLOSE_RESEND_MS).toBe(3_000);

    // Still inside the wait: nothing, not even a poll (the figures come with the result).
    let r = drive([[at + CLOSE_RESEND_MS - 1, tick]], state);
    expect(r.commands).toEqual([]);

    let sentAt = at;
    let wait = CLOSE_RESEND_MS;
    const gaps: number[] = [];
    for (let i = 0; i < 8; i++) {
      const due = sentAt + wait;
      r = drive([[due - 1, tick]], state);
      expect(closesIn(r.commands), `too early, resend ${i + 1}`).toEqual([]);
      r = drive([[due, tick]], state);
      expect(r.commands, `resend ${i + 1}`).toEqual([timerClose]);
      state = r.state;
      gaps.push(wait);
      sentAt = due;
      wait = Math.min(CLOSE_RESEND_MAX_MS, wait * 2);
    }
    expect(gaps).toEqual([3, 6, 12, 24, 30, 30, 30, 30].map((n) => n * 1000));
    expect(CLOSE_RESEND_MAX_MS).toBe(30_000);
    expect(state.closeSends).toBe(9);
  });

  it('until the snapshot leaves the question, which ends it for good', () => {
    const { state } = opened();
    const gone = driverStep(state, sync(null), at + 500);
    expect(gone.state).toBe(IDLE_DRIVER);
    const later = drive(
      [
        [at + CLOSE_RESEND_MS, tick],
        [at + 60_000, tick],
      ],
      gone.state,
    );
    expect(later.commands).toEqual([]);
    // The next question starts with no memory of the last one's sends.
    const next = question({ index: 3, openAt: T + 40_000, deadline: T + 60_000 });
    expect(driverStep(gone.state, sync(next), at + 600).state).toMatchObject({
      closeSent: false,
      closeSends: 0,
      closeResendAt: 0,
    });
  });

  it('a repeated snapshot of the same question is no proof that the close arrived', () => {
    const { state } = opened();
    const again = driverStep(state, sync(question()), at + 100).state;
    expect(again).toMatchObject({ closeSent: true, closeSends: 1 });
    const r = drive([[at + CLOSE_RESEND_MS, tick]], again);
    expect(r.commands).toEqual([timerClose]);
  });

  it('after a reconnect whose snapshot is still that question past its deadline', () => {
    // The auditor's run: one close, then a resync and the welcome for the same question.
    let { state } = opened();
    const all: DriverCommand[] = [];
    const feed = (time: number, input: DriverInput) => {
      const r = driverStep(state, input, time);
      state = r.state;
      all.push(...r.commands);
    };
    feed(at + 400, { type: 'resync' });
    feed(at + 410, sync(q));
    // The very next tick, well before the resend wait would have run out.
    feed(at + 500, tick);
    expect(closesIn(all)).toEqual([timerClose]);
    // And it keeps trying after that, on the usual waits.
    for (let time = at + 750; time <= at + 120_000; time += 250) feed(time, tick);
    expect(closesIn(all).length).toBeGreaterThan(2);
  });

  it('a reconnect that finds the question over leaves nothing to send', () => {
    const { state } = opened();
    const r = drive(
      [
        [at + 400, { type: 'resync' }],
        [at + 410, sync(null)],
        [at + 500, tick],
      ],
      state,
    );
    expect(r.commands).toEqual([]);
    expect(r.state).toBe(IDLE_DRIVER);
  });

  it('a reconnect before the deadline sends nothing early', () => {
    const early = drive([
      [T, sync(q)],
      [T + 3_000, stats(4, 4)],
    ]);
    expect(closesIn(early.commands)).toEqual([
      { type: 'host.close', questionIndex: 2, reason: 'all-answered' },
    ]);
    const r = drive(
      [
        [T + 3_400, { type: 'resync' }],
        [T + 3_410, sync(q)],
        [T + 3_500, tick],
      ],
      early.state,
    );
    // The timer close is not due: what comes next is the poll that can find everyone answered.
    expect(closesIn(r.commands)).toEqual([]);
    expect(r.commands).toEqual([{ type: 'host.stats', questionIndex: 2 }]);
  });

  it('an all-answered close that got no answer is retried by the next stats reply', () => {
    let r = drive([
      [T, sync(q)],
      [T + 3_000, stats(4, 4)],
    ]);
    r = drive([[T + 3_000 + CLOSE_RESEND_MS, tick]], r.state);
    expect(r.commands).toEqual([{ type: 'host.stats', questionIndex: 2 }]);
    r = drive([[T + 3_000 + CLOSE_RESEND_MS + 50, stats(4, 4)]], r.state);
    expect(r.commands).toEqual([{ type: 'host.close', questionIndex: 2, reason: 'all-answered' }]);
  });

  it('honours a server refusal on top of this: the refusal backoff still applies', () => {
    let { state } = opened();
    state = driverStep(state, { type: 'close.refused' }, at + 100).state;
    const wait = at + 100 + CLOSE_RETRY_MS;
    expect(closesIn(drive([[wait - 1, tick]], state).commands)).toEqual([]);
    expect(drive([[wait, tick]], state).commands).toEqual([timerClose]);
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

  describe('against the players the question waits for (LiveStats.expected, ADR-0006)', () => {
    const allAnswered = { type: 'host.close', questionIndex: 2, reason: 'all-answered' } as const;

    it('closes when every connected player has answered, however many dropped out', () => {
      // 25 non-kicked players, 5 of them offline without an answer: 20 are awaited.
      const { commands } = drive([
        [T, sync()],
        [T + 3_000, stats(12, 25, null, 2, 20)],
        [T + 4_000, stats(19, 25, null, 2, 20)],
        [T + 5_000, stats(20, 25, null, 2, 20)],
      ]);
      expect(commands).toEqual([allAnswered]);
    });

    it('does not close on the connected players alone while one of them has not answered', () => {
      const { commands } = drive([
        [T, sync()],
        [T + 3_000, stats(19, 25, null, 2, 20)],
        [T + 4_000, stats(19, 25, null, 2, 21)],
      ]);
      expect(commands).toEqual([]);
    });

    it('counts a player who answered and then left as answered, not as a reason to wait', () => {
      // Two answered, one of them has left since; the third connected player is still to come.
      const wait = drive([
        [T, sync()],
        [T + 3_000, stats(2, 4, null, 2, 3)],
      ]);
      expect(wait.commands).toEqual([]);
      expect(drive([[T + 4_000, stats(3, 4, null, 2, 3)]], wait.state).commands).toEqual([
        allAnswered,
      ]);
    });

    it('falls back to the player count when the server sends no expected count', () => {
      expect(
        drive([
          [T, sync()],
          [T + 3_000, stats(9, 10)],
        ]).commands,
      ).toEqual([]);
      expect(
        drive([
          [T, sync()],
          [T + 3_000, stats(10, 10)],
        ]).commands,
      ).toEqual([allAnswered]);
    });

    it('never with nobody expected, even though players exist', () => {
      // Everybody is offline and nobody answered: the timer decides, not this.
      expect(
        drive([
          [T, sync()],
          [T + 3_000, stats(0, 4, null, 2, 0)],
        ]).commands,
      ).toEqual([]);
    });

    it('reaches the driver: the host session hook forwards stats.expected', () => {
      // The driver is fed by useHostSession, which lists the fields it passes one by one. Without
      // this one the driver would fall back to totalPlayers in the real app and the unit tests
      // above would still pass, so the hook's source is pinned here.
      const hook = readFileSync(
        fileURLToPath(new URL('../src/screens/host/useHostSession.ts', import.meta.url)),
        'utf8',
      );
      const input = /run\(\{\s*type:\s*'stats',[\s\S]*?\}\);/.exec(hook)?.[0] ?? '';
      expect(input).toContain('totalPlayers: stats.totalPlayers');
      expect(input).toMatch(/expected:\s*stats\.expected/);
    });

    it('a multi-entry question is still not closed by the first round', () => {
      const multi = driverQuestionOf(wordCloudQ, 2, T + 1_500, T + 46_500);
      expect(
        drive([
          [T, sync(multi)],
          [T + 3_000, stats(6, 10, null, 2, 6)],
        ]).commands,
      ).toEqual([]);
    });
  });

  it('the timer does not send a second close while the all-answered one is still awaited', () => {
    const q = question({ deadline: T + 5_000 });
    const { commands } = drive([
      [T, sync(q)],
      [T + 4_000, stats(4, 4)],
      [closeTime(q), tick],
      [closeTime(q) + 250, tick],
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
  const deadline = closeTime(q);
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
