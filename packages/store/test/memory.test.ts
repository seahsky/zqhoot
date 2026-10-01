import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/index.ts';
import { runStoreContract } from './contract.ts';
import { populateAll } from './populate.ts';
import { CLOCK_START, DAY_MS, createClock, makeMeta, makeQuiz, makeSnapshot } from './fixtures.ts';

runStoreContract('MemoryStore', async (clock) => new MemoryStore({ now: clock.now }));

describe('MemoryStore serialisation', () => {
  it('round-trips the full state through toJSON and fromJSON', async () => {
    const clock = createClock();
    const store = new MemoryStore({ now: clock.now });
    const { meta, player } = await populateAll(store, clock.now());

    const data = store.toJSON();
    expect(data.rateLimits).toHaveLength(1);
    const copy = MemoryStore.fromJSON(JSON.parse(JSON.stringify(data)), { now: clock.now });

    expect(copy.toJSON()).toEqual(data);
    expect(await copy.getSession(meta.sessionId)).toEqual(meta);
    expect(await copy.getPlayer(meta.sessionId, player.playerId)).toEqual(player);
    expect(await copy.getSessionIdByPin(meta.pin)).toBe(meta.sessionId);
    expect(await copy.listQuestionResults(meta.sessionId)).toHaveLength(7);
    expect(await copy.listResponses(meta.sessionId, 0)).toHaveLength(2);
    expect(await copy.listConnections(meta.sessionId)).toHaveLength(1);
  });

  it('keeps rate-limit windows across a reload', async () => {
    const clock = createClock();
    const store = new MemoryStore({ now: clock.now });
    const t = clock.now();
    expect(await store.hitRateLimit('k', 2, 10_000, t)).toBe(true);
    expect(await store.hitRateLimit('k', 2, 10_000, t)).toBe(true);
    const copy = MemoryStore.fromJSON(store.toJSON(), { now: clock.now });
    expect(await copy.hitRateLimit('k', 2, 10_000, t)).toBe(false);
  });

  it('keeps expiry times, so a reloaded store still hides expired records', async () => {
    const clock = createClock();
    const store = new MemoryStore({ now: clock.now });
    const meta = makeMeta({ expiresAt: clock.now() + DAY_MS });
    await store.createSession(meta, makeSnapshot(meta.quizId));
    const copy = MemoryStore.fromJSON(store.toJSON(), { now: clock.now });
    clock.set(meta.expiresAt);
    expect(await copy.getSession(meta.sessionId)).toBeNull();
  });

  it('does not alias the data it was loaded from', async () => {
    const clock = createClock();
    const store = new MemoryStore({ now: clock.now });
    const { meta } = await populateAll(store, clock.now());
    const data = store.toJSON();
    const copy = MemoryStore.fromJSON(data, { now: clock.now });
    data.sessions[0]!.meta!.value.skipped.push(42);
    expect((await copy.getSession(meta.sessionId))?.skipped).toEqual(meta.skipped);
    data.sessions.length = 0;
    expect(await copy.getSession(meta.sessionId)).toEqual(meta);
  });

  it('returns a snapshot that later writes do not change', async () => {
    const store = new MemoryStore();
    const data = store.toJSON();
    await store.putQuiz(makeQuiz('owner'));
    expect(data.quizzes).toEqual([]);
  });

  it('rejects data of an unknown format', () => {
    expect(() => MemoryStore.fromJSON({ format: 2 } as never)).toThrow(/format/);
  });

  it('serialises an empty store', () => {
    const data = new MemoryStore().toJSON();
    expect(data).toEqual({ format: 1, quizzes: [], pins: [], sessions: [], rateLimits: [] });
    expect(MemoryStore.fromJSON(data).toJSON()).toEqual(data);
  });
});

describe('MemoryStore clock', () => {
  it('defaults to Date.now', async () => {
    const store = new MemoryStore();
    const now = Date.now();
    expect(await store.reservePin('p', 's', now + 60_000)).toBe(true);
    expect(await store.reservePin('q', 's', now - 1)).toBe(true);
    expect(await store.getSessionIdByPin('p')).toBe('s');
    expect(await store.getSessionIdByPin('q')).toBeNull();
  });

  it('treats a record as expired exactly at its expiresAt', async () => {
    const clock = createClock();
    const store = new MemoryStore({ now: clock.now });
    await store.reservePin('p', 's', CLOCK_START + 500);
    clock.set(CLOCK_START + 499);
    expect(await store.getSessionIdByPin('p')).toBe('s');
    clock.set(CLOCK_START + 500);
    expect(await store.getSessionIdByPin('p')).toBeNull();
  });

  it('treats an expired rate-limit window as absent', async () => {
    const clock = createClock();
    const store = new MemoryStore({ now: clock.now });
    const t = clock.now();
    expect(await store.hitRateLimit('k', 1, 10_000, t)).toBe(true);
    expect(await store.hitRateLimit('k', 1, 10_000, t)).toBe(false);
    clock.set(t + 10_000 + 60_000);
    expect(await store.hitRateLimit('k', 1, 10_000, t)).toBe(true);
  });
});
