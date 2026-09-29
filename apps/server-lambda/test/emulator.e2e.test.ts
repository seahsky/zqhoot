import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ApiGatewayManagementApiClient,
  DeleteConnectionCommand,
  GetConnectionCommand,
  GoneException,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, RuntimeConfig } from '@zqhoot/protocol';
import type { QuizInput } from '@zqhoot/protocol';
import { DynamoStore } from '@zqhoot/store';
import { createEmulatorDocClient, dropTable, uniqueTableName } from './support/dynamo.ts';
import { Client, sleep, startEmulatorProcess, until } from './support/emulator.ts';
import type { EmulatorProcess } from './support/emulator.ts';

const v = PROTOCOL_VERSION;

let emu: EmulatorProcess;
let webDist: string;
const table = uniqueTableName('emu');
const doc = createEmulatorDocClient();

beforeAll(async () => {
  webDist = mkdtempSync(join(tmpdir(), 'zqhoot-web-'));
  mkdirSync(join(webDist, 'assets'));
  writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>zqhoot</title>');
  writeFileSync(join(webDist, 'assets', 'app-abc123.js'), 'console.log(1)');
  writeFileSync(join(webDist, '..', `${webDist.split('/').pop()}-secret.txt`), 'secret');
  emu = await startEmulatorProcess({ table, webDist });
}, 60_000);

afterAll(async () => {
  await emu?.stop();
  await dropTable(doc, table);
  if (webDist !== undefined) {
    rmSync(webDist, { recursive: true, force: true });
    rmSync(`${webDist}-secret.txt`, { force: true });
  }
});

async function api(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
  base = emu.info.http,
): Promise<{ status: number; headers: Headers; text: string; json: <T>() => T }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(opts.token !== undefined ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, json: <T>() => JSON.parse(text) as T };
}

const stats = async () =>
  (await (await fetch(`${emu.info.mgmt}/__emulator/stats`)).json()) as {
    connections: number;
    invocations: { connect: number; message: number; disconnect: number; warmup: number };
    maxInFlight: number;
    maxInFlightPerConnection: number;
  };

const connections = async () =>
  (await (await fetch(`${emu.info.mgmt}/__emulator/connections`)).json()) as Array<{ id: string }>;

const openClient = (name: string) => Client.open(name, emu.info.ws, emu.info.origin);

const quiz: QuizInput = {
  title: 'Emulator quiz',
  settings: { streakBonus: false, showQuestionOnDevices: true, readSeconds: 0 },
  questions: [
    {
      id: 'q-capital',
      type: 'single',
      prompt: 'Capital of France?',
      timeLimitSec: 10,
      options: [
        { id: 'opt-paris', text: 'Paris' },
        { id: 'opt-rome', text: 'Rome' },
      ],
      correctOptionId: 'opt-paris',
      points: 1,
    },
    {
      id: 'q-skycolor',
      type: 'truefalse',
      prompt: 'The sky is green',
      timeLimitSec: 10,
      correct: false,
      points: 1,
    },
    {
      id: 'q-prime',
      type: 'single',
      prompt: 'Which is prime?',
      timeLimitSec: 10,
      options: [
        { id: 'opt-seven', text: '7' },
        { id: 'opt-eight', text: '8' },
      ],
      correctOptionId: 'opt-seven',
      points: 1,
    },
  ],
};

