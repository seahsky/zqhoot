import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TIMING } from '@zqhoot/protocol';
import type { Clock } from '@zqhoot/service';
import {
  OPTION_A,
  apiFor,
  connectHost,
  createQuiz,
  createSession,
  joinPlayer,
  login,
  miniQuiz,
} from './helpers/client.ts';
import { createWorkspace, startServer } from './helpers/server.ts';
import type { TestServer, Workspace } from './helpers/server.ts';

/**
 * The server's time is a variable here, so nothing depends on how fast this machine runs: the
 * only real waiting is the scheduler's own timer, which cannot fire before the clock says so.
 */
class ManualClock implements Clock {
  #t = Date.now();
  now(): number {
    return this.#t;
  }
  set(t: number): void {
    this.#t = t;
  }
}

let workspace: Workspace;
let server: TestServer;
const clock = new ManualClock();

beforeAll(async () => {
  workspace = await createWorkspace();
  server = await startServer(workspace, { clock });
});

afterAll(async () => {
  await server.close();
  await workspace.cleanup();
});

describe('the answer grace on the VM (ADR-0005)', () => {
  it('lets the scheduler close at deadline + grace when the host asks for the timer close early', async () => {
    const api = apiFor(server);
    const hostToken = await login(api);
    const quiz = await createQuiz(api, hostToken, miniQuiz(5, null));
    const { sessionId, pin } = await createSession(api, hostToken, quiz.id);
    const host = await connectHost(server, sessionId, hostToken);
    const ada = await joinPlayer(server, pin, 'Ada');

    host.send({ type: 'host.next', from: { phase: 'lobby', questionIndex: -1 } });
    const question = await ada.socket.next('question');
    const deadline = question.deadline as number;

    // The host's clock reads deadline + 50 ms and its timer close goes out. A ping behind it
    // proves the server has dealt with the close, since frames of one socket are served in order.
    clock.set(deadline + 50);
    host.send({ type: 'host.close', questionIndex: 0, reason: 'timer' });
    host.send({ type: 'ping', t: 1 });
    await host.next('pong');
    expect(await server.handle.store.getSession(sessionId)).toMatchObject({ phase: 'question' });

    // Ada's answer, sent before the deadline over a slow link, arrives 300 ms after it.
    clock.set(deadline + 300);
    ada.socket.send({
      type: 'answer',
      questionIndex: 0,
      payload: { kind: 'choice', optionId: OPTION_A },
    });
    expect((await ada.socket.next('answer.ack')).status).toBe('accepted');

    // The scheduler was armed for deadline + grace when the question opened.
    clock.set(deadline + TIMING.answerGraceMs);
    const reveal = await ada.socket.next('reveal', () => true, 15_000);
    expect(reveal.you).toMatchObject({ answered: true, correct: true, points: 400 });
    expect(await server.handle.store.getSession(sessionId)).toMatchObject({
      phase: 'reveal',
      closedAt: deadline + TIMING.answerGraceMs,
    });

    for (const socket of [host, ada.socket]) socket.close();
  }, 30_000);
});
