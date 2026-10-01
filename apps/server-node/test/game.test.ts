import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@zqhoot/protocol';
import {
  OPTION_A,
  OPTION_B,
  TestSocket,
  apiFor,
  connectHost,
  createQuiz,
  createSession,
  joinPlayer,
  login,
  sleep,
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

/** Waits until the question is open, on the server's clock (`openAt` is server time; both are `Date.now`). */
async function untilOpen(openAt: number): Promise<void> {
  await sleep(Math.max(0, openAt - Date.now()) + 30);
}

describe('a game on real sockets', () => {
  it('plays a whole quiz: join, answer, reveal, leaderboard, timer close, resume, ended', async () => {
    const api = apiFor(server);
    const hostToken = await login(api);
    const quiz = await createQuiz(api, hostToken);
    const { sessionId, pin } = await createSession(api, hostToken, quiz.id);

    const lookup = await api('GET', `/api/join/${pin}`);
    expect(await lookup.json()).toMatchObject({ sessionId, joinable: true });

    const host = await connectHost(server, sessionId, hostToken);
    const ada = await joinPlayer(server, pin, 'Ada');
    const bo = await joinPlayer(server, pin, 'Bo');
    const cy = await joinPlayer(server, pin, 'Cy');
    const players = [ada, bo, cy];
    expect((await host.next('roster', (r) => r.upsert.length > 0)).upsert[0]?.connected).toBe(true);

    // Question 1: Ada and Bo answer A (correct), Cy answers B. The host closes it by hand.
    host.send({ type: 'host.next', from: { phase: 'lobby', questionIndex: -1 } });
    const q1 = await Promise.all(players.map((p) => p.socket.next('question')));
    expect(q1[0]?.index).toBe(0);
    expect(JSON.stringify(q1[0])).not.toContain('correctOptionId');
    await untilOpen(q1[0]?.openAt ?? 0);
    ada.socket.send({
      type: 'answer',
      questionIndex: 0,
      payload: { kind: 'choice', optionId: OPTION_A },
    });
    bo.socket.send({
      type: 'answer',
      questionIndex: 0,
      payload: { kind: 'choice', optionId: OPTION_A },
    });
    cy.socket.send({
      type: 'answer',
      questionIndex: 0,
      payload: { kind: 'choice', optionId: OPTION_B },
    });
    for (const p of players) expect((await p.socket.next('answer.ack')).status).toBe('accepted');

    host.send({ type: 'host.close', questionIndex: 0, reason: 'manual' });
    const reveals = await Promise.all(players.map((p) => p.socket.next('reveal')));
    expect(reveals.map((r) => r.you.correct)).toEqual([true, true, false]);
    expect(reveals[0]?.you.points).toBeGreaterThan(0);
    expect(reveals[2]?.you.points).toBe(0);

    host.send({ type: 'host.next', from: { phase: 'reveal', questionIndex: 0 } });
    const boards = await Promise.all(players.map((p) => p.socket.next('leaderboard')));
    expect(
      boards[0]?.entries
        .map((e) => e.nickname)
        .slice(0, 2)
        .sort(),
    ).toEqual(['Ada', 'Bo']);

    // Question 2 has a 5 s limit and nobody closes it: the server's own timer must.
    host.send({ type: 'host.next', from: { phase: 'leaderboard', questionIndex: 0 } });
    const q2 = await Promise.all(
      players.map((p) => p.socket.next('question', (q) => q.index === 1)),
    );
    const opensAt = q2[0]?.openAt ?? 0;
    await untilOpen(opensAt);
    ada.socket.send({
      type: 'answer',
      questionIndex: 1,
      payload: { kind: 'boolean', value: true },
    });
    await ada.socket.next('answer.ack');

    // Bo's connection drops mid-question and comes back with `resume`.
    bo.socket.ws.terminate();
    await bo.socket.closed;
    const back = await TestSocket.connectTo(server);
    back.send({
      type: 'resume',
      v: PROTOCOL_VERSION,
      sessionId,
      playerId: bo.playerId,
      token: bo.token,
    });
    const welcome = await back.next('welcome');
    expect(welcome.role).toBe('player');
    if (welcome.role !== 'player') throw new Error('unreachable');
    expect(welcome.snapshot.phase).toBe('question');
    expect(welcome.snapshot.questionIndex).toBe(1);
    expect(welcome.snapshot.question?.question.type).toBe('truefalse');
    expect(welcome.credentials).toBeUndefined();
    back.send({ type: 'answer', questionIndex: 1, payload: { kind: 'boolean', value: false } });
    expect((await back.next('answer.ack')).status).toBe('accepted');

    const startedWaiting = Date.now();
    const timerReveals = await Promise.all([
      ada.socket.next('reveal', () => true, 15_000),
      back.next('reveal', () => true, 15_000),
      cy.socket.next('reveal', () => true, 15_000),
    ]);
    // openAt + 5 s limit + 750 ms grace: the reveal cannot come earlier, and no host message caused it.
    expect(Date.now()).toBeGreaterThanOrEqual((q2[0]?.deadline ?? 0) + 700);
    expect(Date.now() - startedWaiting).toBeLessThan(15_000);
    expect(timerReveals.map((r) => r.you.correct)).toEqual([true, false, false]);
    const hostState = await host.next(
      'host.state',
      (s) => s.snapshot.phase === 'reveal' && s.snapshot.questionIndex === 1,
    );
    expect(hostState.snapshot.result?.type).toBe('truefalse');

    host.send({ type: 'host.next', from: { phase: 'reveal', questionIndex: 1 } });
    await Promise.all([ada.socket, back, cy.socket].map((s) => s.next('leaderboard')));
    host.send({ type: 'host.next', from: { phase: 'leaderboard', questionIndex: 1 } });
    const ended = await Promise.all([ada.socket, back, cy.socket].map((s) => s.next('ended')));
    expect(ended[0]?.podium[0]?.nickname).toBe('Ada');
    expect(ended.map((e) => e.you.rank)).toEqual([1, 2, 3]);

    for (const socket of [host, ada.socket, back, bo.socket, cy.socket]) socket.close();
  }, 40_000);

  it('rejects a resume with a wrong token', async () => {
    const api = apiFor(server);
    const hostToken = await login(api);
    const quiz = await createQuiz(api, hostToken);
    const { sessionId, pin } = await createSession(api, hostToken, quiz.id);
    const player = await joinPlayer(server, pin, 'Dee');
    player.socket.close();
    await player.socket.closed;

    const socket = await TestSocket.connectTo(server);
    socket.send({
      type: 'resume',
      v: PROTOCOL_VERSION,
      sessionId,
      playerId: player.playerId,
      token: 'x'.repeat(43),
    });
    expect((await socket.next('error')).code).toBe('unauthorized');
    socket.close();
  });
});
