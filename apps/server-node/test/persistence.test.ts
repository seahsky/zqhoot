import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@zqhoot/protocol';
import {
  OPTION_A,
  TestSocket,
  apiFor,
  connectHost,
  createQuiz,
  createSession,
  joinPlayer,
  login,
  miniQuiz,
} from './helpers/client.ts';
import {
  ADMIN_PASSWORD,
  ADMIN_USER,
  JWT_SECRET,
  PUBLIC_URL,
  createWorkspace,
  startServer,
} from './helpers/server.ts';
import type { Workspace } from './helpers/server.ts';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

let workspace: Workspace;

beforeEach(async () => {
  workspace = await createWorkspace();
});

afterEach(() => workspace.cleanup());

describe('restart', () => {
  it('writes state.json on shutdown; a new instance resumes the session and the player', async () => {
    const first = await startServer(workspace);
    const api = apiFor(first);
    const hostToken = await login(api);
    const quiz = await createQuiz(api, hostToken);
    const { sessionId, pin } = await createSession(api, hostToken, quiz.id);
    const host = await connectHost(first, sessionId, hostToken);
    const player = await joinPlayer(first, pin, 'Ada');
    host.send({ type: 'host.next', from: { phase: 'lobby', questionIndex: -1 } });
    const question = await player.socket.next('question');

    await first.close();
    expect((await player.socket.closed).code).toBe(1001);
    expect((await host.closed).code).toBe(1001);
    const state = JSON.parse(await readFile(join(workspace.dataDir, 'state.json'), 'utf8')) as {
      sessions: Array<{ sessionId: string; meta?: { value: { phase: string } } }>;
    };
    expect(state.sessions.find((s) => s.sessionId === sessionId)?.meta?.value.phase).toBe(
      'question',
    );

    const second = await startServer(workspace);
    try {
      expect(second.handle.scheduler.pending).toBe(1);
      const resumed = await TestSocket.connectTo(second);
      resumed.send({
        type: 'resume',
        v: PROTOCOL_VERSION,
        sessionId,
        playerId: player.playerId,
        token: player.token,
      });
      const welcome = await resumed.next('welcome');
      if (welcome.role !== 'player') throw new Error('expected a player welcome');
      expect(welcome.snapshot).toMatchObject({ sessionId, phase: 'question', questionIndex: 0 });
      expect(welcome.snapshot.you.nickname).toBe('Ada');
      expect(welcome.snapshot.question?.openAt).toBe(question.openAt);

      // The restored session still takes answers and the host can carry on.
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, question.openAt - Date.now()) + 30),
      );
      resumed.send({
        type: 'answer',
        questionIndex: 0,
        payload: { kind: 'choice', optionId: OPTION_A },
      });
      expect((await resumed.next('answer.ack')).status).toBe('accepted');
      const hostAgain = await connectHost(second, sessionId, await login(apiFor(second)));
      hostAgain.send({ type: 'host.close', questionIndex: 0, reason: 'manual' });
      expect((await resumed.next('reveal')).you.correct).toBe(true);
      resumed.close();
      hostAgain.close();
    } finally {
      await second.close();
    }
  });

  it('forgets connections of the previous process instead of showing players as connected', async () => {
    const first = await startServer(workspace);
    const api = apiFor(first);
    const hostToken = await login(api);
    const quiz = await createQuiz(api, hostToken);
    const { sessionId, pin } = await createSession(api, hostToken, quiz.id);
    const player = await joinPlayer(first, pin, 'Bo');
    // Simulates a crash: the state file still lists the connection.
    await first.handle.store.putConnection({
      connectionId: 'stale-connection',
      sessionId,
      role: 'player',
      playerId: player.playerId,
      connectedAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
    });
    await first.close();

    const second = await startServer(workspace);
    try {
      expect(await second.handle.store.listConnections(sessionId)).toEqual([]);
      const host = await connectHost(second, sessionId, await login(apiFor(second)));
      host.close();
    } finally {
      await second.close();
    }
  });

  it('closes a question whose deadline passed while the server was down', async () => {
    const first = await startServer(workspace);
    const api = apiFor(first);
    const hostToken = await login(api);
    const quiz = await createQuiz(api, hostToken, miniQuiz(5, 5));
    const { sessionId } = await createSession(api, hostToken, quiz.id);
    const host = await connectHost(first, sessionId, hostToken);
    host.send({ type: 'host.next', from: { phase: 'lobby', questionIndex: -1 } });
    await host.next('host.state', (s) => s.snapshot.phase === 'question');
    await first.close();

    // An hour later on the server's clock: the deadline is long past, so the restored timer fires at once.
    const hourLater = { now: () => Date.now() + 3_600_000 };
    const second = await startServer(workspace, { clock: hourLater });
    try {
      await vi.waitFor(async () => {
        expect((await second.handle.store.getSession(sessionId))?.phase).toBe('reveal');
      });
      expect(second.handle.scheduler.pending).toBe(0);
    } finally {
      await second.close();
    }
  });

  it('starts empty when there is no state file and reports a corrupt one', async () => {
    const fresh = await startServer(workspace);
    expect(await login(apiFor(fresh))).toBeTruthy();
    await fresh.close();

    await writeFile(join(workspace.dataDir, 'state.json'), '{not json');
    await expect(startServer(workspace)).rejects.toThrow(/not valid JSON/);
  });
});

describe('SIGTERM', () => {
  let child: ChildProcess | undefined;

  afterEach(() => {
    child?.kill('SIGKILL');
  });

  it('stops accepting, exits 0 within the deadline, and leaves state.json behind', async () => {
    child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      cwd: packageRoot,
      env: {
        PATH: process.env.PATH ?? '',
        ZQ_PORT: '0',
        ZQ_HOST: '127.0.0.1',
        ZQ_PUBLIC_URL: PUBLIC_URL,
        ZQ_DATA_DIR: workspace.dataDir,
        ZQ_WEB_DIST: workspace.webDist,
        ZQ_ADMIN_USER: ADMIN_USER,
        ZQ_ADMIN_PASSWORD: ADMIN_PASSWORD,
        ZQ_JWT_SECRET: JWT_SECRET,
      },
    });
    let output = '';
    child.stdout?.on('data', (d: Buffer) => (output += d.toString()));
    const exited = new Promise<number | null>((resolve) => child?.on('close', resolve));

    const port = await vi.waitFor(
      () => {
        const line = output.split('\n').find((l) => l.includes('zqhoot server listening'));
        if (line === undefined) throw new Error('not listening yet');
        return (JSON.parse(line) as { port: number }).port;
      },
      { timeout: 15_000, interval: 50 },
    );
    const base = `http://127.0.0.1:${port}`;
    const server = { http: base } as Parameters<typeof apiFor>[0];
    const api = apiFor(server);
    const token = await login(api);
    const quiz = await createQuiz(api, token);
    const started = Date.now();
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(output).toContain('shutting down');

    const state = JSON.parse(await readFile(join(workspace.dataDir, 'state.json'), 'utf8')) as {
      quizzes: Array<{ id: string }>;
    };
    expect(state.quizzes.map((q) => q.id)).toEqual([quiz.id]);
    expect((await stat(join(workspace.dataDir, 'state.json'))).mode & 0o777).toBe(0o600);

    const after = await startServer(workspace);
    try {
      const list = await apiFor(after)('GET', '/api/quizzes', {
        token: await login(apiFor(after)),
      });
      expect(((await list.json()) as Array<{ id: string }>).map((q) => q.id)).toEqual([quiz.id]);
    } finally {
      await after.close();
    }
  });
});
