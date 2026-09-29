import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, TIMING } from '@zqhoot/protocol';
import { HOST_TOKEN, SITE_ORIGIN, createHarness } from './support/harness.ts';
import type { Harness } from './support/harness.ts';

const v = PROTOCOL_VERSION;
const here = dirname(fileURLToPath(import.meta.url));

let h: Harness;
beforeAll(async () => {
  h = await createHarness('ws');
});
afterAll(async () => {
  await h.close();
});

interface Game {
  sessionId: string;
  pin: string;
  host: string;
  openAt: number;
  deadline: number;
  players: string[];
}

/** A lobby with a host and players, then the first question opened. Returns its timing. */
async function openFirstQuestion(names: string[]): Promise<Game> {
  const { sessionId, pin } = await h.createSession();
  const host = `host-${sessionId}`;
  expect((await h.connect(host)).statusCode).toBe(200);
  await h.send(host, {
    type: 'host.hello',
    v,
    sessionId,
    client: 'control',
    authToken: HOST_TOKEN,
  });
  const players = names.map((n) => `${n}-${sessionId}`);
  for (const [i, name] of players.entries()) {
    await h.connect(name);
    await h.send(name, { type: 'join', v, pin, nickname: `Player${i}` });
    expect(h.transport.last(h.cid(name), 'welcome').role).toBe('player');
  }
  await h.send(host, { type: 'host.next', from: { phase: 'lobby', questionIndex: -1 } });
  const question = h.transport.last(h.cid(host), 'host.state').snapshot.question;
  if (question === undefined || question.deadline === null)
    throw new Error('question did not open');
  return { sessionId, pin, host, openAt: question.openAt, deadline: question.deadline, players };
}

const choose = (optionId: string) => ({
  type: 'answer' as const,
  questionIndex: 0,
  payload: { kind: 'choice' as const, optionId },
});

const ack = (player: string) => h.transport.last(h.cid(player), 'answer.ack');

