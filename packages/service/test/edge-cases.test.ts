import { describe, expect, it } from 'vitest';
import type { ResponseRecord } from '@zqhoot/engine';
import { ConflictError, NotFoundError } from '@zqhoot/store';
import { MediaError } from '../src/index.ts';
import { HOST_TOKENS, describeWithStores } from './harness.ts';
import { startGame, text } from './game.ts';
import { miniQuiz, wordCloudQuiz } from './fixtures.ts';

/** Returns the real value on the first call and `null` from then on. */
function vanishAfterFirstRead(h: { real: { getSession: (id: string) => Promise<unknown> } }) {
  let calls = 0;
  return async (sessionId: string) => {
    calls++;
    return calls === 1 ? h.real.getSession(sessionId) : null;
  };
}

describeWithStores('races with expiry and store failures', (make) => {
  describe('a session that disappears while a connection registers', () => {
    it('join: answers not-found and leaves no connection behind', async () => {
      const h = await make();
      const g = await startGame(h);
      const id = h.cid('vanish-join');
      let reads = 0;
      h.overrides.getSession = async (sessionId: string) =>
        ++reads === 1 ? h.real.getSession(sessionId) : null;
      await h.send(id, { type: 'join', v: 1, pin: g.pin, nickname: 'Ghost' });
      h.overrides = {};
      expect(h.transport.last(id, 'error')).toMatchObject({ code: 'not-found', ref: 'join' });
      expect(await h.store.getConnection(id)).toBeNull();
      expect(h.transport.ofType(g.control, 'roster')).toEqual([]);
    });

    it('resume: answers not-found and leaves no connection behind', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann'] });
      const ann = g.players.Ann!;
      const id = h.cid('vanish-resume');
      let reads = 0;
      h.overrides.getSession = async (sessionId: string) =>
        ++reads === 1 ? h.real.getSession(sessionId) : null;
      await h.send(id, {
        type: 'resume',
        v: 1,
        sessionId: g.sessionId,
        playerId: ann.playerId,
        token: ann.token,
      });
      h.overrides = {};
      expect(h.transport.last(id, 'error')).toMatchObject({ code: 'not-found', ref: 'resume' });
      expect(await h.store.getConnection(id)).toBeNull();
    });

    it('resume: the player expiring between the reads is not-found too', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann'] });
      const ann = g.players.Ann!;
      const id = h.cid('vanish-player');
      h.overrides.updatePlayer = async () => {
        throw new NotFoundError();
      };
      await h.send(id, {
        type: 'resume',
        v: 1,
        sessionId: g.sessionId,
        playerId: ann.playerId,
        token: ann.token,
      });
      h.overrides = {};
      expect(h.transport.last(id, 'error')).toMatchObject({ code: 'not-found' });
      expect(await h.store.getConnection(id)).toBeNull();
    });

    it('host.hello: answers not-found and leaves no connection behind', async () => {
      const h = await make();
      const g = await startGame(h);
      const id = h.cid('vanish-host');
      h.overrides.getSession = vanishAfterFirstRead(h) as never;
      await h.send(id, {
        type: 'host.hello',
        v: 1,
        sessionId: g.sessionId,
        client: 'present',
        authToken: HOST_TOKENS.a,
      });
      h.overrides = {};
      expect(h.transport.last(id, 'error')).toMatchObject({ code: 'not-found', ref: 'host.hello' });
      expect(await h.store.getConnection(id)).toBeNull();
    });

    it('host.stats without a snapshot is not-found', async () => {
      const h = await make();
      const id = h.cid('orphan-host');
      await h.store.putConnection({
        connectionId: id,
        sessionId: 'session-without-snapshot',
        role: 'host',
        client: 'control',
        connectedAt: h.clock.now(),
        expiresAt: h.clock.now() + 1000,
      });
      await h.send(id, { type: 'host.stats', questionIndex: 0 });
      expect(h.transport.last(id, 'error')).toMatchObject({ code: 'not-found' });
      await h.send(id, { type: 'host.next', from: { phase: 'lobby', questionIndex: -1 } });
      expect(h.transport.last(id, 'error')).toMatchObject({ code: 'not-found', ref: 'host.next' });
    });
  });

  describe('answers that keep losing the slot race', () => {
    it('gives up with the entry limit after the second lost race', async () => {
      const h = await make();
      const g = await startGame(h, { quiz: wordCloudQuiz(5), players: ['Ann'] });
      const { openAt } = await g.open({ phase: 'lobby', questionIndex: -1 });
      const ann = g.players.Ann!;
      let puts = 0;
      h.overrides.putResponse = async (record: ResponseRecord) => {
        puts++;
        // Somebody else always got there first with another entry of the same player.
        return {
          created: false,
          existing: {
            ...record,
            slot: record.slot,
            responseId: `${ann.playerId}-${record.slot}`,
            payload: { kind: 'text', text: `other ${puts}` },
            normalizedText: `other ${puts}`,
          },
        };
      };
      await g.answer('Ann', 0, text('mine'), openAt + 100);
      h.overrides = {};
      expect(puts).toBe(2);
      expect(h.transport.last(ann.connectionId, 'answer.ack')).toMatchObject({
        status: 'rejected',
        reason: 'limit',
        entries: 2,
      });
    });
  });

  describe('gives up quietly when a transition keeps conflicting', () => {
    it('abandons a reveal after three lost version races and lets the next command retry it', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann'] });
      await g.open({ phase: 'lobby', questionIndex: -1 });
      h.overrides.updateSession = async (meta: { phase: string }, expected: number) => {
        if (meta.phase === 'reveal') throw new ConflictError();
        return h.real.updateSession(meta as never, expected);
      };
      await g.close(0);
      expect(
        h.logger.entries.warn.some((w) => w.m === 'reveal abandoned after repeated conflicts'),
      ).toBe(true);
      expect(await h.store.getSession(g.sessionId)).toMatchObject({ phase: 'revealing' });
      expect(h.transport.ofType(g.players.Ann!.connectionId, 'reveal')).toEqual([]);
      // Scoring happened once, and the retry reuses it.
      expect(await h.store.getScoreboard(g.sessionId)).toMatchObject({ version: 1 });
      h.overrides = {};
      await g.next('revealing', 0);
      expect(h.transport.ofType(g.players.Ann!.connectionId, 'reveal')).toHaveLength(1);
      expect(await h.store.getScoreboard(g.sessionId)).toMatchObject({ version: 1 });
    });

    it('logs a timer close that could not win a version race', async () => {
      const h = await make();
      const g = await startGame(h);
      await g.open({ phase: 'lobby', questionIndex: -1 });
      h.overrides.updateSession = async () => {
        throw new ConflictError();
      };
      await h.service.onTimer(g.sessionId, 0);
      h.overrides = {};
      expect(
        h.logger.entries.warn.some(
          (w) => w.m === 'transition abandoned after repeated version conflicts',
        ),
      ).toBe(true);
      expect(await h.store.getSession(g.sessionId)).toMatchObject({ phase: 'question' });
    });

    it('rethrows other store errors from a write as an internal error', async () => {
      const h = await make();
      const g = await startGame(h);
      h.overrides.updateSession = async () => {
        throw new Error('throttled');
      };
      await g.next('lobby', -1);
      h.overrides = {};
      expect(h.transport.last(g.control, 'error')).toMatchObject({
        code: 'internal',
        ref: 'host.next',
      });
    });
  });

  it('carries on when closing a connection fails', async () => {
    const h = await make();
    const g = await startGame(h, { players: ['Ann'] });
    h.transport.close = async () => {
      throw new Error('socket already destroyed');
    };
    await h.send(g.control, { type: 'host.kick', playerId: g.players.Ann!.playerId });
    expect(await h.store.getConnection(g.players.Ann!.connectionId)).toBeNull();
    expect(h.logger.entries.warn.some((w) => w.m === 'closing a connection failed')).toBe(true);
    expect(h.transport.ofType(g.control, 'error')).toEqual([]);
  });

  it('keeps hosts and players of other sessions out of each other’s broadcasts', async () => {
    const h = await make();
    const one = await startGame(h, { players: ['Ann'], label: 'one-' });
    const two = await startGame(h, { players: ['Bob'], label: 'two-' });
    await one.open({ phase: 'lobby', questionIndex: -1 });
    expect(h.transport.ofType(one.players.Ann!.connectionId, 'question')).toHaveLength(1);
    expect(h.transport.ofType(two.players.Bob!.connectionId, 'question')).toEqual([]);
    expect(h.transport.ofType(two.control, 'host.state')).toEqual([]);
    await two.next('lobby', -1);
    await two.close(0);
    expect(h.transport.ofType(one.players.Ann!.connectionId, 'reveal')).toEqual([]);
    expect(await h.store.getSession(one.sessionId)).toMatchObject({ phase: 'question' });
  });
});

