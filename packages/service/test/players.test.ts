import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { describeWithStores } from './harness.ts';
import type { Harness } from './harness.ts';
import { choice, startGame } from './game.ts';
import type { Game } from './game.ts';

const HOUR = 3_600_000;

/** Drives the mini quiz's scored first question to the given phase. */
async function advance(g: Game, to: 'question' | 'reveal' | 'leaderboard') {
  const { openAt } = await g.open({ phase: 'lobby', questionIndex: -1 });
  if (to === 'question') return openAt;
  await g.close(0);
  if (to === 'reveal') return openAt;
  await g.next('reveal', 0);
  return openAt;
}

const resume = (h: Harness, connectionId: string, g: Game, name: string) =>
  h.send(connectionId, {
    type: 'resume',
    v: 1,
    sessionId: g.sessionId,
    playerId: g.players[name]!.playerId,
    token: g.players[name]!.token,
  });

describeWithStores('players: join, resume, leave, disconnect', (make) => {
  describe('join', () => {
    it('stores only the SHA-256 of the token and welcomes with credentials', async () => {
      const h = await make();
      const g = await startGame(h);
      const ann = await g.join('Ann');
      const stored = (await h.store.getPlayer(g.sessionId, ann.playerId))!;
      expect(stored).toMatchObject({
        nickname: 'Ann',
        kicked: false,
        joinedAt: h.clock.now(),
        lastSeenAt: h.clock.now(),
      });
      expect(stored.tokenHash).toBe(createHash('sha256').update(ann.token).digest('hex'));
      expect(stored.tokenHash).not.toContain(ann.token);
      expect(ann.token).toHaveLength(43);
      expect(h.transport.last(ann.connectionId, 'welcome')).toMatchObject({
        role: 'player',
        credentials: { sessionId: g.sessionId, playerId: ann.playerId, token: ann.token },
        snapshot: { sv: 1, phase: 'lobby', quizTitle: 'Mini quiz', totalQuestions: 3 },
      });
      // Hosts hear about the new player; other players do not.
      expect(h.transport.last(g.control, 'roster')).toMatchObject({
        upsert: [{ playerId: ann.playerId, nickname: 'Ann', connected: true }],
        removed: [],
      });
      const bob = await g.join('Bob');
      expect(h.transport.ofType(ann.connectionId, 'roster')).toEqual([]);
      expect(h.transport.to(ann.connectionId).map((m) => m.type)).toEqual(['welcome']);
      expect(bob.playerId).not.toBe(ann.playerId);
    });

    it('registers the connection for three hours, or until the session expires', async () => {
      const h = await make();
      const g = await startGame(h);
      const ann = await g.join('Ann');
      expect((await h.store.getConnection(ann.connectionId))!).toMatchObject({
        sessionId: g.sessionId,
        role: 'player',
        playerId: ann.playerId,
        connectedAt: h.clock.now(),
        expiresAt: h.clock.now() + 3 * HOUR,
      });
      const meta = (await h.store.getSession(g.sessionId))!;
      h.clock.set(meta.expiresAt - HOUR);
      const bob = await g.join('Bob');
      expect((await h.store.getConnection(bob.connectionId))!.expiresAt).toBe(meta.expiresAt);
      await resume(h, h.cid('ann-2'), g, 'Ann');
      expect((await h.store.getConnection(h.cid('ann-2')))!.expiresAt).toBe(meta.expiresAt);
    });

    it('loads only what the phase shows', async () => {
      const cases: Array<{
        to: 'question' | 'reveal' | 'leaderboard';
        reads: string[];
        skips: string[];
      }> = [
        {
          to: 'question',
          reads: ['getScoreboard'],
          skips: ['listPlayers', 'getQuestionResult', 'listPlayerResponses'],
        },
        {
          to: 'reveal',
          reads: ['getScoreboard', 'getQuestionResult'],
          skips: ['listPlayers', 'listPlayerResponses'],
        },
        {
          to: 'leaderboard',
          reads: ['getScoreboard', 'listPlayers'],
          skips: ['getQuestionResult', 'listPlayerResponses'],
        },
      ];
      for (const { to, reads, skips } of cases) {
        const h = await make();
        const g = await startGame(h, { players: ['Ann'] });
        await advance(g, to);
        h.resetCalls();
        await g.join('Late');
        for (const call of reads) expect(h.calls, `${to} reads ${call}`).toContain(call);
        for (const call of skips) expect(h.calls, `${to} skips ${call}`).not.toContain(call);
      }
      const h = await make();
      const g = await startGame(h);
      h.resetCalls();
      await g.join('Early');
      for (const call of ['getScoreboard', 'listPlayers', 'getQuestionResult']) {
        expect(h.calls).not.toContain(call);
      }
    });

    it('welcomes a late joiner with the current phase', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann'] });
      const openAt = await advance(g, 'question');
      const late = await g.join('Late');
      const welcome = h.transport.last(late.connectionId, 'welcome');
      expect(welcome).toMatchObject({
        snapshot: {
          phase: 'question',
          questionIndex: 0,
          question: { openAt, question: { type: 'single' } },
          you: { nickname: 'Late', score: 0, rank: null },
        },
      });
      expect(welcome).toMatchObject({ snapshot: { sv: 2 } });
      await g.answer('Late', 0, choice('opt-paris'), openAt + 500);
      expect(h.transport.last(late.connectionId, 'answer.ack').status).toBe('accepted');

      await g.close(0);
      const afterReveal = await g.join('Later');
      expect(h.transport.last(afterReveal.connectionId, 'welcome')).toMatchObject({
        snapshot: {
          phase: 'reveal',
          reveal: { result: { type: 'single', answered: 1 }, you: { answered: false, points: 0 } },
        },
      });
      await g.next('reveal', 0);
      const onBoard = await g.join('Latest');
      const board = h.transport.last(onBoard.connectionId, 'welcome');
      expect(board).toMatchObject({
        snapshot: { phase: 'leaderboard', leaderboard: { entries: expect.any(Array) } },
      });
      // Every phase message reaches the late joiners too.
      await g.next('leaderboard', 0);
      expect(h.transport.last(onBoard.connectionId, 'question')).toMatchObject({ index: 1 });
    });
  });

  describe('resume', () => {
    it('re-registers the connection, updates lastSeenAt and marks the player connected', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann'] });
      const ann = g.players.Ann!;
      await h.service.onDisconnect(ann.connectionId);
      expect(h.transport.last(g.control, 'roster').upsert[0]).toMatchObject({ connected: false });
      h.clock.advance(60_000);
      const again = h.cid('ann-again');
      await resume(h, again, g, 'Ann');
      expect(await h.store.getConnection(again)).toMatchObject({
        role: 'player',
        playerId: ann.playerId,
        sessionId: g.sessionId,
      });
      expect((await h.store.getPlayer(g.sessionId, ann.playerId))!.lastSeenAt).toBe(h.clock.now());
      const welcome = h.transport.last(again, 'welcome');
      expect(welcome).toMatchObject({ role: 'player', snapshot: { phase: 'lobby' } });
      expect(welcome).not.toHaveProperty('credentials');
      expect(h.transport.last(g.control, 'roster').upsert).toEqual([
        { playerId: ann.playerId, nickname: 'Ann', connected: true },
      ]);
    });

    it('sends the right snapshot in every phase', async () => {
      let atSettle: (() => Promise<void>) | undefined;
      const h = await make({
        revealSettleMs: 1000,
        onSleep: async () => {
          await atSettle?.();
        },
      });
      const g = await startGame(h, { players: ['Ann', 'Bob'] });
      const snapshotOn = async (name: string, label: string) => {
        const id = h.cid(`${name}-${label}`);
        await resume(h, id, g, name);
        const welcome = h.transport.last(id, 'welcome');
        if (welcome.role !== 'player') throw new Error('role');
        return welcome.snapshot;
      };

      expect(await snapshotOn('Ann', 'lobby')).toMatchObject({ phase: 'lobby', questionIndex: -1 });

      const { openAt, deadline } = await g.open({ phase: 'lobby', questionIndex: -1 });
      await g.answer('Ann', 0, choice('opt-paris'), openAt + 100);
      expect(await snapshotOn('Ann', 'question')).toMatchObject({
        phase: 'question',
        responses: [choice('opt-paris')],
        question: { openAt, deadline },
      });
      expect(await snapshotOn('Bob', 'question')).toMatchObject({
        phase: 'question',
        responses: [],
      });

      // During the settle window the phase is `revealing` and the question is still shown.
      let during: Awaited<ReturnType<typeof snapshotOn>> | undefined;
      atSettle = async () => {
        atSettle = undefined;
        during = await snapshotOn('Ann', 'revealing');
      };
      await g.close(0);
      expect(during).toMatchObject({
        phase: 'revealing',
        responses: [choice('opt-paris')],
        question: { openAt, deadline },
      });
      expect(during).not.toHaveProperty('reveal');

      expect(await snapshotOn('Ann', 'reveal')).toMatchObject({
        phase: 'reveal',
        responses: [choice('opt-paris')],
        reveal: {
          result: { type: 'single', correctOptionId: 'opt-paris', answered: 1 },
          you: { answered: true, correct: true, points: 1000, score: 1000, rank: 1 },
        },
      });
      expect(await snapshotOn('Bob', 'reveal')).toMatchObject({
        reveal: { you: { answered: false, correct: false, points: 0, score: 0, rank: 2 } },
      });

      await g.next('reveal', 0);
      expect(await snapshotOn('Bob', 'leaderboard')).toMatchObject({
        phase: 'leaderboard',
        leaderboard: {
          entries: [
            { nickname: 'Ann', rank: 1, score: 1000 },
            { nickname: 'Bob', rank: 2, score: 0 },
          ],
          you: { score: 0, rank: 2, behind: { nickname: 'Ann', points: 1000 } },
        },
      });

      await h.send(g.control, { type: 'host.end' });
      const ended = await snapshotOn('Ann', 'ended');
      expect(ended).toMatchObject({
        phase: 'ended',
        ended: {
          totalPlayers: 2,
          podium: [{ nickname: 'Ann', rank: 1, score: 1000 }, { nickname: 'Bob' }],
          you: { score: 1000, rank: 1, correct: 1, answeredScored: 1, scoredQuestions: 1 },
        },
      });
      expect(ended).not.toHaveProperty('question');
    });
  });

  describe('leave and disconnect', () => {
    it('leave drops the connection and tells hosts, but the player can still resume', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann'] });
      const ann = g.players.Ann!;
      await h.send(ann.connectionId, { type: 'leave' });
      expect(await h.store.getConnection(ann.connectionId)).toBeNull();
      expect(h.transport.last(g.control, 'roster').upsert).toEqual([
        { playerId: ann.playerId, nickname: 'Ann', connected: false },
      ]);
      expect((await h.store.getPlayer(g.sessionId, ann.playerId))!.kicked).toBe(false);
      await resume(h, h.cid('ann-back'), g, 'Ann');
      expect(h.transport.last(h.cid('ann-back'), 'welcome').role).toBe('player');
    });

    it('does not report a player as disconnected while another connection is alive', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann'] });
      const ann = g.players.Ann!;
      await resume(h, h.cid('ann-second'), g, 'Ann');
      const rosterCount = h.transport.ofType(g.control, 'roster').length;
      await h.send(ann.connectionId, { type: 'leave' });
      await h.service.onDisconnect(ann.connectionId);
      expect(h.transport.ofType(g.control, 'roster')).toHaveLength(rosterCount);
      // Both sockets get broadcasts until one goes away; then only the survivor does.
      await g.open({ phase: 'lobby', questionIndex: -1 });
      expect(h.transport.ofType(h.cid('ann-second'), 'question')).toHaveLength(1);
      expect(h.transport.ofType(ann.connectionId, 'question')).toEqual([]);
      await h.service.onDisconnect(h.cid('ann-second'));
      expect(h.transport.last(g.control, 'roster').upsert[0]).toMatchObject({ connected: false });
    });

    it('sends every question to all of a player’s connections', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann'] });
      await resume(h, h.cid('ann-b'), g, 'Ann');
      await resume(h, h.cid('ann-c'), g, 'Ann');
      await g.open({ phase: 'lobby', questionIndex: -1 });
      for (const id of [g.players.Ann!.connectionId, h.cid('ann-b'), h.cid('ann-c')]) {
        expect(h.transport.ofType(id, 'question')).toHaveLength(1);
      }
    });

    it('ignores unknown connections and does not announce hosts or kicked players', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann'] });
      const before = h.transport.log.length;
      await h.service.onDisconnect('never-connected');
      await h.service.onDisconnect(g.control);
      expect(h.transport.log).toHaveLength(before);
      expect(await h.store.getConnection(g.control)).toBeNull();

      // A kick removes the player from the roster for good; a later disconnect must not bring them back.
      const ann = g.players.Ann!;
      await h.send(g.control, { type: 'host.kick', playerId: ann.playerId });
      const afterKick = h.transport.log.length;
      await h.service.onDisconnect(ann.connectionId);
      await h.send(ann.connectionId, { type: 'leave' });
      expect(h.transport.log.slice(afterKick).map((s) => s.message.type)).toEqual(['error']);
    });
  });
});
