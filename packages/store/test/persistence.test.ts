import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore, attachFilePersistence, loadMemoryStore } from '../src/index.ts';
import { onMutation } from '../src/memory.ts';
import { DAY_MS, createClock, makeConnection, makePlayer, makeQuiz, uid } from './fixtures.ts';
import { populateAll, populateSession } from './populate.ts';

/**
 * Wraps the fs calls of the atomic write so a test can see their order and make them fail at
 * chosen points, which is how a crash between the steps is simulated.
 */
const fsState = vi.hoisted(() => ({
  events: [] as string[],
  written: 0,
  beforeRename: undefined as undefined | (() => void),
  failRename: false,
  failWrite: false,
  failDirectorySync: false,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const base = (path: string) => path.slice(path.lastIndexOf('/') + 1);
  return {
    ...actual,
    open: async (path: string, flags: string, mode?: number) => {
      const handle = await actual.open(path, flags, mode);
      fsState.events.push(`open ${base(path)}`);
      // The directory handle is the last one a write closes, so its close ends the write.
      const endsWrite = flags === 'r';
      return new Proxy(handle, {
        get(target, prop) {
          const value: unknown = Reflect.get(target, prop, target);
          if (typeof value !== 'function') return value;
          return async (...args: unknown[]) => {
            if (prop === 'writeFile' && fsState.failWrite) {
              await value.call(target, String(args[0]).slice(0, 20));
              throw new Error('disk full');
            }
            if (prop === 'writeFile' || prop === 'sync' || prop === 'close') {
              fsState.events.push(String(prop));
            }
            if (prop === 'sync' && endsWrite && fsState.failDirectorySync) {
              throw new Error('EINVAL: cannot fsync a directory here');
            }
            const result: unknown = await value.apply(target, args);
            if (prop === 'close' && endsWrite) fsState.written++;
            return result;
          };
        },
      });
    },
    rename: async (from: string, to: string) => {
      fsState.events.push(`rename ${base(from)} ${base(to)}`);
      fsState.beforeRename?.();
      if (fsState.failRename) throw new Error('simulated crash before rename');
      await actual.rename(from, to);
    },
  };
});

/** Completed writes, counted once the directory fsync after the rename is done. */
const writes = () => fsState.written;

/** Lets real fs work finish while timers are faked. */
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not reached within 10 s');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zqhoot-store-'));
  file = join(dir, 'state.json');
  fsState.events.length = 0;
  fsState.written = 0;
  fsState.beforeRename = undefined;
  fsState.failRename = false;
  fsState.failWrite = false;
  fsState.failDirectorySync = false;
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const readState = () => JSON.parse(readFileSync(file, 'utf8')) as unknown;
const quizzes = (n: number) => Array.from({ length: n }, () => makeQuiz('owner'));