describeWithStores('HTTP edge cases', (make) => {
  const A = HOST_TOKENS.a;
  const quizBody = () => miniQuiz();

  it('maps MediaError kinds thrown while creating an upload', async () => {
    const h = await make();
    const attempts: Array<[MediaError | Error, number]> = [
      [new MediaError('size', 'too big'), 413],
      [new MediaError('type', 'not an image'), 415],
      [new MediaError('token', 'nope'), 403],
      [new MediaError('key', 'bad key'), 400],
      [new Error('S3 unreachable'), 500],
    ];
    for (const [error, status] of attempts) {
      h.media.createUpload = async () => {
        throw error;
      };
      const res = await h.api('POST', '/api/media/uploads', {
        token: A,
        body: { contentType: 'image/png', size: 10 },
      });
      expect(res.status, error.message).toBe(status);
    }
  });

  it('maps MediaError kinds and failures thrown while storing an upload', async () => {
    const h = await make();
    const url = '/api/media/media/some-host/abcdef.png?t=t';
    const headers = { 'content-type': 'image/png' };
    for (const [error, status] of [
      [new MediaError('key', 'unknown key'), 400],
      [new MediaError('size', 'too large'), 413],
      [new Error('disk full'), 500],
    ] as const) {
      h.media.putOverride = async () => {
        throw error;
      };
      const res = await h.api('PUT', url, { raw: new Uint8Array(4), headers });
      expect(res.status, error.message).toBe(status);
    }
    expect(h.logger.entries.error.at(-1)!.o).toMatchObject({ method: 'PUT' });
  });

  it('keeps the failed-PIN memory bounded and forgets blocks when their window ends', async () => {
    const h = await make();
    const g = await startGame(h);
    h.overrides.hitRateLimit = async () => false; // every miss puts its IP over the limit
    for (let i = 0; i < 1005; i++) {
      const res = await h.api('GET', '/api/join/000000', { ip: `flood-${i}` });
      expect(res.status).toBe(429);
    }
    h.overrides = {};
    // Whether an IP was remembered or not, the block never outlives its window.
    expect((await h.api('GET', `/api/join/${g.pin}`, { ip: 'flood-0' })).status).toBe(429);
    h.clock.advance(60_000);
    expect((await h.api('GET', `/api/join/${g.pin}`, { ip: 'flood-0' })).status).toBe(200);
    expect((await h.api('GET', `/api/join/${g.pin}`, { ip: 'flood-1004' })).status).toBe(200);
    // A new block after the window pruned the old ones.
    h.overrides.hitRateLimit = async () => false;
    expect((await h.api('GET', '/api/join/000000', { ip: 'late' })).status).toBe(429);
    h.overrides = {};
  });

  it('creates quizzes for both hosts independently', async () => {
    const h = await make();
    await h.createQuiz(quizBody(), 'a');
    await h.createQuiz(quizBody(), 'b');
    for (const who of ['a', 'b'] as const) {
      const list = await h.api('GET', '/api/quizzes', { token: HOST_TOKENS[who] });
      expect(list.json()).toHaveLength(1);
    }
  });

  describe('server errors from the store on write routes', () => {
    it('turns a create that hits an existing id into a 500 rather than overwriting', async () => {
      const h = await make();
      h.ids.quizId = () => 'fixed-quiz-id';
      await h.createQuiz(quizBody());
      const second = await h.api('POST', '/api/quizzes', { token: A, body: quizBody() });
      expect(second.status).toBe(500);
      expect(second.json()).toEqual({ error: 'internal', message: 'internal error' });
      expect((await h.api('GET', '/api/quizzes/fixed-quiz-id', { token: A })).status).toBe(200);
    });
  });
});