describe('the emulator serves the web app and its config', () => {
  it('generates a valid runtime config that points at the emulator', async () => {
    const res = await api('GET', '/config.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    const config = RuntimeConfig.parse(res.json());
    expect(config.auth).toEqual({ mode: 'local' });
    expect(config.wsUrl).toBe(emu.info.ws);
    expect(config.joinUrl).toBe(`${emu.info.origin}/join`);
    expect(config.apiBaseUrl).toBe('');
  });

  it('serves static files with CloudFront-like caching and an SPA fallback', async () => {
    const index = await api('GET', '/');
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toContain('text/html');
    expect(index.headers.get('cache-control')).toBe('no-cache');

    const route = await api('GET', '/join');
    expect(route.text).toContain('<title>zqhoot</title>');

    const asset = await api('GET', '/assets/app-abc123.js');
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toContain('immutable');

    expect((await api('GET', '/missing.js')).status).toBe(404);
  });

  it('cannot be walked out of the web root', async () => {
    // `fetch` would normalise `..`, so the request is written out by hand.
    const rawGet = (path: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request(
          { host: 'localhost', port: new URL(emu.info.http).port, path },
          (res) => {
            let body = '';
            res.on('data', (chunk: Buffer) => (body += chunk.toString()));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
          },
        );
        req.on('error', reject);
        req.end();
      });
    const secret = `${webDist.split('/').pop()}-secret.txt`;
    for (const path of [
      `/../${secret}`,
      `/..%2F${secret}`,
      `/%2e%2e/${secret}`,
      `/assets/../../${secret}`,
      '/../../../../etc/passwd',
    ]) {
      const res = await rawGet(path);
      expect(res.body, path).not.toContain('secret');
      expect(res.body, path).not.toContain('root:');
    }
    expect((await rawGet(`/..%2F${secret}`)).status).toBe(404);
  });
});

describe('the http bundle behind the emulator', () => {
  it('routes /api/health through an API Gateway v2 event', async () => {
    const res = await api('GET', '/api/health');
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, target: 'aws' });
  });

  it('logs the admin in and rejects a wrong password', async () => {
    const bad = await api('POST', '/api/auth/login', {
      body: { username: 'admin', password: 'nope' },
    });
    expect(bad.status).toBe(401);
    const ok = await api('POST', '/api/auth/login', {
      body: { username: 'admin', password: 'admin' },
    });
    expect(ok.status).toBe(200);
    const { token } = ok.json<{ token: string }>();
    expect((await api('GET', '/api/me', { token })).json()).toEqual({
      hostId: 'local:admin',
      displayName: 'admin',
    });
    expect((await api('GET', '/api/me')).status).toBe(401);
  });

  it('answers a media grant with a presigned POST', async () => {
    const { token } = (
      await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin' } })
    ).json<{ token: string }>();
    const grant = await api('POST', '/api/media/uploads', {
      token,
      body: { contentType: 'image/png', size: 1234 },
    });
    expect(grant.status).toBe(200);
    expect(grant.json<{ upload: { method: string }; key: string }>()).toMatchObject({
      upload: { method: 'POST' },
      key: expect.stringMatching(/^media\/[\w-]{16}\/[\w-]+\.png$/),
    });
  });
});

