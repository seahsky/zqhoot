import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession } from '@zqhoot/engine';
import { MemoryStore } from '@zqhoot/store';
import { noopLogger } from '@zqhoot/service';
import { TimerScheduler, recoverSessions } from '../src/ports/scheduler.ts';

const T0 = 1_800_000_000_000;

describe('TimerScheduler', () => {
  let calls: Array<[string, number]>;
  let scheduler: TimerScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    calls = [];
    scheduler = new TimerScheduler(
      async (sessionId, index) => {
        calls.push([sessionId, index]);
      },
      { now: () => Date.now() },
      noopLogger,
    );
  });

  afterEach(() => {
    scheduler.dispose();
    vi.useRealTimers();
  });

  it('calls the handler at the given time and not before', () => {
    scheduler.scheduleClose('sess-1', 2, T0 + 5000);
    vi.advanceTimersByTime(4999);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual([['sess-1', 2]]);
    expect(scheduler.pending).toBe(0);
  });

  it('fires at once for a time in the past', () => {
    scheduler.scheduleClose('sess-1', 0, T0 - 60_000);
    vi.advanceTimersByTime(0);
    expect(calls).toEqual([['sess-1', 0]]);
  });

  it('cancel drops every timer of that session and only that session', () => {
    scheduler.scheduleClose('sess-1', 0, T0 + 1000);
    scheduler.scheduleClose('sess-1', 1, T0 + 2000);
    scheduler.scheduleClose('sess-2', 0, T0 + 1000);
    scheduler.cancel('sess-1');
    vi.advanceTimersByTime(10_000);
    expect(calls).toEqual([['sess-2', 0]]);
  });

  it('scheduling the same question again replaces the earlier timer', () => {
    scheduler.scheduleClose('sess-1', 0, T0 + 1000);
    scheduler.scheduleClose('sess-1', 0, T0 + 3000);
    vi.advanceTimersByTime(2000);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(calls).toEqual([['sess-1', 0]]);
  });

  it('waits out a delay longer than setTimeout allows', () => {
    const thirtyDays = 30 * 24 * 3600 * 1000;
    scheduler.scheduleClose('sess-1', 0, T0 + thirtyDays);
    vi.advanceTimersByTime(thirtyDays - 1);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual([['sess-1', 0]]);
  });

  it('dispose drops everything', () => {
    scheduler.scheduleClose('sess-1', 0, T0 + 1000);
    scheduler.scheduleClose('sess-2', 3, T0 + 1000);
    expect(scheduler.pending).toBe(2);
    scheduler.dispose();
    vi.advanceTimersByTime(5000);
    expect(calls).toEqual([]);
    expect(scheduler.pending).toBe(0);
  });

  it('ignores scheduleClose after dispose, so a late frame cannot arm a timer', () => {
    scheduler.dispose();
    scheduler.scheduleClose('sess-1', 0, T0 + 1000);
    expect(scheduler.pending).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(calls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('logs a failing handler instead of throwing', async () => {
    const errors: object[] = [];
    const failing = new TimerScheduler(
      () => Promise.reject(new Error('boom')),
      { now: () => Date.now() },
      { ...noopLogger, error: (o) => errors.push(o) },
    );
    failing.scheduleClose('sess-1', 0, T0);
    await vi.advanceTimersByTimeAsync(1);
    expect(errors).toEqual([expect.objectContaining({ sessionId: 'sess-1', err: 'boom' })]);
  });
});

describe('recoverSessions', () => {
  const HOST = 'local:admin';

  function seed() {
    const quiz = {
      id: 'quiz-0001',
      ownerId: HOST,
      title: 'Q',
      version: 1,
      createdAt: T0,
      updatedAt: T0,
      settings: { streakBonus: false, showQuestionOnDevices: true, readSeconds: 0 },
      questions: [
        {
          id: 'question-1',
          type: 'truefalse' as const,
          prompt: 'x',
          timeLimitSec: 10,
          correct: true,
          points: 1 as const,
        },
      ],
    };
    const cfg = { minLeadMs: 750, answerGraceMs: 750, sessionTtlMs: 30 * 24 * 3600 * 1000 };
    const made = (sessionId: string, pin: string) =>
      createSession({ sessionId, pin, hostId: HOST, quiz, now: T0, cfg });
    return { made };
  }

  it('reschedules the timers of sessions in question and clears stale connections', async () => {
    const store = new MemoryStore({ now: () => T0 });
    const { made } = seed();
    const open = made('session-open', '111111');
    const lobby = made('session-lobby', '222222');
    await store.createSession(open.meta, open.snapshot);
    await store.createSession(lobby.meta, lobby.snapshot);
    // The engine moves a session to `question`; a persisted state is just that meta written back.
    await store.updateSession(
      {
        ...open.meta,
        phase: 'question',
        questionIndex: 0,
        openAt: T0 + 1000,
        deadline: T0 + 11_000,
        version: 2,
      },
      open.meta.version,
    );
    for (const sessionId of ['session-open', 'session-lobby']) {
      await store.putConnection({
        connectionId: `conn-${sessionId}`,
        sessionId,
        role: 'player',
        playerId: 'player-1',
        connectedAt: T0,
        expiresAt: T0 + 3_600_000,
      });
    }

    const scheduled: Array<[string, number, number]> = [];
    const result = await recoverSessions({
      store,
      scheduler: {
        scheduleClose: (s, i, at) => scheduled.push([s, i, at]),
        cancel: () => undefined,
      },
      hostId: HOST,
      answerGraceMs: 750,
      log: noopLogger,
    });

    expect(scheduled).toEqual([['session-open', 0, T0 + 11_750]]);
    expect(result).toEqual({ sessions: 2, timers: 1, connectionsCleared: 2 });
    expect(await store.listConnections('session-open')).toEqual([]);
    expect(await store.listConnections('session-lobby')).toEqual([]);
  });

  it('skips untimed questions and other hosts', async () => {
    const store = new MemoryStore({ now: () => T0 });
    const { made } = seed();
    const untimed = made('session-untimed', '333333');
    await store.createSession(untimed.meta, untimed.snapshot);
    await store.updateSession(
      {
        ...untimed.meta,
        phase: 'question',
        questionIndex: 0,
        openAt: T0,
        deadline: null,
        version: 2,
      },
      untimed.meta.version,
    );
    const scheduled: unknown[] = [];
    const scheduler = {
      scheduleClose: (...args: unknown[]) => scheduled.push(args),
      cancel: () => undefined,
    };
    await recoverSessions({ store, scheduler, hostId: HOST, answerGraceMs: 750, log: noopLogger });
    await recoverSessions({
      store,
      scheduler,
      hostId: 'local:someone-else',
      answerGraceMs: 750,
      log: noopLogger,
    });
    expect(scheduled).toEqual([]);
  });
});
