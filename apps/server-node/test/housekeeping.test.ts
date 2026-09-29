import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { MemoryStore } from '@zqhoot/store';
import { TestSocket, sleep } from './helpers/client.ts';
import { createWorkspace, startServer } from './helpers/server.ts';
import type { Workspace } from './helpers/server.ts';

let workspace: Workspace;

beforeEach(async () => {
  workspace = await createWorkspace();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await workspace.cleanup();
});

describe('ping sweep', () => {
  it('terminates a socket that stops answering pings and keeps one that answers', async () => {
    const server = await startServer(workspace, { pingIntervalMs: 200 });
    try {
      const healthy = await TestSocket.connectTo(server);
      // A client that never answers protocol pings, like a phone that lost its network.
      const dead = new WebSocket(server.ws, { origin: server.origin, autoPong: false });
      await new Promise<void>((resolve, reject) => {
        dead.once('open', resolve);
        dead.once('error', reject);
      });
      const deadClosed = new Promise<number>((resolve) =>
        dead.once('close', (code) => resolve(code)),
      );

      // Sweep 1 marks both as unconfirmed and pings; sweep 2 finds the silent one and terminates it.
      expect(await deadClosed).toBe(1006);
      await sleep(700);
      expect(healthy.ws.readyState).toBe(WebSocket.OPEN);
      expect(server.handle.sockets.connections()).toBe(1);
      healthy.close();
    } finally {
      await server.close();
    }
  });

  it('runs a sweep every 30 s by default', async () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    const server = await startServer(workspace);
    try {
      expect(spy.mock.calls.map((call) => call[1])).toContain(30_000);
    } finally {
      await server.close();
    }
  });
});

describe('memory sweeper', () => {
  it('calls MemoryStore.sweepExpired on its interval and stops on close', async () => {
    const sweep = vi.spyOn(MemoryStore.prototype, 'sweepExpired');
    const server = await startServer(workspace, { sweepIntervalMs: 20 });
    await vi.waitFor(() => expect(sweep.mock.calls.length).toBeGreaterThanOrEqual(3));
    await server.close();
    const after = sweep.mock.calls.length;
    await sleep(100);
    expect(sweep.mock.calls.length).toBe(after);
  });

  it('runs every 60 s by default', async () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    const server = await startServer(workspace);
    try {
      expect(spy.mock.calls.map((call) => call[1])).toContain(60_000);
    } finally {
      await server.close();
    }
  });
});