describe('a full game through API Gateway events, the real transport and DynamoDB', () => {
  it('runs a host and five players through three questions, a reconnect and a kick', async () => {
    const startedAt = Date.now();
    // ---- Host: login, quiz, session ------------------------------------------------------
    const { token } = (
      await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin' } })
    ).json<{ token: string }>();
    const created = await api('POST', '/api/quizzes', { token, body: quiz });
    expect(created.status, created.text).toBe(200);
    const warmBefore = (await stats()).invocations.warmup;
    const session = await api('POST', '/api/sessions', {
      token,
      body: { quizId: created.json<{ id: string }>().id },
    });
    expect(session.status, session.text).toBe(200);
    const { sessionId, pin } = session.json<{ sessionId: string; pin: string }>();

    // The real LambdaWarmer called the emulator's Invoke API, which ran the ws handler.
    await until(
      async () => (await stats()).invocations.warmup >= warmBefore + 2,
      'warm-up invocations',
    );
    expect((await api('GET', `/api/join/${pin}`)).json()).toMatchObject({
      sessionId,
      joinable: true,
    });

    // ---- $connect checks the Origin ------------------------------------------------------
    await expect(Client.open('intruder', emu.info.ws, 'https://evil.example')).rejects.toThrow(
      /403/,
    );

    // ---- Host connects ----------------------------------------------------------------------
    const host = await openClient('host');
    host.send({ type: 'host.hello', v, sessionId, client: 'control', authToken: token });
    const hello = await host.waitFor('welcome');
    expect(hello).toMatchObject({ role: 'host', snapshot: { pin, phase: 'lobby' } });

    // ---- Five players join -----------------------------------------------------------------
    const names = ['Alice', 'Bobby', 'Carol', 'Daniel', 'Erin'] as const;
    const players: Record<string, { client: Client; playerId: string; token: string }> = {};
    for (const nickname of names) {
      const client = await openClient(nickname);
      client.send({ type: 'join', v, pin, nickname });
      const welcome = await client.waitFor('welcome');
      if (welcome.role !== 'player' || welcome.credentials === undefined)
        throw new Error('no credentials');
      players[nickname] = {
        client,
        playerId: welcome.credentials.playerId,
        token: welcome.credentials.token,
      };
    }
    const player = (name: (typeof names)[number]) => players[name] as (typeof players)[string];
    await until(() => {
      const roster = new Map<string, boolean>();
      for (const m of host.seen)
        if (m.type === 'roster') for (const e of m.upsert) roster.set(e.nickname, e.connected);
      return names.every((n) => roster.get(n) === true);
    }, 'the host to see all five players connected');

    // ---- One question round -----------------------------------------------------------------
    const everyone = () => [host, ...names.map((n) => player(n).client)];
    const hostPhase = () => {
      const last = host.seen.filter((m) => m.type === 'host.state' || m.type === 'welcome').at(-1);
      if (last === undefined || !('snapshot' in last)) throw new Error('no host state');
      return { phase: last.snapshot.phase, questionIndex: last.snapshot.questionIndex };
    };
    const advance = async () => {
      everyone().forEach((c) => c.reset());
      host.send({ type: 'host.next', from: hostPhase() });
    };
    const answerWhenOpen = async (
      who: (typeof names)[number],
      questionIndex: number,
      payload: object,
      openAt: number,
    ) => {
      await sleep(Math.max(0, openAt - Date.now()) + 30);
      player(who).client.send({ type: 'answer', questionIndex, payload });
      const ack = await player(who).client.waitFor('answer.ack', (m) => m.index === questionIndex);
      expect(ack).toMatchObject({ status: 'accepted' });
    };
    const closeAndReveal = async (
      questionIndex: number,
      expectPlayers: Array<(typeof names)[number]>,
    ) => {
      expectPlayers.forEach((n) => player(n).client.reset());
      host.reset();
      host.send({ type: 'host.close', questionIndex, reason: 'manual' });
      const revealed = await host.waitFor('host.state', (m) => m.snapshot.phase === 'reveal');
      expect(revealed.snapshot.result).toBeDefined();
      return revealed.snapshot;
    };

    // ---- Question 0 (single choice) --------------------------------------------------------
    await advance();
    const q0 = await player('Alice').client.waitFor('question');
    expect(q0).toMatchObject({ index: 0, total: 3 });
    // Players never see the correct answer before the reveal (ADR-0004).
    expect(JSON.stringify(q0)).not.toContain('correctOptionId');
    await Promise.all(names.map((n) => player(n).client.waitFor('question')));
    const openAt0 = q0.openAt;
    // The server-side lead is at least the Lambda minimum (ADR-0005).
    expect(q0.openAt - q0.ts).toBeGreaterThanOrEqual(1000);

    await answerWhenOpen('Alice', 0, { kind: 'choice', optionId: 'opt-paris' }, openAt0);
    await answerWhenOpen('Bobby', 0, { kind: 'choice', optionId: 'opt-paris' }, openAt0);
    await answerWhenOpen('Carol', 0, { kind: 'choice', optionId: 'opt-paris' }, openAt0);
    await answerWhenOpen('Daniel', 0, { kind: 'choice', optionId: 'opt-rome' }, openAt0);
    // Erin does not answer.

    // ---- Bobby reconnects mid-question and resumes ----------------------------------------
    const bobby = player('Bobby');
    // Reset first: the roster update can beat the client's own close event.
    host.reset();
    bobby.client.close();
    await bobby.client.waitClosed();
    await host.waitFor('roster', (m) =>
      m.upsert.some((e) => e.nickname === 'Bobby' && !e.connected),
    );
    const resumed = await openClient('Bobby-2');
    resumed.send({ type: 'resume', v, sessionId, playerId: bobby.playerId, token: bobby.token });
    const back = await resumed.waitFor('welcome');
    expect(back).toMatchObject({
      role: 'player',
      snapshot: { phase: 'question', questionIndex: 0, you: { nickname: 'Bobby' } },
    });
    // Resume carries the answer already given, so the phone does not offer it again.
    expect(back.role === 'player' ? back.snapshot.responses : undefined).toEqual([
      { kind: 'choice', optionId: 'opt-paris' },
    ]);
    bobby.client = resumed;
    await host.waitFor('roster', (m) =>
      m.upsert.some((e) => e.nickname === 'Bobby' && e.connected),
    );

    // ---- Reveal 0 ------------------------------------------------------------------------------
    const snapshot0 = await closeAndReveal(0, [...names]);
    expect(snapshot0.result).toMatchObject({
      type: 'single',
      answered: 4,
      correctOptionId: 'opt-paris',
    });
    const outcomes0 = new Map<
      string,
      Extract<Awaited<ReturnType<Client['waitFor']>>, { type: 'reveal' }>
    >();
    for (const n of names) outcomes0.set(n, (await player(n).client.waitFor('reveal')) as never);
    for (const n of ['Alice', 'Bobby', 'Carol'] as const) {
      const you = outcomes0.get(n)?.you;
      expect(you, n).toMatchObject({ answered: true, correct: true });
      expect(you?.points).toBeGreaterThanOrEqual(400);
      expect(you?.points).toBeLessThanOrEqual(1000);
    }
    expect(outcomes0.get('Daniel')?.you).toMatchObject({
      answered: true,
      correct: false,
      points: 0,
    });
    expect(outcomes0.get('Erin')?.you).toMatchObject({ answered: false, points: 0 });

    // ---- Leaderboard 0 -------------------------------------------------------------------------
    await advance();
    const board0 = await player('Alice').client.waitFor('leaderboard');
    expect(board0.entries.length).toBeGreaterThan(0);
    expect(board0.entries[0]?.rank).toBe(1);
    expect(board0.you.rank).not.toBeNull();

    // ---- Erin is kicked: told, disconnected by DeleteConnection, and refused on resume --------
    const erin = player('Erin');
    host.reset();
    host.send({ type: 'host.kick', playerId: erin.playerId });
    await erin.client.waitFor('kicked');
    await erin.client.waitClosed();
    await host.waitFor('roster', (m) => m.removed.includes(erin.playerId));
    const retry = await openClient('Erin-2');
    retry.send({ type: 'resume', v, sessionId, playerId: erin.playerId, token: erin.token });
    expect(await retry.waitFor('error')).toMatchObject({ code: 'kicked' });
    await retry.waitClosed();

    // ---- Question 1 (true/false), four players left --------------------------------------------
    const remaining = ['Alice', 'Bobby', 'Carol', 'Daniel'] as const;
    await advance();
    const q1 = await player('Alice').client.waitFor('question');
    expect(q1.index).toBe(1);
    await answerWhenOpen('Alice', 1, { kind: 'boolean', value: false }, q1.openAt);
    await answerWhenOpen('Bobby', 1, { kind: 'boolean', value: true }, q1.openAt);
    await answerWhenOpen('Carol', 1, { kind: 'boolean', value: false }, q1.openAt);
    await answerWhenOpen('Daniel', 1, { kind: 'boolean', value: false }, q1.openAt);
    const snapshot1 = await closeAndReveal(1, [...remaining]);
    expect(snapshot1.result).toMatchObject({ type: 'truefalse', answered: 4, totalPlayers: 4 });
    expect((await player('Bobby').client.waitFor('reveal')).you.correct).toBe(false);
    expect((await player('Daniel').client.waitFor('reveal')).you.correct).toBe(true);
    await advance();
    await player('Alice').client.waitFor('leaderboard');

    // ---- Question 2 (single choice) ------------------------------------------------------------
    await advance();
    const q2 = await player('Alice').client.waitFor('question');
    expect(q2.index).toBe(2);
    for (const n of remaining) {
      await answerWhenOpen(
        n,
        2,
        { kind: 'choice', optionId: n === 'Carol' ? 'opt-eight' : 'opt-seven' },
        q2.openAt,
      );
    }
    await closeAndReveal(2, [...remaining]);
    await advance();
    await player('Alice').client.waitFor('leaderboard');

    // ---- The end -------------------------------------------------------------------------------
    await advance();
    const ended = await Promise.all(remaining.map((n) => player(n).client.waitFor('ended')));
    for (const message of ended) {
      expect(message.totalPlayers).toBe(4);
      expect(message.podium.length).toBeGreaterThanOrEqual(3);
      expect(message.you.scoredQuestions).toBe(3);
    }
    const podium = ended[0]?.podium ?? [];
    expect(podium.map((p) => p.rank)).toEqual([...podium.map((p) => p.rank)].sort((a, b) => a - b));
    // Alice is the only player right on all three questions, and she always answers first, inside
    // the full-points window, so this adds up scoring across every reveal write in DynamoDB.
    // Everyone else is right at most twice.
    expect(podium[0]).toMatchObject({ nickname: 'Alice', rank: 1 });
    expect(ended[0]?.you).toMatchObject({ rank: 1, correct: 3 });
    for (const other of podium.slice(1)) {
      expect(podium[0]?.score).toBeGreaterThan(other.score);
    }
    await host.waitFor('host.state', (m) => m.snapshot.phase === 'ended');

    // ---- Everything that arrived was valid protocol -----------------------------------------------
    for (const c of [host, ...names.map((n) => player(n).client), resumed]) {
      expect(c.invalid, c.name).toEqual([]);
    }
    // Every frame carries the transport's own timestamp, taken while this test was running.
    const stamps = host.frames.map((f) => (JSON.parse(f) as { ts: number }).ts);
    expect(stamps.length).toBeGreaterThan(10);
    expect(stamps.every((t) => Number.isInteger(t) && t >= startedAt && t <= Date.now())).toBe(
      true,
    );

    // ---- The CSV export goes through the gateway too -------------------------------------------
    const csv = await api('GET', `/api/sessions/${sessionId}/results.csv`, { token });
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(csv.text).toContain('Alice');
    expect(csv.headers.get('content-disposition')).toContain(`zqhoot-${pin}-`);
    const listed = await api('GET', '/api/sessions', { token });
    expect(listed.json<Array<{ sessionId: string }>>().some((s) => s.sessionId === sessionId)).toBe(
      true,
    );

    everyone().forEach((c) => c.isOpen && c.close());
    resumed.close();

    // The real transport never failed to post, and no handler logged an error.
    const log = emu.output.join('');
    expect(log).not.toContain('"level":"error"');
    expect(log).not.toContain('post failed');
  }, 90_000);
});

