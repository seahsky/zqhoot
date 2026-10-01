import { describe, expect, it } from 'vitest';
import { describeWithStores } from './harness.ts';
import type { Harness } from './harness.ts';
import { startGame } from './game.ts';
import { seedSession } from './seed.ts';

const MISSES_ALLOWED = 30;

describeWithStores('admission: the failed-PIN budget and the player cap', (make) => {
  /** One join on a connection of its own, as a phone opening a new socket would send it. */
  async function joinOnce(
    h: Harness,
    name: string,
    pin: string,
    opts: { nickname?: string; ip?: string | null } = {},
  ): Promise<string> {
    const id = h.cid(name);
    await h.send(
      id,
      { type: 'join', v: 1, pin, nickname: opts.nickname ?? 'Ann' },
      undefined,
      opts.ip,
    );
    return id;
  }
  const errorOf = (h: Harness, id: string) => h.transport.last(id, 'error');
  const welcomed = (h: Harness, id: string) => h.transport.ofType(id, 'welcome').length > 0;

  /** Misses from `ip` until the budget is spent: the last one that still gets `not-found`. */
  async function spendBudget(h: Harness, ip: string | null, via: 'ws' | 'http' = 'ws') {
    for (let i = 0; i < MISSES_ALLOWED; i++) {
      if (via === 'http') {
        const res = await h.api('GET', '/api/join/000000', { ip: ip ?? 'unknown' });
        expect(res.status, `miss ${i + 1}`).toBe(404);
      } else {
        const id = await joinOnce(h, `spend-${i}`, '000000', { ip });
        expect(errorOf(h, id).code, `miss ${i + 1}`).toBe('not-found');
      }
    }
  }

  describe('failed PIN lookups over the WebSocket (ADR-0013)', () => {
    it('refuses the 31st miss from one IP, on a connection of its own each time', async () => {
      const h = await make();
      const ip = `${h.nonce}-scanner`;
      await spendBudget(h, ip);
      const id = await joinOnce(h, 'miss-31', '000000', { ip });
      expect(errorOf(h, id)).toMatchObject({ code: 'rate-limited', ref: 'join' });
      // Unlike the per-connection nickname limit, this refusal leaves the connection open.
      expect(h.transport.closed(id)).toBe(false);
    });

    it('refuses a valid PIN from a blocked IP before looking it up, so it cannot tell live from dead', async () => {
      const h = await make();
      const g = await startGame(h);
      const ip = `${h.nonce}-scanner`;
      await spendBudget(h, ip);
      expect(errorOf(h, await joinOnce(h, 'over', '000000', { ip })).code).toBe('rate-limited');

      h.resetCalls();
      const live = await joinOnce(h, 'live', g.pin, { ip });
      expect(errorOf(h, live)).toMatchObject({ code: 'rate-limited', ref: 'join' });
      expect(welcomed(h, live)).toBe(false);
      expect(h.calls).not.toContain('getSessionIdByPin');
      expect(await h.store.countPlayers(g.sessionId)).toBe(0);
      expect(await h.store.getConnection(h.cid('live'))).toBeNull();
      // A dead PIN gets the very same answer.
      const dead = await joinOnce(h, 'dead', '000001', { ip });
      expect(errorOf(h, dead).code).toBe('rate-limited');
    });

    it('leaves other IPs alone, and frees the blocked one when the window ends', async () => {
      const h = await make();
      const g = await startGame(h);
      const ip = `${h.nonce}-scanner`;
      await spendBudget(h, ip);
      await joinOnce(h, 'over', '000000', { ip });

      const other = await joinOnce(h, 'other', g.pin, { ip: `${h.nonce}-classmate` });
      expect(welcomed(h, other)).toBe(true);
      const stillBlocked = await joinOnce(h, 'blocked', g.pin, { ip });
      expect(errorOf(h, stillBlocked).code).toBe('rate-limited');

      h.clock.advance(60_000);
      const later = await joinOnce(h, 'later', g.pin, { ip, nickname: 'Later' });
      expect(welcomed(h, later)).toBe(true);
    });

    it('shares one budget with GET /api/join/:pin, in both directions', async () => {
      const h = await make();
      const g = await startGame(h);

      // HTTP misses count against the WebSocket join.
      const first = `${h.nonce}-http-first`;
      for (let i = 0; i < 20; i++) {
        expect((await h.api('GET', '/api/join/000000', { ip: first })).status).toBe(404);
      }
      for (let i = 0; i < 10; i++) {
        const id = await joinOnce(h, `mixed-a-${i}`, '000000', { ip: first });
        expect(errorOf(h, id).code, `ws miss ${i + 1}`).toBe('not-found');
      }
      expect(errorOf(h, await joinOnce(h, 'mixed-a-x', '000000', { ip: first })).code).toBe(
        'rate-limited',
      );
      expect((await h.api('GET', `/api/join/${g.pin}`, { ip: first })).status).toBe(429);

      // And the other way round.
      const second = `${h.nonce}-ws-first`;
      for (let i = 0; i < 20; i++) {
        const id = await joinOnce(h, `mixed-b-${i}`, '000000', { ip: second });
        expect(errorOf(h, id).code).toBe('not-found');
      }
      for (let i = 0; i < 10; i++) {
        expect((await h.api('GET', '/api/join/000000', { ip: second })).status).toBe(404);
      }
      expect((await h.api('GET', '/api/join/000000', { ip: second })).status).toBe(429);
      expect(errorOf(h, await joinOnce(h, 'mixed-b-x', g.pin, { ip: second })).code).toBe(
        'rate-limited',
      );
    });

    it('keeps the budget in the store, under the counter the HTTP app reads', async () => {
      const h = await make();
      const ip = `${h.nonce}-scanner`;
      await spendBudget(h, ip);
      expect(await h.real.peekRateLimit(`pin:${ip}`, 30, 60_000, h.clock.now())).toBe(true);
      await joinOnce(h, 'over', '000000', { ip });
      expect(await h.real.peekRateLimit(`pin:${ip}`, 30, 60_000, h.clock.now())).toBe(false);
    });

    it('never limits a classroom of valid joins from one IP', async () => {
      const h = await make();
      const g = await startGame(h);
      const ip = `${h.nonce}-classroom`;
      for (let i = 0; i < 60; i++) {
        const id = await joinOnce(h, `kid-${i}`, g.pin, { ip, nickname: `Kid ${i}` });
        expect(welcomed(h, id), `join ${i + 1}`).toBe(true);
      }
      expect(await h.store.countPlayers(g.sessionId)).toBe(60);
      // The whole budget is still there for that IP.
      await spendBudget(h, ip);
      expect(errorOf(h, await joinOnce(h, 'typo', '000000', { ip })).code).toBe('rate-limited');
    });

    it('spends nothing on a PIN that exists, whatever the session says about it', async () => {
      const h = await make();
      const locked = await startGame(h);
      await h.send(locked.control, { type: 'host.lock', locked: true });
      const ended = await seedSession(h, { patch: { phase: 'ended', endedAt: h.clock.now() } });
      const full = await seedSession(h, { maxPlayers: 1 });
      const ip = `${h.nonce}-keen`;
      expect(welcomed(h, await joinOnce(h, 'seat', full.pin, { ip, nickname: 'Solo' }))).toBe(true);

      for (let i = 0; i < 15; i++) {
        const cases = [
          [locked.pin, 'session-locked'],
          [ended.pin, 'session-ended'],
          [full.pin, 'session-full'],
        ] as const;
        for (const [pin, code] of cases) {
          expect(errorOf(h, await joinOnce(h, `${code}-${i}`, pin, { ip })).code).toBe(code);
        }
      }
      await spendBudget(h, ip);
    });

    it('keys an address the adapter could not read as "unknown", like the HTTP app', async () => {
      const h = await make();
      // The window is shared by every caller of that key in this table, so use one of our own.
      h.clock.advance(60_000 * (1 + Math.floor(Math.random() * 100_000)));
      await spendBudget(h, null);
      expect(errorOf(h, await joinOnce(h, 'anon', '000000', { ip: null })).code).toBe(
        'rate-limited',
      );
      expect(await h.real.peekRateLimit('pin:unknown', 30, 60_000, h.clock.now())).toBe(false);
      // A caller with an address is not held to that budget.
      const known = await joinOnce(h, 'known', '000000', { ip: `${h.nonce}-known` });
      expect(errorOf(h, known).code).toBe('not-found');
    });

    it('does not count the connection-level nickname attempts as PIN misses', async () => {
      const h = await make();
      const g = await startGame(h);
      const ip = `${h.nonce}-typist`;
      const id = h.cid('typist');
      for (let i = 0; i < 5; i++) {
        await h.send(id, { type: 'join', v: 1, pin: g.pin, nickname: 'x' }, undefined, ip);
        expect(errorOf(h, id).code).toBe('nickname-invalid');
      }
      await spendBudget(h, ip);
    });
  });

  describe('the player cap under concurrency', () => {
    const nickname = (i: number) => `Kid ${String.fromCharCode(65 + i)}`;

    it('admits exactly maxPlayers of a burst of joins and refuses the rest as full', async () => {
      const h = await make();
      const tiny = await seedSession(h, { maxPlayers: 5 });
      const ids = Array.from({ length: 14 }, (_, i) => h.cid(`burst-${i}`));
      await Promise.all(
        ids.map((id, i) =>
          h.send(id, { type: 'join', v: 1, pin: tiny.pin, nickname: nickname(i) }),
        ),
      );

      const admitted = ids.filter((id) => welcomed(h, id));
      const refused = ids.filter((id) => !welcomed(h, id));
      expect(admitted).toHaveLength(5);
      expect(refused).toHaveLength(9);
      for (const id of refused) {
        expect(errorOf(h, id)).toMatchObject({ code: 'session-full', ref: 'join' });
        expect(await h.store.getConnection(id)).toBeNull();
      }
      expect(await h.store.countPlayers(tiny.sessionId)).toBe(5);
      expect(await h.store.listConnections(tiny.sessionId)).toHaveLength(5);
    });

    it('keeps the cap when the burst arrives in waves, and when nothing is left afterwards', async () => {
      const h = await make();
      const tiny = await seedSession(h, { maxPlayers: 6 });
      for (let wave = 0; wave < 3; wave++) {
        await Promise.all(
          Array.from({ length: 4 }, (_, i) =>
            h.send(h.cid(`wave-${wave}-${i}`), {
              type: 'join',
              v: 1,
              pin: tiny.pin,
              nickname: nickname(wave * 4 + i),
            }),
          ),
        );
      }
      expect(await h.store.countPlayers(tiny.sessionId)).toBe(6);
      const late = await joinOnce(h, 'late', tiny.pin, { nickname: 'Latecomer' });
      expect(errorOf(h, late).code).toBe('session-full');
    });

    it('does not use up a seat on a nickname that is taken', async () => {
      const h = await make();
      const tiny = await seedSession(h, { maxPlayers: 3 });
      expect(welcomed(h, await joinOnce(h, 'ann', tiny.pin, { nickname: 'Ann' }))).toBe(true);
      for (let i = 0; i < 5; i++) {
        const dup = await joinOnce(h, `dup-${i}`, tiny.pin, { nickname: 'Ann' });
        expect(errorOf(h, dup).code).toBe('nickname-taken');
      }
      expect(welcomed(h, await joinOnce(h, 'bob', tiny.pin, { nickname: 'Bob' }))).toBe(true);
      expect(welcomed(h, await joinOnce(h, 'cy', tiny.pin, { nickname: 'Cy' }))).toBe(true);
      expect(await h.store.countPlayers(tiny.sessionId)).toBe(3);
      const extra = await joinOnce(h, 'extra', tiny.pin, { nickname: 'Extra' });
      expect(errorOf(h, extra).code).toBe('session-full');
    });

    it('adds one write to a join that is admitted, and none to one that is refused early', async () => {
      const h = await make();
      const tiny = await seedSession(h, { maxPlayers: 1 });
      h.resetCalls();
      await joinOnce(h, 'first', tiny.pin, { nickname: 'First' });
      expect(h.calls.filter((c) => c === 'addPlayer')).toHaveLength(1);
      h.resetCalls();
      await joinOnce(h, 'second', tiny.pin, { nickname: 'Second' });
      expect(h.calls).not.toContain('addPlayer');
    });
  });
});
