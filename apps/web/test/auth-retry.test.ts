import { describe, expect, it } from 'vitest';
import { TIMING } from '@zqhoot/protocol';
import { AuthRetry, MAX_AUTH_RETRIES, authRetryDelayMs } from '../src/state/authRetry.ts';
import type { AuthRetryOptions } from '../src/state/authRetry.ts';

/** Timers the test winds by hand, so a loop that would run "forever" is over in a line. */
function clock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    get now() {
      return now;
    },
    setTimer: (fn: () => void, ms: number) => {
      timers.set(nextId, { at: now + ms, fn });
      return nextId++;
    },
    clearTimer: (handle: unknown) => void timers.delete(handle as number),
    pending: () => timers.size,
    /** Runs everything due up to `ms` from now, in order, and settles the promises it started. */
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await Promise.resolve();
        await Promise.resolve();
      }
      now = end;
    },
  };
}

function make(over: Partial<AuthRetryOptions> = {}) {
  const c = clock();
  const events: string[] = [];
  const retry = new AuthRetry({
    refresh: async () => {
      events.push(`refresh@${c.now}`);
      return true;
    },
    onRefreshed: () => events.push(`refreshed@${c.now}`),
    onGiveUp: () => events.push(`gave-up@${c.now}`),
    random: () => 0.5,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
    ...over,
  });
  return { retry, c, events };
}

describe('the wait before a refresh', () => {
  it('is the reconnect backoff: full jitter under a ceiling that doubles', () => {
    const worst = () => 0.999999;
    expect(authRetryDelayMs(1, worst)).toBe(TIMING.reconnectBaseMs - 1);
    expect(authRetryDelayMs(2, worst)).toBe(2 * TIMING.reconnectBaseMs - 1);
    expect(authRetryDelayMs(3, worst)).toBe(4 * TIMING.reconnectBaseMs - 1);
    expect(authRetryDelayMs(1, () => 0)).toBe(0);
    for (let n = 1; n <= MAX_AUTH_RETRIES; n++) {
      expect(authRetryDelayMs(n, worst)).toBeLessThan(TIMING.reconnectCapMs);
    }
  });

  it('runs out after MAX_AUTH_RETRIES refusals in a row', () => {
    expect(MAX_AUTH_RETRIES).toBe(3);
    expect(authRetryDelayMs(MAX_AUTH_RETRIES)).not.toBeNull();
    expect(authRetryDelayMs(MAX_AUTH_RETRIES + 1)).toBeNull();
    expect(authRetryDelayMs(50)).toBeNull();
  });
});

describe('refresh and reconnect after a refused token', () => {
  it('waits out the backoff, refreshes once, then asks for a new connection', async () => {
    const { retry, c, events } = make();
    retry.refused();
    // Nothing happens at once: the first wait is half of 0.5 s here.
    expect(events).toEqual([]);
    await c.advance(249);
    expect(events).toEqual([]);
    await c.advance(1);
    expect(events).toEqual(['refresh@250', 'refreshed@250']);
  });

  it('refusals while one is waiting or running are covered by it: one refresh, not one each', async () => {
    let release: (ok: boolean) => void = () => undefined;
    const { retry, c, events } = make({
      refresh: () => {
        events.push(`refresh@${c.now}`);
        return new Promise<boolean>((resolve) => (release = resolve));
      },
    });
    retry.refused();
    retry.refused();
    retry.refused();
    expect(c.pending()).toBe(1);
    await c.advance(250);
    retry.refused(); // the refresh is under way
    expect(events).toEqual(['refresh@250']);
    release(true);
    await c.advance(0);
    expect(events).toEqual(['refresh@250', 'refreshed@250']);
    expect(c.pending()).toBe(0);
  });

  it('does not reconnect when the refresh failed: the sign-in is already gone', async () => {
    const { retry, c, events } = make({
      refresh: async () => {
        events.push(`refresh@${c.now}`);
        return false;
      },
    });
    retry.refused();
    await c.advance(1_000);
    expect(events).toEqual(['refresh@250']);
  });

  it('gives up when the refresh throws', async () => {
    const { retry, c, events } = make({
      refresh: async () => {
        throw new Error('boom');
      },
    });
    retry.refused();
    await c.advance(1_000);
    expect(events).toEqual(['gave-up@250']);
  });

  it('a refusal that no refresh mends ends in a few refreshes, not a loop', async () => {
    // The server refuses every token, however fresh. A page that reconnects at once after each
    // refresh would refresh and say hello about 45 times a second.
    const c = clock();
    const log: string[] = [];
    let hellos = 0;
    let tokenRequests = 0;
    const retry = new AuthRetry({
      refresh: async () => {
        tokenRequests += 1;
        return true;
      },
      // A new connection says hello at once and is refused at once.
      onRefreshed: () => {
        hellos += 1;
        retry.refused();
      },
      onGiveUp: () => log.push(`gave-up@${c.now}`),
      random: () => 0.999999,
      setTimer: c.setTimer,
      clearTimer: c.clearTimer,
    });
    hellos += 1; // the first hello
    retry.refused();
    await c.advance(3_500);
    expect(log).toHaveLength(1);
    expect(tokenRequests).toBe(MAX_AUTH_RETRIES);
    expect(hellos).toBe(MAX_AUTH_RETRIES + 1);
    // Each refresh waited its full backoff: 499 ms, then 999 ms, then 1,999 ms.
    expect(log).toEqual(['gave-up@3497']);
    // And nothing is left waiting to try again.
    expect(c.pending()).toBe(0);
    await c.advance(60_000);
    expect(tokenRequests).toBe(MAX_AUTH_RETRIES);
  });

  it('a welcome starts the count again, so a later refusal gets its full set of tries', async () => {
    const { retry, c, events } = make({ random: () => 0.999999 });
    for (let i = 0; i < MAX_AUTH_RETRIES; i++) {
      retry.refused();
      await c.advance(10_000);
    }
    retry.accepted();
    for (let i = 0; i < MAX_AUTH_RETRIES; i++) {
      retry.refused();
      await c.advance(10_000);
    }
    expect(events.filter((e) => e.startsWith('gave-up'))).toEqual([]);
    expect(events.filter((e) => e.startsWith('refresh@'))).toHaveLength(2 * MAX_AUTH_RETRIES);
    // Without another welcome the next refusal is the fourth in a row.
    retry.refused();
    expect(events.at(-1)).toMatch(/^gave-up/);
  });

  it('stops for good once disposed: no refresh from a page that is gone', async () => {
    const { retry, c, events } = make();
    retry.refused();
    retry.dispose();
    await c.advance(10_000);
    expect(events).toEqual([]);
    retry.refused();
    await c.advance(10_000);
    expect(events).toEqual([]);

    // A refresh already under way finishes, but does not open a connection.
    let release: (ok: boolean) => void = () => undefined;
    const late = make({
      refresh: () => new Promise<boolean>((resolve) => (release = resolve)),
    });
    late.retry.refused();
    await late.c.advance(250);
    late.retry.dispose();
    release(true);
    await late.c.advance(0);
    expect(late.events).toEqual([]);
  });
});
