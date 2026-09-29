import { describe, expect, it } from 'vitest';
import { LIMITS, TIMING, TIME_LIMITS_SEC } from '../src/index.ts';

/**
 * These pin the relationships that ADR-0002, ADR-0004 and ADR-0005 depend on, not the values, so
 * tuning `TIMING` stays free until an edit would break a platform limit or the fairness rule.
 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('TIMING invariants', () => {
  it('pings and gives up on a quiet socket before API Gateway idles it out (10 min)', () => {
    expect(TIMING.heartbeatIdleMs + TIMING.pongTimeoutMs).toBeLessThan(10 * MINUTE);
  });

  it('reconnects proactively, even after a full backoff, before the 2 h connection cap', () => {
    expect(TIMING.plannedReconnectMs + TIMING.reconnectCapMs).toBeLessThan(2 * HOUR);
  });

  it('keeps the backoff ordered: a first retry no later than the cap', () => {
    expect(TIMING.reconnectBaseMs).toBeGreaterThan(0);
    expect(TIMING.reconnectBaseMs).toBeLessThanOrEqual(TIMING.reconnectCapMs);
  });

  it('leads a question by more than the fan-out spread of each deployment target', () => {
    expect(TIMING.minLeadMs.lambda).toBeGreaterThanOrEqual(1500);
    expect(TIMING.minLeadMs.node).toBeGreaterThanOrEqual(500);
  });

  it('awards full points only inside a window shorter than the shortest time limit', () => {
    expect(TIMING.fullPointsWindowMs).toBeLessThan(Math.min(...TIME_LIMITS_SEC) * 1000);
  });

  it('accepts answers 750 ms past the deadline (ADR-0005)', () => {
    expect(TIMING.answerGraceMs).toBe(750);
  });
});

describe('LIMITS invariants', () => {
  it('keeps client messages within one API Gateway frame (32 KB)', () => {
    expect(LIMITS.clientMessageMaxBytes).toBeLessThanOrEqual(32 * 1024);
  });
});
