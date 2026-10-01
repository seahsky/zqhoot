import { describe, expect, it } from 'vitest';
import { ErrorCode, LIMITS } from '@zqhoot/protocol';
import type { ClientMessage } from '@zqhoot/protocol';
import { ConflictError } from '@zqhoot/store';
import { CLOSE_CODES } from '../src/index.ts';
import { describeWithStores } from './harness.ts';
import type { Harness } from './harness.ts';
import { choice, startGame } from './game.ts';
import { seedSession } from './seed.ts';

describeWithStores('error handling', (make) => {
  /** Every ErrorCode the service can raise must show up in this suite (checked by the last test). */
  const seen = new Set<string>();
  const expectError = (h: Harness, connectionId: string, code: string, message?: string) => {
    const error = h.transport.last(connectionId, 'error');
    expect(error.code).toBe(code);
    if (message !== undefined) expect(error.message).toBe(message);
    seen.add(code);
    return error;
  };
  const connect = async (h: Harness, name: string) => {
    const id = h.cid(name);
    await h.service.onConnect(id, {});
    return id;
  };
  const sendRaw = (h: Harness, id: string, raw: string) =>
    h.service.onMessage(id, raw, h.clock.now());

  describe('frames', () => {
    it('refuses frames over the byte limit without touching the store', async () => {
      const h = await make();
      const id = await connect(h, 'big');
      await sendRaw(h, id, JSON.stringify({ type: 'ping', t: 1, pad: 'x'.repeat(5000) }));
      expectError(h, id, 'bad-request', 'message too large');
      expect(h.calls).toEqual([]);
    });

    it('counts UTF-8 bytes, not characters', async () => {
      const h = await make();
      const id = await connect(h, 'utf8');
      const frame = (pad: string) => JSON.stringify({ type: 'ping', t: 1, pad });
      // Exactly at the limit is fine; two-byte characters that fit in code units but not in bytes are not.
      const overhead = new TextEncoder().encode(frame('')).length;
      await sendRaw(h, id, frame('x'.repeat(LIMITS.clientMessageMaxBytes - overhead)));
      expect(h.transport.last(id, 'pong').t).toBe(1);
      await sendRaw(h, id, frame('é'.repeat(LIMITS.clientMessageMaxBytes / 2)));
      expectError(h, id, 'bad-request', 'message too large');
      await sendRaw(h, id, frame('x'.repeat(LIMITS.clientMessageMaxBytes - overhead + 1)));
      expectError(h, id, 'bad-request', 'message too large');
    });

    it('answers bad JSON and schema violations with bad-request and the message type as ref', async () => {
      const h = await make();
      const id = await connect(h, 'bad');
      await sendRaw(h, id, 'this is not json');
      expect(expectError(h, id, 'bad-request', 'message is not valid JSON').ref).toBeUndefined();
      await sendRaw(h, id, '[1,2]');
      expectError(h, id, 'bad-request');
      await sendRaw(h, id, '{"type":"nonsense"}');
      expect(expectError(h, id, 'bad-request').ref).toBe('nonsense');
      await sendRaw(h, id, '{"type":"answer","questionIndex":0}');
      expect(expectError(h, id, 'bad-request').ref).toBe('answer');
      await sendRaw(h, id, '{"type":"join","v":1,"pin":"12","nickname":"Ann"}');
      expect(expectError(h, id, 'bad-request').ref).toBe('join');
      expect(h.transport.ofType(id, 'error')).toHaveLength(5);
      expect(h.calls).toEqual([]);
      expect(h.transport.closes).toEqual([]);
    });

    it('replies pong to ping without reading the store', async () => {
      const h = await make();
      const id = await connect(h, 'ping');
      await h.send(id, { type: 'ping', t: 12345 });
      expect(h.transport.last(id, 'pong').t).toBe(12345);
      expect(h.calls).toEqual([]);
    });
  });

  describe('protocol version', () => {
    it.each([
      ['join', { type: 'join', pin: '123456', nickname: 'Ann' }],
      [
        'resume',
        {
          type: 'resume',
          sessionId: 'sess-000001',
          playerId: 'player-0001',
          token: 'x'.repeat(30),
        },
      ],
      [
        'host.hello',
        { type: 'host.hello', sessionId: 'sess-000001', client: 'control', authToken: 't' },
      ],
    ])('%s with the wrong or missing v gets protocol-version and a close', async (type, body) => {
      const h = await make();
      for (const v of [2, 0, 'x', undefined]) {
        const id = await connect(h, `v-${type}-${String(v)}`);
        await sendRaw(h, id, JSON.stringify({ ...body, ...(v === undefined ? {} : { v }) }));
        expect(expectError(h, id, 'protocol-version').ref).toBe(type);
        expect(h.transport.closes).toContainEqual({
          connectionId: id,
          code: CLOSE_CODES.protocolError,
          reason: 'protocol-version',
        });
      }
      expect(h.calls).toEqual([]);
    });
  });

  describe('bindings and roles', () => {
    it('refuses messages that need a binding from an unbound connection', async () => {
      const h = await make();
      const g = await startGame(h);
      const stranger = await connect(h, 'stranger');
      const messages: ClientMessage[] = [
        { type: 'answer', questionIndex: 0, payload: choice('opt-paris') },
        { type: 'leave' },
        { type: 'host.next', from: { phase: 'lobby', questionIndex: -1 } },
        { type: 'host.close', questionIndex: 0, reason: 'manual' },
        { type: 'host.skip', questionIndex: 0 },
        { type: 'host.end' },
        { type: 'host.kick', playerId: 'player-0001' },
        { type: 'host.lock', locked: true },
        { type: 'host.moderate', questionIndex: 0, responseId: 'player-0001-0', status: 'hidden' },
        { type: 'host.stats', questionIndex: 0 },
      ];
      for (const message of messages) {
        await h.send(stranger, message);
        expect(expectError(h, stranger, 'unauthorized').ref).toBe(message.type);
      }
      expect(await h.store.getSession(g.sessionId)).toMatchObject({ phase: 'lobby', version: 1 });
    });

    it('refuses host commands from a player and player messages from a host', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann'] });
      const ann = g.players.Ann!.connectionId;
      for (const message of [
        { type: 'host.next', from: { phase: 'lobby', questionIndex: -1 } },
        { type: 'host.end' },
        { type: 'host.lock', locked: true },
        { type: 'host.stats', questionIndex: 0 },
      ] as const) {
        await h.send(ann, message);
        expectError(h, ann, 'unauthorized');
      }
      await g.open({ phase: 'lobby', questionIndex: -1 });
      await h.send(g.control, { type: 'answer', questionIndex: 0, payload: choice('opt-paris') });
      expectError(h, g.control, 'unauthorized');
      await h.send(g.control, { type: 'leave' });
      expectError(h, g.control, 'unauthorized');
      expect(await h.store.getSession(g.sessionId)).toMatchObject({
        phase: 'question',
        version: 2,
      });
    });
  });

  describe('join', () => {
    it('reports unknown PINs, locked, full and ended sessions', async () => {
      const h = await make();
      const id = await connect(h, 'j1');
      await h.send(id, { type: 'join', v: 1, pin: '000000', nickname: 'Ann' });
      expectError(h, id, 'not-found');

      const g = await startGame(h);
      await h.send(g.control, { type: 'host.lock', locked: true });
      await h.send(id, { type: 'join', v: 1, pin: g.pin, nickname: 'Ann' });
      expectError(h, id, 'session-locked');
      await h.send(g.control, { type: 'host.lock', locked: false });
      await h.send(id, { type: 'join', v: 1, pin: g.pin, nickname: 'Ann' });
      expect(h.transport.last(id, 'welcome').role).toBe('player');

      const tiny = await seedSession(h, { maxPlayers: 1 });
      const first = await connect(h, 'tiny-1');
      await h.send(first, { type: 'join', v: 1, pin: tiny.pin, nickname: 'Solo' });
      expect(h.transport.last(first, 'welcome').role).toBe('player');
      const second = await connect(h, 'tiny-2');
      await h.send(second, { type: 'join', v: 1, pin: tiny.pin, nickname: 'Extra' });
      expectError(h, second, 'session-full');

      const ended = await seedSession(h, { patch: { phase: 'ended', endedAt: h.clock.now() } });
      await h.send(second, { type: 'join', v: 1, pin: ended.pin, nickname: 'Late' });
      expectError(h, second, 'session-ended');
      // A refused join stores nothing.
      expect(await h.store.getConnection(second)).toBeNull();
      expect(await h.store.countPlayers(ended.sessionId)).toBe(0);
    });

    it('carries the reason of a rejected nickname in the message', async () => {
      const h = await make();
      const g = await startGame(h);
      const id = await connect(h, 'nick');
      const cases: Array<[string, string]> = [
        ['x', 'too-short'],
        ['a'.repeat(17), 'too-long'],
        ['a‮b', 'invalid-characters'],
        ['fuck', 'inappropriate'],
      ];
      for (const [nickname, reason] of cases) {
        await h.send(id, { type: 'join', v: 1, pin: g.pin, nickname });
        expectError(h, id, 'nickname-invalid', reason);
      }
      expect(await h.store.countPlayers(g.sessionId)).toBe(0);
    });

    it('treats nicknames that fold to the same key as taken', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann'] });
      const id = await connect(h, 'dup');
      for (const nickname of ['Ann', 'ann', 'ANN', 'Аnn', 'Ann ']) {
        await h.send(id, { type: 'join', v: 1, pin: g.pin, nickname });
        expectError(h, id, 'nickname-taken');
      }
      expect(await h.store.countPlayers(g.sessionId)).toBe(1);
      expect(h.transport.ofType(g.control, 'roster')).toHaveLength(1);
    });

    it('limits nickname attempts per connection and closes the connection', async () => {
      const h = await make({ nicknameAttempts: 3 });
      const g = await startGame(h);
      const id = await connect(h, 'spam');
      for (let i = 0; i < 3; i++) {
        await h.send(id, { type: 'join', v: 1, pin: g.pin, nickname: 'x' });
        expectError(h, id, 'nickname-invalid');
      }
      expect(h.transport.closed(id)).toBe(false);
      await h.send(id, { type: 'join', v: 1, pin: g.pin, nickname: 'Valid' });
      expectError(h, id, 'rate-limited');
      expect(h.transport.closes).toContainEqual({
        connectionId: id,
        code: CLOSE_CODES.policyViolation,
        reason: 'rate-limited',
      });
      expect(await h.store.countPlayers(g.sessionId)).toBe(0);
      // The budget belongs to the connection, not to the IP or the session.
      const other = await connect(h, 'fresh');
      await h.send(other, { type: 'join', v: 1, pin: g.pin, nickname: 'Valid' });
      expect(h.transport.last(other, 'welcome').role).toBe('player');
    });
  });

  describe('resume', () => {
    it('refuses unknown players, wrong tokens and kicked players', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann', 'Bob'] });
      const ann = g.players.Ann!;
      const id = await connect(h, 'r1');
      const resume = (over: Partial<{ sessionId: string; playerId: string; token: string }>) =>
        h.send(id, {
          type: 'resume',
          v: 1,
          sessionId: ann.sessionId,
          playerId: ann.playerId,
          token: ann.token,
          ...over,
        });

      await resume({ playerId: 'nobody-0001' });
      expectError(h, id, 'not-found');
      await resume({ sessionId: 'other-session-1' });
      expectError(h, id, 'not-found');
      await resume({ token: 'y'.repeat(43) });
      expectError(h, id, 'unauthorized');
      // Bob's token is no good for Ann.
      await resume({ token: g.players.Bob!.token });
      expectError(h, id, 'unauthorized');
      expect(await h.store.getConnection(id)).toBeNull();
      expect(h.transport.closed(id)).toBe(false);

      await h.send(g.control, { type: 'host.kick', playerId: ann.playerId });
      await resume({});
      expectError(h, id, 'kicked');
      expect(h.transport.closes).toContainEqual({
        connectionId: id,
        code: CLOSE_CODES.normal,
        reason: 'kicked',
      });
      expect(await h.store.getConnection(id)).toBeNull();
    });

    it('answers not-found and stores nothing when the session is gone', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann'] });
      const ann = g.players.Ann!;
      h.overrides.getSession = async () => null;
      const id = await connect(h, 'r2');
      await h.send(id, {
        type: 'resume',
        v: 1,
        sessionId: ann.sessionId,
        playerId: ann.playerId,
        token: ann.token,
      });
      expectError(h, id, 'not-found');
      h.overrides = {};
      expect(await h.store.getConnection(id)).toBeNull();
    });

    it('does not resume an expired session', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann'] });
      const ann = g.players.Ann!;
      const meta = (await h.store.getSession(g.sessionId))!;
      h.clock.set(meta.expiresAt + 2000);
      const id = await connect(h, 'r3');
      await h.send(id, {
        type: 'resume',
        v: 1,
        sessionId: ann.sessionId,
        playerId: ann.playerId,
        token: ann.token,
      });
      expectError(h, id, 'not-found');
      await h.send(id, { type: 'join', v: 1, pin: g.pin, nickname: 'Late' });
      expectError(h, id, 'not-found');
    });
  });

  describe('host.hello', () => {
    it('refuses an invalid token, a foreign host and an unknown session', async () => {
      const h = await make();
      const g = await startGame(h);
      const hello = (id: string, over: Record<string, unknown>) =>
        h.send(id, {
          type: 'host.hello',
          v: 1,
          sessionId: g.sessionId,
          client: 'control',
          authToken: 'token-host-a',
          ...over,
        });

      const bad = await connect(h, 'h1');
      await hello(bad, { authToken: 'not-a-token' });
      expectError(h, bad, 'unauthorized');
      expect(h.transport.closes).toContainEqual({
        connectionId: bad,
        code: CLOSE_CODES.policyViolation,
        reason: 'unauthorized',
      });

      const foreign = await connect(h, 'h2');
      await hello(foreign, { authToken: 'token-host-b' });
      expectError(h, foreign, 'forbidden');
      expect(h.transport.closes).toContainEqual({
        connectionId: foreign,
        code: CLOSE_CODES.policyViolation,
        reason: 'forbidden',
      });

      const lost = await connect(h, 'h3');
      await hello(lost, { sessionId: 'no-such-session' });
      expectError(h, lost, 'not-found');

      for (const id of [bad, foreign, lost]) expect(await h.store.getConnection(id)).toBeNull();
      // None of them can drive the game.
      await h.send(foreign, { type: 'host.end' });
      expectError(h, foreign, 'unauthorized');
      expect(await h.store.getSession(g.sessionId)).toMatchObject({ phase: 'lobby' });
    });
  });

  describe('host commands', () => {
    it('reports unknown players, questions and responses', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann'] });
      await h.send(g.control, { type: 'host.kick', playerId: 'nobody-0001' });
      expectError(h, g.control, 'not-found');
      await h.send(g.control, { type: 'host.stats', questionIndex: 50 });
      expectError(h, g.control, 'bad-request');
      await h.send(g.control, {
        type: 'host.moderate',
        questionIndex: 50,
        responseId: 'x-0001-0',
        status: 'hidden',
      });
      expectError(h, g.control, 'not-found');
      // Question 0 is a single-choice question: nothing to moderate.
      await h.send(g.control, {
        type: 'host.moderate',
        questionIndex: 0,
        responseId: 'x-0001-0',
        status: 'hidden',
      });
      expectError(h, g.control, 'bad-request');
      // Question 2 is a word cloud, but no such response exists.
      await h.send(g.control, {
        type: 'host.moderate',
        questionIndex: 2,
        responseId: 'nobody-0001-0',
        status: 'hidden',
      });
      expectError(h, g.control, 'not-found');
    });

    it('gives up with conflict after three lost version races and sends nothing to players', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann'] });
      let attempts = 0;
      h.overrides.updateSession = async () => {
        attempts++;
        throw new ConflictError();
      };
      await g.next('lobby', -1);
      expectError(h, g.control, 'conflict');
      expect(attempts).toBe(3);
      expect(h.transport.ofType(g.players.Ann!.connectionId, 'question')).toEqual([]);
      h.overrides = {};
      expect(await h.store.getSession(g.sessionId)).toMatchObject({ phase: 'lobby', version: 1 });
    });
  });

  describe('unexpected failures', () => {
    it('replies internal, logs the details and leaks nothing', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann'] });
      await g.open({ phase: 'lobby', questionIndex: -1 });
      const ann = g.players.Ann!.connectionId;
      h.overrides.putResponse = async () => {
        throw new Error('secret table name exploded');
      };
      await g.answer('Ann', 0, choice('opt-paris'), h.clock.now() + 5000);
      const error = expectError(h, ann, 'internal', 'internal error');
      expect(error.ref).toBe('answer');
      expect(JSON.stringify(h.transport.to(ann))).not.toMatch(/secret|exploded|stack|at /);
      const logged = h.logger.entries.error.at(-1)!;
      expect(logged.o).toMatchObject({ connectionId: ann, type: 'answer' });
      expect(JSON.stringify(logged.o)).toContain('secret table name exploded');
      h.overrides = {};
    });

    it('never rejects, even when the transport itself fails', async () => {
      const h = await make();
      const id = await connect(h, 'broken');
      const send = h.transport.send.bind(h.transport);
      h.transport.send = async () => {
        throw new Error('socket layer down');
      };
      await expect(
        h.service.onMessage(id, JSON.stringify({ type: 'ping', t: 1 }), h.clock.now()),
      ).resolves.toBeUndefined();
      await expect(h.service.onMessage(id, 'garbage', h.clock.now())).resolves.toBeUndefined();
      expect(h.logger.entries.error.length).toBeGreaterThanOrEqual(2);
      h.transport.send = send;
    });

    it('swallows store failures on disconnect and timers', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann'] });
      h.overrides.getConnection = async () => {
        throw new Error('down');
      };
      h.overrides.getSession = async () => {
        throw new Error('down');
      };
      await expect(h.service.onDisconnect(g.players.Ann!.connectionId)).resolves.toBeUndefined();
      await expect(h.service.onTimer(g.sessionId, 0)).resolves.toBeUndefined();
      expect(h.logger.entries.error).toHaveLength(2);
      h.overrides = {};
    });
  });

  it('covered every error code', () => {
    expect([...seen].sort()).toEqual([...ErrorCode.options].sort());
  });
});
