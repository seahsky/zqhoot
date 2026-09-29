import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LIMITS, ServerMessage } from '@zqhoot/protocol';
import type { OutboundMessage } from '@zqhoot/protocol';
import { MemoryStore } from '@zqhoot/store';
import { exceedsUtf8Bytes, sha256Hex, timingSafeEqualHex } from '../src/crypto.ts';
import { LruCache } from '../src/lru.ts';
import { prepareStamped, stampAndSerialize } from '../src/index.ts';
import { createHarness } from './harness.ts';
import type { Harness } from './harness.ts';
import { choice } from './game.ts';
import { seedSession } from './seed.ts';

const memoryHarness = (opts?: Parameters<typeof createHarness>[2]) =>
  createHarness('memory', (clock) => new MemoryStore({ now: () => clock.now() }), opts);

describe('stampAndSerialize', () => {
  const samples: OutboundMessage[] = [
    { type: 'pong', t: 5 },
    { type: 'kicked' },
    { type: 'error', code: 'bad-request', message: 'with "quotes" and   separators', ref: 'x' },
    {
      type: 'roster',
      upsert: [{ playerId: 'player-0001', nickname: 'Zoë 😀', connected: true }],
      removed: [],
    },
  ];

  it('puts ts first and produces a valid server message', () => {
    for (const message of samples) {
      const wire = stampAndSerialize(message, 1234567);
      expect(wire.startsWith('{"ts":1234567,')).toBe(true);
      const parsed = JSON.parse(wire);
      expect(parsed).toEqual({ ...message, ts: 1234567 });
      expect(ServerMessage.safeParse(parsed).success).toBe(true);
    }
  });

  it('lets a broadcast serialise once and stamp per recipient with identical output', () => {
    for (const message of samples) {
      const stamp = prepareStamped(message);
      for (const ts of [0, 1, 4_102_444_800_123]) {
        expect(stamp(ts)).toBe(stampAndSerialize(message, ts));
      }
      expect(stamp(1)).not.toBe(stamp(2));
    }
  });

  it('refuses a timestamp that would make the frame invalid JSON', () => {
    for (const ts of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => stampAndSerialize({ type: 'kicked' }, ts)).toThrow(RangeError);
    }
  });

  it('stays valid JSON for an object without other keys', () => {
    expect(stampAndSerialize({} as OutboundMessage, 7)).toBe('{"ts":7}');
  });
});

describe('crypto helpers', () => {
  it('hashes with SHA-256 (known vectors)', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    // Non-ASCII input is hashed as UTF-8, like every other implementation of the resume token hash.
    expect(await sha256Hex('é😀')).toBe(createHash('sha256').update('é😀', 'utf8').digest('hex'));
  });

  it('compares equal-length hex strings without short-circuiting', () => {
    const a = 'a'.repeat(64);
    expect(timingSafeEqualHex(a, a)).toBe(true);
    expect(timingSafeEqualHex(a, `${'a'.repeat(63)}b`)).toBe(false);
    expect(timingSafeEqualHex(a, `b${'a'.repeat(63)}`)).toBe(false);
    expect(timingSafeEqualHex(a, 'a'.repeat(63))).toBe(false);
    expect(timingSafeEqualHex('', '')).toBe(true);
  });

  it('counts UTF-8 bytes against a limit', () => {
    const limit = LIMITS.clientMessageMaxBytes;
    expect(exceedsUtf8Bytes('x'.repeat(limit), limit)).toBe(false);
    expect(exceedsUtf8Bytes('x'.repeat(limit + 1), limit)).toBe(true);
    expect(exceedsUtf8Bytes('é'.repeat(limit / 2), limit)).toBe(false);
    expect(exceedsUtf8Bytes('é'.repeat(limit / 2 + 1), limit)).toBe(true);
    expect(exceedsUtf8Bytes('€'.repeat(Math.floor(limit / 3)), limit)).toBe(false);
    expect(exceedsUtf8Bytes('€'.repeat(Math.floor(limit / 3) + 1), limit)).toBe(true);
    expect(exceedsUtf8Bytes('😀'.repeat(limit / 4), limit)).toBe(false);
    expect(exceedsUtf8Bytes('😀'.repeat(limit / 4 + 1), limit)).toBe(true);
  });
});

describe('LruCache', () => {
  it('evicts the least recently used entry', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1); // a is now the most recent
    cache.set('c', 3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
    expect(cache.size).toBe(2);
  });

  it('replaces a value in place and deletes only a matching one', () => {
    const cache = new LruCache<string, object>(2);
    const first = {};
    const second = {};
    cache.set('a', first);
    cache.set('a', second);
    expect(cache.size).toBe(1);
    cache.deleteIf('a', first);
    expect(cache.get('a')).toBe(second);
    cache.deleteIf('a', second);
    expect(cache.get('a')).toBeUndefined();
  });
});

