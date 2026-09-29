import { describe, expect, it } from 'vitest';
import { TIMING } from '@zqhoot/protocol';
import { fullJitterDelay } from '../src/net/backoff.ts';

const opts = { baseMs: TIMING.reconnectBaseMs, capMs: TIMING.reconnectCapMs };

describe('fullJitterDelay', () => {
  it('is uniform in [0, base * 2^attempt) before the cap', () => {
    expect(fullJitterDelay(0, opts, () => 0)).toBe(0);
    expect(fullJitterDelay(0, opts, () => 0.999999)).toBe(499);
    expect(fullJitterDelay(1, opts, () => 0.5)).toBe(500);
    expect(fullJitterDelay(2, opts, () => 0.5)).toBe(1_000);
    expect(fullJitterDelay(3, opts, () => 0.999999)).toBe(3_999);
  });

  it('never exceeds the cap, however many attempts have failed', () => {
    for (const attempt of [5, 6, 10, 50, 1_000, Number.MAX_SAFE_INTEGER]) {
      const d = fullJitterDelay(attempt, opts, () => 0.999999);
      expect(d).toBeLessThan(opts.capMs);
      expect(d).toBeGreaterThanOrEqual(opts.capMs - 1);
    }
  });

  it('applies the injected random source across the whole range', () => {
    const draws = [0, 0.25, 0.5, 0.75, 0.999];
    const delays = draws.map((r) => fullJitterDelay(20, opts, () => r));
    expect(delays).toEqual([0, 2_500, 5_000, 7_500, 9_990]);
  });

  it('is spread out, not clustered, over many draws', () => {
    let seed = 42;
    const lcg = () => {
      seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      return seed / 4_294_967_296;
    };
    const buckets = new Array<number>(10).fill(0);
    for (let i = 0; i < 10_000; i++) {
      const d = fullJitterDelay(10, opts, lcg);
      buckets[Math.floor((d / opts.capMs) * 10)]! += 1;
    }
    for (const count of buckets) expect(count).toBeGreaterThan(800);
  });

  it('treats a negative or fractional attempt as its floor at zero', () => {
    expect(fullJitterDelay(-3, opts, () => 0.5)).toBe(250);
    expect(fullJitterDelay(0.9, opts, () => 0.5)).toBe(250);
  });
});
