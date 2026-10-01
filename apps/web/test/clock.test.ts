import { describe, expect, it } from 'vitest';
import { ServerClock } from '../src/net/clock.ts';

describe('ServerClock', () => {
  it('has no offset before the first observation and treats the clocks as equal', () => {
    const clock = new ServerClock();
    expect(clock.offsetMs).toBeNull();
    expect(clock.toLocal(1_000)).toBe(1_000);
    expect(clock.serverNow(1_000)).toBe(1_000);
  });

  it('takes the minimum of localReceive - ts, so the server is never believed to be ahead', () => {
    const clock = new ServerClock();
    clock.observe(10_000, 10_250); // 250 ms of latency
    expect(clock.offsetMs).toBe(250);
    clock.observe(11_000, 11_040); // a faster message tightens the estimate
    expect(clock.offsetMs).toBe(40);
    clock.observe(12_000, 12_600); // a slow one must not loosen it
    expect(clock.offsetMs).toBe(40);
  });

  it('handles a device clock that is ahead or behind the server', () => {
    const ahead = new ServerClock();
    ahead.observe(1_000, 61_030); // device is a minute fast, plus 30 ms latency
    expect(ahead.offsetMs).toBe(60_030);

    const behind = new ServerClock();
    behind.observe(100_000, 40_020);
    expect(behind.offsetMs).toBe(-59_980);
  });

  it('converts between server and local time in both directions', () => {
    const clock = new ServerClock();
    clock.observe(5_000, 5_100);
    expect(clock.toLocal(20_000)).toBe(20_100);
    expect(clock.serverNow(20_100)).toBe(20_000);
    expect(clock.serverNow(clock.toLocal(123_456))).toBe(123_456);
  });

  it('opens options late rather than early: local openAt is never before the true instant', () => {
    // True offset 0; the first message took 80 ms, so the estimate is 80 ms.
    const clock = new ServerClock();
    clock.observe(1_000, 1_080);
    expect(clock.toLocal(2_000)).toBeGreaterThanOrEqual(2_000);
  });

  it('forgets everything on reset', () => {
    const clock = new ServerClock();
    clock.observe(1_000, 1_200);
    clock.reset();
    expect(clock.offsetMs).toBeNull();
    clock.observe(2_000, 2_500);
    expect(clock.offsetMs).toBe(500);
  });

  it('ignores non-finite input', () => {
    const clock = new ServerClock();
    clock.observe(Number.NaN, 5);
    clock.observe(5, Number.POSITIVE_INFINITY);
    expect(clock.offsetMs).toBeNull();
  });
});