describe('$connect', () => {
  it('accepts the configured site origin under either header spelling', async () => {
    expect((await h.connect('c-upper', { Origin: SITE_ORIGIN })).statusCode).toBe(200);
    expect((await h.connect('c-lower', { origin: SITE_ORIGIN })).statusCode).toBe(200);
  });

  it('rejects another origin, a missing origin and a missing header map with 403', async () => {
    expect((await h.connect('c-evil', { Origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await h.connect('c-http', { Origin: 'http://quiz.example.com' })).statusCode).toBe(403);
    expect((await h.connect('c-none', {})).statusCode).toBe(403);
    expect((await h.connect('c-nomap', null)).statusCode).toBe(403);
  });

  it('does not reach the transport or the store', async () => {
    const before = h.transport.log.length;
    await h.connect('c-quiet', { Origin: 'https://evil.example' });
    expect(h.transport.log).toHaveLength(before);
    expect(await h.store.getConnection(h.cid('c-quiet'))).toBeNull();
  });
});

describe('$default receivedAt (ADR-0005)', () => {
  it('is the requestTimeEpoch: an answer sent in time still counts when the invocation runs late', async () => {
    const game = await openFirstQuestion(['late-runner']);
    const [player] = game.players as [string];

    // The invocation happens 5 s after the question closed (a cold start, say), but API Gateway
    // received the frame 10 s before that, inside the answer window.
    h.clock.set(game.deadline + 5_000);
    await h.send(player, choose('opt-four'), h.clock.now() - 10_000);

    expect(ack(player)).toMatchObject({ status: 'accepted', index: 0 });
  });

  it('is the requestTimeEpoch: an answer stamped after the deadline is too late whatever the clock says', async () => {
    const game = await openFirstQuestion(['slow-sender']);
    const [player] = game.players as [string];

    h.clock.set(game.openAt + 1_000);
    await h.send(player, choose('opt-four'), game.deadline + TIMING.answerGraceMs + 5_000);

    expect(ack(player)).toMatchObject({ status: 'rejected', reason: 'too-late' });
  });

  it('is the requestTimeEpoch: an answer stamped before the question opened is too early', async () => {
    const game = await openFirstQuestion(['eager']);
    const [player] = game.players as [string];

    h.clock.set(game.openAt + 2_000);
    await h.send(player, choose('opt-four'), game.openAt - 10_000);

    expect(ack(player)).toMatchObject({ status: 'rejected', reason: 'too-early' });
  });

  it('is too late for a question the host closed 5 s ago, whatever the frame was stamped', async () => {
    const game = await openFirstQuestion(['after-close']);
    const [player] = game.players as [string];

    h.clock.set(game.openAt + 1_000);
    await h.send(game.host, { type: 'host.close', questionIndex: 0, reason: 'manual' });
    h.clock.set(h.clock.now() + 5_000);
    // Stamped 10 s ago, so before the close: a closed question still refuses it (a phase rule,
    // which is why the tests above are the ones that pin down where receivedAt comes from).
    await h.send(player, choose('opt-four'), h.clock.now() - 10_000);

    expect(ack(player)).toMatchObject({ status: 'rejected', reason: 'too-late' });
  });

  it('drives the score: the points follow the stamped time, not the invocation time', async () => {
    const game = await openFirstQuestion(['quick', 'slower']);
    const [quick, slower] = game.players as [string, string];

    h.clock.set(game.deadline);
    await h.send(quick, choose('opt-four'), game.openAt + 100);
    await h.send(slower, choose('opt-four'), game.deadline);
    await h.send(game.host, { type: 'host.close', questionIndex: 0, reason: 'manual' });

    const points = (name: string) => h.transport.last(h.cid(name), 'reveal').you.points;
    // Full points inside the 250 ms window, and the 400-point floor at the deadline.
    expect(points(quick)).toBe(1000);
    expect(points(slower)).toBe(400);
    // The reveal waited the Lambda settle interval (ADR-0006).
    expect(h.sleeps).toContain(1000);
  });

  it('is never read from a clock on the Lambda path', () => {
    const handlerSource = readFileSync(join(here, '../src/ws-handler.ts'), 'utf8');
    const entrySource = readFileSync(join(here, '../src/ws.ts'), 'utf8');
    // The handler is the only place a receive time enters the service.
    expect(handlerSource).not.toMatch(/Date\b|performance\.now|hrtime/);
    expect(handlerSource.match(/requestTimeEpoch/g)?.length).toBe(2);
    expect(handlerSource).toMatch(/ctx\.requestTimeEpoch,/);
    expect(entrySource).not.toMatch(/receivedAt/);
  });
});

describe('warm-up event', () => {
  it('warms the service, then holds for 200 ms so concurrent warm-ups land on separate environments', async () => {
    const before = h.sleeps.length;
    const result = await h.handler({ warmup: true });
    expect(result.statusCode).toBe(200);
    expect(h.sleeps.slice(before)).toEqual([200]);
  });

  it('really waits when no sleep is injected', async () => {
    const { createWsHandler } = await import('../src/ws-handler.ts');
    let warmed = 0;
    const real = createWsHandler({
      service: {
        warm: async () => void warmed++,
        onConnect: async () => ({ accept: true }),
        onDisconnect: async () => {},
        onMessage: async () => {},
      },
    });
    const started = performance.now();
    await real({ warmup: true });
    expect(warmed).toBe(1);
    expect(performance.now() - started).toBeGreaterThanOrEqual(190);
  });
});

describe('$default and $disconnect', () => {
  it('always answers 200 and lets the service reply on the transport', async () => {
    await h.connect('junk');
    const before = h.transport.to(h.cid('junk')).length;
    expect((await h.send('junk', 'not json')).statusCode).toBe(200);
    expect((await h.send('junk', { type: 'nope' })).statusCode).toBe(200);
    expect((await h.send('junk', 'x'.repeat(5000))).statusCode).toBe(200);
    const replies = h.transport.to(h.cid('junk')).slice(before);
    expect(replies.map((m) => m.type)).toEqual(['error', 'error', 'error']);
  });

  it('treats a missing body as an empty message', async () => {
    const result = await h.handler({
      requestContext: { routeKey: '$default', connectionId: h.cid('empty'), requestTimeEpoch: 1 },
    });
    expect(result.statusCode).toBe(200);
  });

  it('removes the connection and tells the host the player dropped', async () => {
    const game = await openFirstQuestion(['leaver']);
    const [player] = game.players as [string];
    expect(await h.store.getConnection(h.cid(player))).not.toBeNull();

    expect((await h.disconnect(player)).statusCode).toBe(200);

    expect(await h.store.getConnection(h.cid(player))).toBeNull();
    const roster = h.transport.last(h.cid(game.host), 'roster');
    expect(roster.upsert).toEqual([expect.objectContaining({ connected: false })]);
  });

  it('answers 200 to a disconnect for a connection it never saw', async () => {
    expect((await h.disconnect('never-connected')).statusCode).toBe(200);
  });

  it('rejects an event that is neither a warm-up nor a WebSocket event', async () => {
    const result = await h.handler({} as never);
    expect(result.statusCode).toBe(400);
  });
});

describe('the source address of a frame (failed-PIN limit, ADR-0013)', () => {
  const joinFrom = async (name: string, pin: string, sourceIp: string | null, nick = 'Kid') => {
    await h.connect(name);
    await h.send(name, { type: 'join', v, pin, nickname: nick }, undefined, sourceIp);
    return { message: h.transport.to(h.cid(name)).at(-1) };
  };

  it('hands requestContext.identity.sourceIp to the service, and nothing when the event has none', async () => {
    const { createWsHandler } = await import('../src/ws-handler.ts');
    const seen: Array<{ raw: string; info: unknown }> = [];
    const spy = createWsHandler({
      service: {
        warm: async () => {},
        onConnect: async () => ({ accept: true }),
        onDisconnect: async () => {},
        onMessage: async (_id, raw, _receivedAt, info) => void seen.push({ raw, info }),
      },
    });
    const frame = (identity?: { sourceIp?: string }) => ({
      body: '{"type":"ping","t":1}',
      requestContext: {
        routeKey: '$default',
        connectionId: 'c',
        requestTimeEpoch: 1,
        ...(identity !== undefined ? { identity } : {}),
      },
    });
    await spy(frame({ sourceIp: '203.0.113.44' }));
    await spy(frame({}));
    await spy(frame());
    expect(seen.map((s) => s.info)).toEqual([{ sourceIp: '203.0.113.44' }, {}, {}]);
  });

  it('refuses the 31st failed PIN from one address, on connections of their own', async () => {
    const ip = '192.0.2.10';
    for (let i = 0; i < 30; i++) {
      expect(await joinFrom(`guess-${i}`, '000000', ip)).toMatchObject({
        message: { type: 'error', code: 'not-found' },
      });
    }
    expect(await joinFrom('guess-30', '000000', ip)).toMatchObject({
      message: { type: 'error', code: 'rate-limited', ref: 'join' },
    });
  });

  it('refuses a live PIN from the blocked address and admits the same PIN from another', async () => {
    const { pin } = await h.createSession();
    const blocked = '192.0.2.11';
    for (let i = 0; i < 31; i++) await joinFrom(`walk-${i}`, '000000', blocked);
    expect(await joinFrom('live-blocked', pin, blocked)).toMatchObject({
      message: { type: 'error', code: 'rate-limited' },
    });
    expect(await h.store.getConnection(h.cid('live-blocked'))).toBeNull();
    expect(await joinFrom('live-other', pin, '192.0.2.12', 'Other')).toMatchObject({
      message: { type: 'welcome', role: 'player' },
    });
  });

  it('never limits a classroom of valid joins from one address', async () => {
    const { pin } = await h.createSession();
    for (let i = 0; i < 40; i++) {
      expect(await joinFrom(`desk-${i}`, pin, '192.0.2.13', `Desk ${i}`)).toMatchObject({
        message: { type: 'welcome' },
      });
    }
    for (let i = 0; i < 30; i++) {
      expect(await joinFrom(`typo-${i}`, '000000', '192.0.2.13')).toMatchObject({
        message: { code: 'not-found' },
      });
    }
  });

  it('keys an event without an address as "unknown"', async () => {
    // Nothing else in this file sends an event without one, so the shared window is ours.
    h.clock.advance(60_000 * (1 + Math.floor(Math.random() * 100_000)));
    for (let i = 0; i < 30; i++) await joinFrom(`anon-${i}`, '000000', null);
    expect(await joinFrom('anon-30', '000000', null)).toMatchObject({
      message: { code: 'rate-limited' },
    });
    expect(await joinFrom('named', '000000', '192.0.2.14')).toMatchObject({
      message: { code: 'not-found' },
    });
  });
});

describe('the host timer close (ADR-0005)', () => {
  it('waits for the end of the answer grace with the sleep port, then closes', async () => {
    const game = await openFirstQuestion(['grace']);
    const [player] = game.players as [string];
    h.clock.set(game.deadline + 50);
    const before = h.sleeps.length;

    await h.send(game.host, { type: 'host.close', questionIndex: 0, reason: 'timer' });

    // 700 ms until deadline + grace, then the reveal settle.
    expect(h.sleeps.slice(before)).toEqual([TIMING.answerGraceMs - 50, 1000]);
    expect(await h.store.getSession(game.sessionId)).toMatchObject({
      phase: 'reveal',
      closedAt: game.deadline + TIMING.answerGraceMs,
    });
    expect(h.transport.last(h.cid(player), 'reveal').you.answered).toBe(false);
  });

  it('does not wait for a manual close', async () => {
    const game = await openFirstQuestion(['manual']);
    h.clock.set(game.deadline + 50);
    const before = h.sleeps.length;
    await h.send(game.host, { type: 'host.close', questionIndex: 0, reason: 'manual' });
    expect(h.sleeps.slice(before)).toEqual([1000]);
  });
});