describe('the gateway behaves like API Gateway', () => {
  it('runs each connection strictly one invocation at a time, in order, while connections run in parallel', async () => {
    const a = await openClient('burst-a');
    const b = await openClient('burst-b');
    for (let t = 1; t <= 40; t++) {
      a.send({ type: 'ping', t });
      b.send({ type: 'ping', t: 1000 + t });
    }
    await until(
      () =>
        a.seen.filter((m) => m.type === 'pong').length === 40 &&
        b.seen.filter((m) => m.type === 'pong').length === 40,
      'all pongs',
    );
    const order = (c: Client) => c.seen.flatMap((m) => (m.type === 'pong' ? [m.t] : []));
    expect(order(a)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    expect(order(b)).toEqual(Array.from({ length: 40 }, (_, i) => 1001 + i));

    const s = await stats();
    expect(s.maxInFlightPerConnection).toBe(1);
    expect(s.maxInFlight).toBeGreaterThan(1);
    a.close();
    b.close();
  });

  it('shapes events like API Gateway: the real SDK client can post to, read and delete a connection', async () => {
    const management = new ApiGatewayManagementApiClient({
      endpoint: emu.info.callback,
      region: 'us-east-1',
      credentials: { accessKeyId: 'x', secretAccessKey: 'y' },
    });
    const known = new Set((await connections()).map((c) => c.id));
    const client = await openClient('managed');
    let id = '';
    await until(async () => {
      id = (await connections()).find((c) => !known.has(c.id))?.id ?? '';
      return id !== '';
    }, 'the new connection to be registered');
    // The real ids end in "=", which the SDK percent-encodes in the path.
    expect(id).toMatch(/^[A-Za-z0-9_-]{15}=$/);

    client.reset();
    await management.send(
      new PostToConnectionCommand({
        ConnectionId: id,
        Data: new TextEncoder().encode('{"hello":"world"}'),
      }),
    );
    await until(() => client.frames.includes('{"hello":"world"}'), 'the posted frame');

    const info = await management.send(new GetConnectionCommand({ ConnectionId: id }));
    expect(info.Identity?.SourceIp).toBeTruthy();
    expect(info.ConnectedAt).toBeInstanceOf(Date);

    await management.send(new DeleteConnectionCommand({ ConnectionId: id }));
    await client.waitClosed();

    // Once closed, every management call answers 410 with a GoneException the SDK recognises.
    await expect(
      management.send(
        new PostToConnectionCommand({ ConnectionId: id, Data: new Uint8Array([123, 125]) }),
      ),
    ).rejects.toBeInstanceOf(GoneException);
    await expect(
      management.send(new GetConnectionCommand({ ConnectionId: id })),
    ).rejects.toBeInstanceOf(GoneException);
    await expect(
      management.send(new DeleteConnectionCommand({ ConnectionId: 'never-existed=' })),
    ).rejects.toMatchObject({ $metadata: { httpStatusCode: 410 } });
  });

  it('rejects an oversize frame with 1009, as API Gateway does above 32 KB', async () => {
    const client = await openClient('big');
    client.send({ type: 'ping', t: 1, pad: 'x'.repeat(40_000) });
    expect(await client.waitClosed()).toBe(1009);
  });

  it('answers non-WebSocket requests on the WebSocket port with 426', async () => {
    const res = await fetch(emu.info.ws.replace('ws://', 'http://'));
    expect(res.status).toBe(426);
  });
});

describe('shutdown', () => {
  it('closes open sockets with 1001, runs their $disconnect, and exits 0 on SIGTERM', async () => {
    const shutdownTable = uniqueTableName('emu-stop');
    const second = await startEmulatorProcess({ table: shutdownTable, webDist });
    const base = second.info.http;
    try {
      const login = await api(
        'POST',
        '/api/auth/login',
        {
          body: { username: 'admin', password: 'admin' },
        },
        base,
      );
      const { token } = login.json<{ token: string }>();
      const quizId = (await api('POST', '/api/quizzes', { token, body: quiz }, base)).json<{
        id: string;
      }>().id;
      const { sessionId, pin } = (
        await api('POST', '/api/sessions', { token, body: { quizId } }, base)
      ).json<{ sessionId: string; pin: string }>();

      const client = await Client.open('stopping', second.info.ws, second.info.origin);
      client.send({ type: 'join', v, pin, nickname: 'Sam' });
      await client.waitFor('welcome');
      const store = new DynamoStore({ tableName: shutdownTable, client: doc });
      expect(await store.listConnections(sessionId)).toHaveLength(1);

      const exitCode = await second.stop();

      expect(await client.waitClosed()).toBe(1001);
      expect(exitCode).toBe(0);
      // The process waited for the ws handler's `$disconnect`, which deleted the connection.
      expect(await store.listConnections(sessionId)).toEqual([]);
    } finally {
      await second.stop();
      await dropTable(doc, shutdownTable);
    }
  });
});