describe('onConnect (ADR-0013 origin check)', () => {
  const allowed = ['https://quiz.example.com', 'https://staging.example.com'];

  it('accepts exactly the configured origins', async () => {
    const h = await memoryHarness({ allowedOrigins: allowed });
    for (const origin of allowed) {
      expect(await h.service.onConnect('c1', { origin, sourceIp: '1.2.3.4' })).toEqual({
        accept: true,
      });
    }
    expect(h.logger.entries.warn).toEqual([]);
  });

  it('rejects everything else, including a missing origin, and logs it', async () => {
    const h = await memoryHarness({ allowedOrigins: allowed });
    const rejected: Array<string | undefined> = [
      undefined,
      '',
      'null',
      'https://evil.example.org',
      'https://quiz.example.com.evil.org',
      'http://quiz.example.com',
      'https://quiz.example.com/',
      'https://QUIZ.example.com',
      'https://quiz.example.com:8443',
    ];
    for (const origin of rejected) {
      expect(
        await h.service.onConnect('c2', {
          ...(origin !== undefined ? { origin } : {}),
          sourceIp: '9.9.9.9',
        }),
        String(origin),
      ).toEqual({ accept: false });
    }
    expect(h.logger.entries.warn).toHaveLength(rejected.length);
    expect(h.logger.entries.warn[0]!.o).toMatchObject({ connectionId: 'c2', sourceIp: '9.9.9.9' });
    expect(h.calls).toEqual([]);
  });

  it('allows any origin when none are configured (tests only)', async () => {
    const h = await memoryHarness({ allowedOrigins: [] });
    expect(await h.service.onConnect('c3', { origin: 'https://anywhere.example' })).toEqual({
      accept: true,
    });
    expect(await h.service.onConnect('c3', {})).toEqual({ accept: true });
  });
});

describe('warm', () => {
  it('opens the store connection with one harmless read', async () => {
    const h = await memoryHarness();
    await h.service.warm();
    expect(h.calls).toEqual(['getSessionIdByPin']);
  });

  it('is best effort: a failing store is logged, not thrown', async () => {
    const h = await memoryHarness();
    h.overrides.getSessionIdByPin = async () => {
      throw new Error('cold store');
    };
    await expect(h.service.warm()).resolves.toBeUndefined();
    expect(h.logger.entries.warn).toHaveLength(1);
  });
});

describe('snapshot cache (ADR-0003: snapshots are immutable)', () => {
  /** A joined player per seeded session, so `answer` can find its binding. */
  async function seededPlayer(h: Harness, n: number) {
    const s = await seedSession(h);
    const connectionId = h.cid(`c${n}`);
    await h.store.putConnection({
      connectionId,
      sessionId: s.sessionId,
      role: 'player',
      playerId: `player-${n}`,
      connectedAt: h.clock.now(),
      expiresAt: h.clock.now() + 3_600_000,
    });
    return { ...s, connectionId };
  }
  const answerOnce = (h: Harness, p: { connectionId: string }) =>
    h.send(
      p.connectionId,
      { type: 'answer', questionIndex: 0, payload: choice('opt-paris') },
      h.clock.now(),
    );
  const snapshotReads = (h: Harness) => h.calls.filter((c) => c === 'getSnapshot').length;

  it('reads a session snapshot once per instance', async () => {
    const h = await memoryHarness();
    const p = await seededPlayer(h, 1);
    h.resetCalls();
    for (let i = 0; i < 5; i++) await answerOnce(h, p);
    expect(snapshotReads(h)).toBe(1);
  });

  it('shares one read between simultaneous answers on a cold instance', async () => {
    const h = await memoryHarness();
    const one = await seededPlayer(h, 0);
    h.resetCalls();
    await Promise.all(Array.from({ length: 30 }, () => answerOnce(h, one)));
    expect(snapshotReads(h)).toBe(1);
  });

  it('keeps 100 snapshots and evicts the least recently used', async () => {
    const h = await memoryHarness();
    const players = [];
    for (let i = 0; i < 101; i++) players.push(await seededPlayer(h, i));
    h.resetCalls();
    for (let i = 0; i < 100; i++) await answerOnce(h, players[i]!);
    expect(snapshotReads(h)).toBe(100);
    // Touch the oldest, then add a 101st: the second oldest is the one that goes.
    await answerOnce(h, players[0]!);
    expect(snapshotReads(h)).toBe(100);
    await answerOnce(h, players[100]!);
    expect(snapshotReads(h)).toBe(101);
    await answerOnce(h, players[0]!);
    expect(snapshotReads(h)).toBe(101);
    await answerOnce(h, players[1]!);
    expect(snapshotReads(h)).toBe(102);
  });

  it('does not cache a missing snapshot or a failed read', async () => {
    const h = await memoryHarness();
    const p = await seededPlayer(h, 1);
    let failures = 1;
    h.overrides.getSnapshot = async (sessionId: string) => {
      if (failures-- > 0) throw new Error('transient');
      return h.real.getSnapshot(sessionId);
    };
    await answerOnce(h, p);
    expect(h.transport.last(p.connectionId, 'error')).toMatchObject({ code: 'internal' });
    await answerOnce(h, p);
    expect(h.transport.last(p.connectionId, 'answer.ack')).toMatchObject({ reason: 'not-open' });
    h.overrides = {};

    const ghost = h.cid('ghost');
    await h.store.putConnection({
      connectionId: ghost,
      sessionId: 'session-without-snapshot',
      role: 'player',
      playerId: 'player-x',
      connectedAt: h.clock.now(),
      expiresAt: h.clock.now() + 1000,
    });
    await answerOnce(h, { connectionId: ghost });
    expect(h.transport.last(ghost, 'error')).toMatchObject({ code: 'not-found' });
  });
});
