import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@zqhoot/protocol';
import { TestSocket, apiFor, createQuiz, createSession, login } from './helpers/client.ts';
import { createWorkspace, startServer } from './helpers/server.ts';
import type { TestServer, Workspace } from './helpers/server.ts';

/** The failed-PIN budget (ADR-0013) as the real VM server applies it to WebSocket joins. */
let workspace: Workspace;
let proxyWorkspace: Workspace;
let direct: TestServer;
let proxied: TestServer;

beforeAll(async () => {
  workspace = await createWorkspace();
  direct = await startServer(workspace, { env: { ZQ_TRUST_PROXY: 'false' } });
  proxyWorkspace = await createWorkspace();
  proxied = await startServer(proxyWorkspace, { env: { ZQ_TRUST_PROXY: 'true' } });
});

afterAll(async () => {
  await direct.close();
  await proxied.close();
  await workspace.cleanup();
  await proxyWorkspace.cleanup();
});

/** One join on a socket of its own, as a scanner opening a new connection per guess would send it. */
async function join(
  server: TestServer,
  pin: string,
  opts: { forwardedFor?: string; nickname?: string } = {},
): Promise<{ code: string } | { welcome: true }> {
  const socket = await TestSocket.connectTo(
    server,
    opts.forwardedFor === undefined ? {} : { 'X-Forwarded-For': opts.forwardedFor },
  );
  try {
    socket.send({ type: 'join', v: PROTOCOL_VERSION, pin, nickname: opts.nickname ?? 'Kid' });
    const reply = await Promise.race([
      socket.next('welcome').then(() => ({ welcome: true as const })),
      socket.next('error').then((e) => ({ code: e.code })),
    ]);
    return reply;
  } finally {
    socket.close();
  }
}

const httpLookup = (server: TestServer, pin: string, forwardedFor?: string) =>
  fetch(`${server.http}/api/join/${pin}`, {
    headers: forwardedFor === undefined ? {} : { 'X-Forwarded-For': forwardedFor },
  }).then((res) => res.status);

async function liveSession(server: TestServer): Promise<string> {
  const api = apiFor(server);
  const token = await login(api);
  const quiz = await createQuiz(api, token);
  return (await createSession(api, token, quiz.id)).pin;
}

describe('WebSocket join and the per-IP failed-PIN budget', () => {
  it('refuses the 31st miss from one address, a new connection for every guess', async () => {
    for (let i = 0; i < 30; i++) {
      expect(
        await join(proxied, '000000', { forwardedFor: '198.51.100.20' }),
        `miss ${i + 1}`,
      ).toEqual({ code: 'not-found' });
    }
    expect(await join(proxied, '000000', { forwardedFor: '198.51.100.20' })).toEqual({
      code: 'rate-limited',
    });
  });

  it('refuses a live PIN from a blocked address and admits it from another', async () => {
    const pin = await liveSession(proxied);
    for (let i = 0; i < 31; i++) await join(proxied, '000000', { forwardedFor: '198.51.100.21' });
    expect(await join(proxied, pin, { forwardedFor: '198.51.100.21' })).toEqual({
      code: 'rate-limited',
    });
    expect(await join(proxied, pin, { forwardedFor: '198.51.100.22' })).toEqual({ welcome: true });
  });

  it('spends one budget with GET /api/join/:pin, both ways round', async () => {
    const pin = await liveSession(proxied);
    const httpFirst = '198.51.100.23';
    for (let i = 0; i < 20; i++) expect(await httpLookup(proxied, '000000', httpFirst)).toBe(404);
    for (let i = 0; i < 10; i++) {
      expect(await join(proxied, '000000', { forwardedFor: httpFirst })).toEqual({
        code: 'not-found',
      });
    }
    expect(await join(proxied, '000000', { forwardedFor: httpFirst })).toEqual({
      code: 'rate-limited',
    });
    expect(await httpLookup(proxied, pin, httpFirst)).toBe(429);

    const wsFirst = '198.51.100.24';
    for (let i = 0; i < 20; i++) {
      expect(await join(proxied, '000000', { forwardedFor: wsFirst })).toEqual({
        code: 'not-found',
      });
    }
    for (let i = 0; i < 10; i++) expect(await httpLookup(proxied, '000000', wsFirst)).toBe(404);
    expect(await httpLookup(proxied, '000000', wsFirst)).toBe(429);
    expect(await join(proxied, pin, { forwardedFor: wsFirst })).toEqual({ code: 'rate-limited' });
  });

  it('never limits a classroom of valid joins arriving from one address', async () => {
    const pin = await liveSession(proxied);
    const classroom = '198.51.100.25';
    for (let i = 0; i < 40; i++) {
      expect(await join(proxied, pin, { forwardedFor: classroom, nickname: `Desk ${i}` })).toEqual({
        welcome: true,
      });
    }
    expect(await join(proxied, '000000', { forwardedFor: classroom })).toEqual({
      code: 'not-found',
    });
  });

  it('attributes the miss to the socket address when the proxy is not trusted', async () => {
    // Forging X-Forwarded-For on the upgrade buys nothing: every guess is one client.
    for (let i = 0; i < 30; i++) {
      expect(await join(direct, '000000', { forwardedFor: `203.0.113.${i + 1}` })).toEqual({
        code: 'not-found',
      });
    }
    expect(await join(direct, '000000', { forwardedFor: '203.0.113.99' })).toEqual({
      code: 'rate-limited',
    });
    expect(await join(direct, '000000')).toEqual({ code: 'rate-limited' });
    expect(await httpLookup(direct, '000000', '203.0.113.150')).toBe(429);
  });
});