describe('attachFilePersistence', () => {
  describe('debouncing', () => {
    beforeEach(() => {
      // Only timers are faked: the fs calls are real and finish on their own.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });

    it('turns many mutations into one write after the delay', async () => {
      const store = new MemoryStore();
      attachFilePersistence(store, file, { debounceMs: 1000 });
      for (const quiz of quizzes(10)) await store.putQuiz(quiz);
      await vi.advanceTimersByTimeAsync(999);
      expect(fsState.events).toEqual([]);
      expect(existsSync(file)).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await until(() => writes() === 1);
      expect(readState()).toEqual(store.toJSON());
      await vi.advanceTimersByTimeAsync(10_000);
      expect(writes()).toBe(1);
    });

    it('does not postpone the write when further mutations arrive', async () => {
      const store = new MemoryStore();
      attachFilePersistence(store, file, { debounceMs: 1000 });
      const [first, second] = quizzes(2);
      await store.putQuiz(first!);
      await vi.advanceTimersByTimeAsync(900);
      await store.putQuiz(second!);
      await vi.advanceTimersByTimeAsync(100);
      await until(() => writes() === 1);
      expect(readState()).toEqual(store.toJSON());
    });

    it('writes nothing until something changes', async () => {
      const store = new MemoryStore();
      attachFilePersistence(store, file, { debounceMs: 1000 });
      await store.getQuiz('o', 'q');
      await vi.advanceTimersByTimeAsync(5000);
      expect(fsState.events).toEqual([]);
    });

    it('saves again after a mutation that lands while a write is running', async () => {
      const store = new MemoryStore();
      attachFilePersistence(store, file, { debounceMs: 1000 });
      const [first, second] = quizzes(2);
      fsState.beforeRename = () => {
        fsState.beforeRename = undefined;
        void store.putQuiz(second!);
      };
      await store.putQuiz(first!);
      await vi.advanceTimersByTimeAsync(1000);
      await until(() => writes() === 1);
      await vi.advanceTimersByTimeAsync(1000);
      await until(() => writes() === 2);
      expect(readState()).toEqual(store.toJSON());
    });

    it('reports a failed background write and saves on the next mutation', async () => {
      const store = new MemoryStore();
      const onError = vi.fn();
      attachFilePersistence(store, file, { debounceMs: 1000, onError });
      const [first, second] = quizzes(2);
      fsState.failRename = true;
      await store.putQuiz(first!);
      await vi.advanceTimersByTimeAsync(1000);
      await until(() => onError.mock.calls.length === 1);
      expect(String(onError.mock.calls[0]?.[0])).toContain('simulated crash');
      fsState.failRename = false;
      await store.putQuiz(second!);
      await vi.advanceTimersByTimeAsync(1000);
      await until(() => existsSync(file));
      expect(readState()).toEqual(store.toJSON());
    });
  });

  describe('flush and close', () => {
    it('flush writes immediately, without waiting for the delay', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const store = new MemoryStore();
      const persistence = attachFilePersistence(store, file, { debounceMs: 60_000 });
      await store.putQuiz(makeQuiz('owner'));
      expect(existsSync(file)).toBe(false);
      await persistence.flush();
      expect(readState()).toEqual(store.toJSON());
      expect(vi.getTimerCount()).toBe(0);
    });

    it('serialises without the deep clone that toJSON makes', async () => {
      const clock = createClock();
      const store = new MemoryStore({ now: clock.now });
      await populateAll(store, clock.now());
      const expected = JSON.stringify(store.toJSON());
      const toJSON = vi.spyOn(store, 'toJSON');
      const clone = vi.spyOn(globalThis, 'structuredClone');
      const persistence = attachFilePersistence(store, file, { debounceMs: 60_000 });
      await persistence.flush();
      expect(toJSON).not.toHaveBeenCalled();
      expect(clone).not.toHaveBeenCalled();
      expect(readFileSync(file, 'utf8')).toBe(expected);
    });

    it('flush writes an unchanged store too, so the file exists after shutdown', async () => {
      const persistence = attachFilePersistence(new MemoryStore(), file);
      await persistence.flush();
      expect(readState()).toEqual(new MemoryStore().toJSON());
    });

    it('flush waits for a write already in flight, then writes the latest state', async () => {
      const store = new MemoryStore();
      const persistence = attachFilePersistence(store, file, { debounceMs: 60_000 });
      const [first, second] = quizzes(2);
      await store.putQuiz(first!);
      const early = persistence.flush();
      await store.putQuiz(second!);
      await Promise.all([early, persistence.flush()]);
      expect(readState()).toEqual(store.toJSON());
      expect((readState() as { quizzes: unknown[] }).quizzes).toHaveLength(2);
    });

    it('close writes pending changes and stops listening', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const store = new MemoryStore();
      const persistence = attachFilePersistence(store, file, { debounceMs: 1000 });
      await store.putQuiz(makeQuiz('owner'));
      await persistence.close();
      expect(readState()).toEqual(store.toJSON());
      const before = writes();

      await store.putQuiz(makeQuiz('owner'));
      await vi.advanceTimersByTimeAsync(10_000);
      await persistence.flush();
      await persistence.close();
      expect(writes()).toBe(before);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('creates missing parent directories', async () => {
      const nested = join(dir, 'a', 'b', 'state.json');
      const persistence = attachFilePersistence(new MemoryStore(), nested);
      await persistence.flush();
      expect(existsSync(nested)).toBe(true);
    });

    it('rejects flush when the write fails, and works again afterwards', async () => {
      const store = new MemoryStore();
      const persistence = attachFilePersistence(store, file, { debounceMs: 60_000 });
      await store.putQuiz(makeQuiz('owner'));
      fsState.failRename = true;
      await expect(persistence.flush()).rejects.toThrow('simulated crash');
      fsState.failRename = false;
      await persistence.flush();
      expect(readState()).toEqual(store.toJSON());
    });
  });

  describe('atomic write', () => {
    it('goes through a temp file: write, fsync, close, then rename over the target', async () => {
      const store = new MemoryStore();
      const persistence = attachFilePersistence(store, file, { debounceMs: 60_000 });
      await store.putQuiz(makeQuiz('owner'));
      await persistence.flush();
      expect(fsState.events).toEqual([
        'open state.json.tmp',
        'writeFile',
        'sync',
        'close',
        'rename state.json.tmp state.json',
        // The rename is not durable until the directory entry is synced too.
        `open ${basename(dir)}`,
        'sync',
        'close',
      ]);
      expect(existsSync(`${file}.tmp`)).toBe(false);
    });

    it.skipIf(process.platform === 'win32')(
      'keeps the state readable by its owner only, since it holds answers and token hashes',
      async () => {
        const persistence = attachFilePersistence(new MemoryStore(), file);
        await persistence.flush();
        expect(statSync(file).mode & 0o777).toBe(0o600);
        await persistence.flush();
        expect(statSync(file).mode & 0o777).toBe(0o600);
      },
    );

    it('still succeeds when the directory cannot be synced', async () => {
      const store = new MemoryStore();
      const persistence = attachFilePersistence(store, file, { debounceMs: 60_000 });
      await store.putQuiz(makeQuiz('owner'));
      fsState.failDirectorySync = true;
      await persistence.flush();
      expect(readState()).toEqual(store.toJSON());
    });

    it('leaves the previous complete file in place until the rename', async () => {
      const store = new MemoryStore();
      const persistence = attachFilePersistence(store, file, { debounceMs: 60_000 });
      await store.putQuiz(makeQuiz('owner'));
      await persistence.flush();
      const before = store.toJSON();

      await store.putQuiz(makeQuiz('owner'));
      let seen: { target: unknown; temp: unknown } | undefined;
      fsState.beforeRename = () => {
        seen = {
          target: JSON.parse(readFileSync(file, 'utf8')),
          temp: JSON.parse(readFileSync(`${file}.tmp`, 'utf8')),
        };
      };
      await persistence.flush();
      expect(seen?.target).toEqual(before);
      expect(seen?.temp).toEqual(store.toJSON());
      expect(readState()).toEqual(store.toJSON());
    });

    it('survives a crash before the rename: the last complete state still loads', async () => {
      const store = new MemoryStore();
      const persistence = attachFilePersistence(store, file, { debounceMs: 60_000 });
      await store.putQuiz(makeQuiz('owner'));
      await persistence.flush();
      const before = store.toJSON();

      await store.putQuiz(makeQuiz('owner'));
      fsState.failRename = true;
      await expect(persistence.flush()).rejects.toThrow();
      expect(loadMemoryStore(file).toJSON()).toEqual(before);
    });

    it('survives a crash in the middle of writing: the target is untouched and no temp file stays', async () => {
      const store = new MemoryStore();
      const persistence = attachFilePersistence(store, file, { debounceMs: 60_000 });
      await store.putQuiz(makeQuiz('owner'));
      await persistence.flush();
      const before = store.toJSON();

      await store.putQuiz(makeQuiz('owner'));
      fsState.failWrite = true;
      await expect(persistence.flush()).rejects.toThrow('disk full');
      expect(readState()).toEqual(before);
      expect(existsSync(`${file}.tmp`)).toBe(false);
    });
  });
});

describe('loadMemoryStore', () => {
  it('returns an empty store when the file does not exist', () => {
    const store = loadMemoryStore(join(dir, 'missing.json'));
    expect(store.toJSON()).toEqual(new MemoryStore().toJSON());
  });

  it('reloads equal state, including rate-limit windows and expiry', async () => {
    const clock = createClock();
    const store = new MemoryStore({ now: clock.now });
    const session = await populateAll(store, clock.now());
    const persistence = attachFilePersistence(store, file);
    await persistence.flush();

    const loaded = loadMemoryStore(file, { now: clock.now });
    expect(loaded.toJSON()).toEqual(store.toJSON());
    expect(loaded.toJSON().rateLimits).toHaveLength(1);
    expect(await loaded.getSession(session.sessionId)).toEqual(session.meta);
    expect(await loaded.getPlayer(session.sessionId, session.player.playerId)).toEqual(
      session.player,
    );
    expect(await loaded.getConnection(session.conn.connectionId)).toEqual(session.conn);
    expect(await loaded.listResponses(session.sessionId, 0)).toHaveLength(2);
    expect(await loaded.getSessionIdByPin(session.meta.pin)).toBe(session.sessionId);

    clock.set(session.meta.expiresAt);
    expect(await loaded.getSession(session.sessionId)).toBeNull();
  });

  it('uses the clock it is given', async () => {
    const clock = createClock();
    const store = new MemoryStore({ now: clock.now });
    await store.reservePin('p', 's', clock.now() + 1000);
    await attachFilePersistence(store, file).flush();
    const later = loadMemoryStore(file, { now: () => clock.now() + 1000 });
    expect(await later.getSessionIdByPin('p')).toBeNull();
  });

  it('refuses a corrupt file instead of silently starting empty', () => {
    writeFileSync(file, '{"format":1,"quizzes":[');
    expect(() => loadMemoryStore(file)).toThrow(/not valid JSON/);
  });

  it('refuses a file of an unknown format', () => {
    writeFileSync(file, '{"format":99}');
    expect(() => loadMemoryStore(file)).toThrow(/format/);
  });
});

describe('sweepExpired', () => {
  const HOUR = 3_600_000;

  async function twoSessions(store: MemoryStore, now: number) {
    // The short session's dependents outlive it, to show they go with it anyway.
    const short = await populateSession(store, {
      now,
      sessionExpiresAt: now + HOUR,
      dependentsExpireAt: now + 5 * HOUR,
    });
    const long = await populateSession(store, {
      now,
      sessionExpiresAt: now + 30 * DAY_MS,
      dependentsExpireAt: now + 30 * DAY_MS,
    });
    return { short, long };
  }

  it('removes an expired session with everything that depends on it', async () => {
    const clock = createClock();
    const store = new MemoryStore({ now: clock.now });
    const { short, long } = await twoSessions(store, clock.now());
    await store.hitRateLimit('old', 5, 10_000, clock.now());
    const keptSession = structuredClone(
      store.toJSON().sessions.find((s) => s.sessionId === long.sessionId),
    );

    clock.set(short.meta.expiresAt);
    store.sweepExpired();

    const data = store.toJSON();
    expect(data.sessions.map((s) => s.sessionId)).toEqual([long.sessionId]);
    expect(data.sessions[0]).toEqual(keptSession);
    expect(data.pins.map((p) => p.sessionId)).toEqual([long.sessionId]);
    // Everything of the short session is physically gone, not merely hidden.
    expect(JSON.stringify(data)).not.toContain(short.sessionId);
    expect(JSON.stringify(data)).not.toContain(short.conn.connectionId);
    expect(await store.getConnection(short.conn.connectionId)).toBeNull();
    expect(await store.getSession(long.sessionId)).toEqual(long.meta);
    expect(await store.listResponses(long.sessionId, 0)).toHaveLength(2);
  });

  it('removes expired rate-limit windows', async () => {
    const clock = createClock();
    const store = new MemoryStore({ now: clock.now });
    await store.hitRateLimit('k', 5, 10_000, clock.now());
    clock.set(clock.now() + 10_000 + 59_999);
    store.sweepExpired();
    expect(store.toJSON().rateLimits).toHaveLength(1);
    clock.set(clock.now() + 1);
    store.sweepExpired();
    expect(store.toJSON().rateLimits).toEqual([]);
  });

  it('removes records that expire before their session', async () => {
    const clock = createClock();
    const store = new MemoryStore({ now: clock.now });
    const session = await populateSession(store, {
      now: clock.now(),
      sessionExpiresAt: clock.now() + 30 * DAY_MS,
      dependentsExpireAt: clock.now() + HOUR,
    });
    clock.set(clock.now() + HOUR);
    store.sweepExpired();
    const [bucket] = store.toJSON().sessions;
    expect(bucket?.meta?.value.sessionId).toBe(session.sessionId);
    expect(bucket).toMatchObject({
      players: [],
      nicknames: [],
      connections: [],
      responses: [],
      results: [],
    });
    expect(bucket).not.toHaveProperty('scoreboard');
    expect(await store.getConnection(session.conn.connectionId)).toBeNull();
  });

  it('drops a session that never had meta once its records have expired', async () => {
    const clock = createClock();
    const store = new MemoryStore({ now: clock.now });
    await store.addPlayer(makePlayer('orphan'), clock.now() + HOUR);
    await store.putConnection(makeConnection('orphan', { expiresAt: clock.now() + HOUR }));
    clock.set(clock.now() + HOUR);
    store.sweepExpired();
    expect(store.toJSON().sessions).toEqual([]);
  });

  it('removes an expired PIN claim that has no session', async () => {
    const clock = createClock();
    const store = new MemoryStore({ now: clock.now });
    await store.reservePin(uid('pin'), 'ghost', clock.now() + HOUR);
    clock.set(clock.now() + HOUR);
    store.sweepExpired();
    expect(store.toJSON().pins).toEqual([]);
  });

  it('keeps quizzes, which never expire', async () => {
    const clock = createClock();
    const store = new MemoryStore({ now: clock.now });
    const quiz = makeQuiz('owner');
    await store.putQuiz(quiz);
    clock.set(clock.now() + 3650 * DAY_MS);
    store.sweepExpired();
    expect(await store.getQuiz('owner', quiz.id)).toEqual(quiz);
  });

  it('lets an expired session id be created again', async () => {
    const clock = createClock();
    const store = new MemoryStore({ now: clock.now });
    const { short } = await twoSessions(store, clock.now());
    clock.set(short.meta.expiresAt);
    const reborn = { ...short.meta, expiresAt: clock.now() + HOUR, version: 0 };
    await store.createSession(reborn, {
      quizId: reborn.quizId,
      title: 't',
      questions: [],
      settings: reborn.settings,
    });
    expect(await store.getSession(short.sessionId)).toEqual(reborn);
    // The expired session's leftovers do not leak into the new one.
    expect(await store.countPlayers(short.sessionId)).toBe(0);
    expect(await store.getConnection(short.conn.connectionId)).toBeNull();
    store.sweepExpired();
    expect(await store.getSession(short.sessionId)).toEqual(reborn);
  });

  it('notifies persistence only when it removed something', async () => {
    const clock = createClock();
    const store = new MemoryStore({ now: clock.now });
    await store.reservePin('p', 's', clock.now() + HOUR);
    const listener = vi.fn();
    onMutation(store, listener);
    store.sweepExpired();
    expect(listener).not.toHaveBeenCalled();
    clock.set(clock.now() + HOUR);
    store.sweepExpired();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('is persisted: a reload after a sweep does not bring the session back', async () => {
    const clock = createClock();
    const store = new MemoryStore({ now: clock.now });
    const { short } = await twoSessions(store, clock.now());
    const persistence = attachFilePersistence(store, file);
    clock.set(short.meta.expiresAt);
    store.sweepExpired();
    await persistence.flush();
    const loaded = loadMemoryStore(file, { now: clock.now });
    expect(loaded.toJSON().sessions).toHaveLength(1);
  });
});
