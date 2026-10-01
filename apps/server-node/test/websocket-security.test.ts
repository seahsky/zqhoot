import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '@zqhoot/protocol';
import {
  TestSocket,
  apiFor,
  createQuiz,
  createSession,
  joinPlayer,
  login,
} from './helpers/client.ts';
import { createWorkspace, startServer } from './helpers/server.ts';
import type { TestServer, Workspace } from './helpers/server.ts';

let workspace: Workspace;
let server: TestServer;

beforeAll(async () => {
  workspace = await createWorkspace();
  server = await startServer(workspace);
});

afterAll(async () => {
  await server.close();
  await workspace.cleanup();
});

/** Resolves with the HTTP status of a refused upgrade, or the error of one that was cut off. */
function refusedUpgrade(url: string, origin: string | null): Promise<number | Error> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, origin === null ? {} : { origin });
    ws.once('open', () => {
      ws.close();
      resolve(new Error('the upgrade was accepted'));
    });
    ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.once('error', (err) => resolve(err));
  });
}

describe('websocket upgrade', () => {
  it('answers 403 to a foreign Origin', async () => {
    expect(await refusedUpgrade(server.ws, 'https://evil.example')).toBe(403);
  });

  it('answers 403 to a missing Origin', async () => {
    expect(await refusedUpgrade(server.ws, null)).toBe(403);
  });

  it('answers 403 to the right host on another scheme or port', async () => {
    expect(await refusedUpgrade(server.ws, 'https://quiz.test')).toBe(403);
    expect(await refusedUpgrade(server.ws, 'http://quiz.test:81')).toBe(403);
  });

  it('accepts the public origin', async () => {
    const socket = await TestSocket.connectTo(server);
    socket.close();
  });

  it('destroys an upgrade on any other path', async () => {
    for (const path of ['/', '/api/ws', '/ws/', '/wss', '/socket']) {
      const outcome = await refusedUpgrade(`ws://127.0.0.1:${server.port}${path}`, server.origin);
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).not.toBe('the upgrade was accepted');
    }
  });

  it('does not treat a plain GET of /ws as an upgrade', async () => {
    const res = await fetch(`${server.http}/ws`);
    expect(res.status).toBe(404);
  });
});

describe('websocket limits', () => {
  it('closes the socket with 1009 on a frame of 8193 bytes', async () => {
    const socket = await TestSocket.connectTo(server);
    socket.ws.send('x'.repeat(8193));
    expect((await socket.closed).code).toBe(1009);
  });

  it('answers a frame of 8192 bytes with bad-request and keeps the socket open', async () => {
    const socket = await TestSocket.connectTo(server);
    socket.ws.send('x'.repeat(8192));
    expect((await socket.next('error')).code).toBe('bad-request');
    expect(socket.ws.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });

  it('answers a frame over the 4 KB message cap with bad-request', async () => {
    const socket = await TestSocket.connectTo(server);
    socket.ws.send(JSON.stringify({ type: 'ping', t: 1, pad: 'x'.repeat(5000) }));
    const error = await socket.next('error');
    expect(error.code).toBe('bad-request');
    socket.close();
  });

  it('refuses binary frames', async () => {
    const socket = await TestSocket.connectTo(server);
    socket.ws.send(Buffer.from([1, 2, 3]));
    expect((await socket.next('error')).code).toBe('bad-request');
    socket.close();
  });

  it('answers a flood with rate-limited and closes with 1008', async () => {
    const socket = await TestSocket.connectTo(server);
    for (let i = 0; i < 60; i++) socket.send({ type: 'ping', t: i });
    const closed = await socket.closed;
    expect(closed.code).toBe(1008);
    const error = await socket.next('error', (e) => e.code === 'rate-limited');
    expect(error.message).toMatch(/too many/);
    // The 20 messages inside the burst were answered before the limit hit.
    expect(socket.inbox.filter((m) => m.type === 'pong').length).toBeLessThanOrEqual(20);
  });

  it('lets a steady 10 messages per second through', async () => {
    const socket = await TestSocket.connectTo(server);
    for (let i = 0; i < 25; i++) {
      socket.send({ type: 'ping', t: i });
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(socket.ws.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });

  it('answers ping with pong', async () => {
    const socket = await TestSocket.connectTo(server);
    socket.send({ type: 'ping', t: 42 });
    expect((await socket.next('pong')).t).toBe(42);
    socket.close();
  });

  it('serves each connection its frames in order', async () => {
    const api = apiFor(server);
    const token = await login(api);
    const quiz = await createQuiz(api, token);
    const { pin } = await createSession(api, token, quiz.id);
    const socket = await TestSocket.connectTo(server);
    // The second frame needs the connection the first one registers.
    socket.send({ type: 'join', v: PROTOCOL_VERSION, pin, nickname: 'Order' });
    socket.send({
      type: 'answer',
      questionIndex: 0,
      payload: { kind: 'choice', optionId: 'opt-aaaaaa' },
    });
    await socket.next('welcome');
    const ack = await socket.next('answer.ack');
    expect(ack.status).toBe('rejected');
    expect(ack.reason).toBe('not-open');
    socket.close();
  });
});

describe('connection cleanup', () => {
  it('forgets the connection when the socket closes', async () => {
    const api = apiFor(server);
    const token = await login(api);
    const quiz = await createQuiz(api, token);
    const { sessionId, pin } = await createSession(api, token, quiz.id);
    const player = await joinPlayer(server, pin, 'Gone');
    expect(await server.handle.store.listConnections(sessionId)).toHaveLength(1);
    player.socket.ws.terminate();
    await player.socket.closed;
    await expectEventually(async () =>
      expect(await server.handle.store.listConnections(sessionId)).toHaveLength(0),
    );
  });
});

async function expectEventually(check: () => Promise<void>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await check();
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
