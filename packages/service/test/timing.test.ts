import { describe, expect, it } from 'vitest';
import { describeWithStores } from './harness.ts';
import { choice, startGame, text } from './game.ts';

describeWithStores('answer timing and reveal settling', (make) => {
  describe('answer window (server receive time, ADR-0005)', () => {
    it('applies the early tolerance and the grace period to receivedAt', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann', 'Bob', 'Cy', 'Dee'] });
      const { openAt, deadline } = await g.open({ phase: 'lobby', questionIndex: -1 });
      const ack = (n: string) => h.transport.last(g.players[n]!.connectionId, 'answer.ack');

      await g.answer('Ann', 0, choice('opt-paris'), openAt - 300);
      expect(ack('Ann')).toMatchObject({ status: 'rejected', reason: 'too-early', entries: 0 });
      // The 250 ms tolerance edge counts as elapsed 0, so it scores full points.
      await g.answer('Ann', 0, choice('opt-paris'), openAt - 250);
      expect(ack('Ann')).toMatchObject({ status: 'accepted', entries: 1 });

      // deadline + grace is the last accepted instant; the elapsed time clamps to the limit.
      await g.answer('Bob', 0, choice('opt-paris'), deadline! + 750);
      expect(ack('Bob')).toMatchObject({ status: 'accepted' });
      await g.answer('Cy', 0, choice('opt-paris'), deadline! + 751);
      expect(ack('Cy')).toMatchObject({ status: 'rejected', reason: 'too-late' });
      await g.answer('Dee', 0, choice('opt-paris'), openAt + 1);
      expect(ack('Dee')).toMatchObject({ status: 'accepted' });

      const stored = async (n: string) =>
        (await h.store.listPlayerResponses(g.sessionId, 0, g.players[n]!.playerId))[0];
      expect(await stored('Ann')).toMatchObject({ elapsedMs: 0, points: 1000, correct: true });
      expect(await stored('Bob')).toMatchObject({ elapsedMs: 20_000, points: 400 });
      expect(await stored('Cy')).toBeUndefined();
    });

    it('ignores the service clock: a slow invocation cannot make an answer late', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann'] });
      const { openAt, deadline } = await g.open({ phase: 'lobby', questionIndex: -1 });
      // A cold Lambda picks the message up minutes after API Gateway received it.
      h.clock.set(deadline! + 600_000);
      await g.answer('Ann', 0, choice('opt-paris'), openAt + 100);
      expect(h.transport.last(g.players.Ann!.connectionId, 'answer.ack')).toMatchObject({
        status: 'accepted',
      });
    });

    it('accepts any time for an untimed question', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann'] });
      await g.open({ phase: 'lobby', questionIndex: -1 });
      await g.close(0);
      const { openAt, deadline } = await (async () => {
        await g.next('reveal', 0);
        await g.next('leaderboard', 0);
        const state = h.transport.last(g.control, 'host.state').snapshot;
        return state.question!;
      })();
      expect(deadline).toBeNull();
      await g.answer('Ann', 1, choice('opt-red'), openAt + 86_400_000);
      expect(h.transport.last(g.players.Ann!.connectionId, 'answer.ack')).toMatchObject({
        status: 'accepted',
      });
      const [stored] = await h.store.listPlayerResponses(g.sessionId, 1, g.players.Ann!.playerId);
      expect(stored).toMatchObject({ elapsedMs: null, points: 0 });
    });
  });

  describe('answers for a question that is not open', () => {
    it('reports not-open before the game starts and for another question index', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann'] });
      const ack = () => h.transport.last(g.players.Ann!.connectionId, 'answer.ack');
      await g.answer('Ann', 0, choice('opt-paris'), h.clock.now());
      expect(ack()).toMatchObject({ status: 'rejected', reason: 'not-open', index: 0 });

      const { openAt } = await g.open({ phase: 'lobby', questionIndex: -1 });
      await g.answer('Ann', 1, choice('opt-red'), openAt + 10);
      expect(ack()).toMatchObject({ status: 'rejected', reason: 'not-open', index: 1 });
      // A word cloud that is not open reads nothing about the player's earlier entries.
      h.resetCalls();
      await g.answer('Ann', 2, text('hello'), openAt + 10);
      expect(ack()).toMatchObject({ status: 'rejected', reason: 'not-open' });
      expect(h.calls).not.toContain('listPlayerResponses');
      await g.answer('Ann', 99, choice('opt-red'), openAt + 10);
      expect(ack()).toMatchObject({ status: 'rejected', reason: 'not-open' });
    });

    it('reports too-late for the closed question, and not-open once the game moved on', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann'] });
      const { openAt } = await g.open({ phase: 'lobby', questionIndex: -1 });
      await g.close(0);
      const ack = () => h.transport.last(g.players.Ann!.connectionId, 'answer.ack');
      await g.answer('Ann', 0, choice('opt-paris'), openAt + 100);
      expect(ack()).toMatchObject({ status: 'rejected', reason: 'too-late' });
      await g.next('reveal', 0);
      await g.answer('Ann', 0, choice('opt-paris'), openAt + 100);
      expect(ack()).toMatchObject({ status: 'rejected', reason: 'too-late' });
      await g.next('leaderboard', 0);
      await g.answer('Ann', 0, choice('opt-paris'), openAt + 100);
      expect(ack()).toMatchObject({ status: 'rejected', reason: 'not-open' });
      expect(await h.store.listResponses(g.sessionId, 0)).toEqual([]);
    });

    it('rejects payloads that do not fit the question', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann'] });
      const { openAt } = await g.open({ phase: 'lobby', questionIndex: -1 });
      const ack = () => h.transport.last(g.players.Ann!.connectionId, 'answer.ack');
      await g.answer('Ann', 0, choice('opt-nowhere'), openAt + 10);
      expect(ack()).toMatchObject({ status: 'rejected', reason: 'invalid' });
      await g.answer('Ann', 0, text('hello'), openAt + 10);
      expect(ack()).toMatchObject({ status: 'rejected', reason: 'invalid' });
      expect(await h.store.listResponses(g.sessionId, 0)).toEqual([]);
    });
  });

  describe('revealSettleMs (ADR-0006)', () => {
    it('waits the configured settle time between closing and revealing', async () => {
      const h = await make({ revealSettleMs: 1000 });
      const g = await startGame(h, { players: ['Ann'] });
      const { openAt } = await g.open({ phase: 'lobby', questionIndex: -1 });
      await g.answer('Ann', 0, choice('opt-paris'), openAt + 100);
      h.clock.set(openAt + 5000);
      await g.close(0);

      expect(h.sleeps).toEqual([1000]);
      const stored = await h.store.getQuestionResult(g.sessionId, 0);
      expect(stored).toMatchObject({ closedAt: openAt + 5000, computedAt: openAt + 6000 });
      const reveal = h.transport.last(g.players.Ann!.connectionId, 'reveal');
      // The reveal message is stamped when it is sent, after the wait.
      expect((reveal as unknown as { ts: number }).ts).toBe(openAt + 6000);
    });

    it('does not sleep when the settle time is 0', async () => {
      const h = await make({ revealSettleMs: 0 });
      const g = await startGame(h, { players: ['Ann'] });
      await g.open({ phase: 'lobby', questionIndex: -1 });
      await g.close(0);
      expect(h.sleeps).toEqual([]);
      expect(h.transport.ofType(g.players.Ann!.connectionId, 'reveal')).toHaveLength(1);
    });

    it('refuses an answer that arrives while the reveal settles, and scores only what was stored', async () => {
      let attempt: (() => Promise<void>) | undefined;
      const h = await make({
        revealSettleMs: 1000,
        onSleep: async () => {
          await attempt?.();
        },
      });
      const g = await startGame(h, { players: ['Ann', 'Bob'] });
      const { openAt } = await g.open({ phase: 'lobby', questionIndex: -1 });
      await g.answer('Ann', 0, choice('opt-paris'), openAt + 100);
      attempt = async () => {
        // The meta already says `revealing`: this answer is late even though it was received before the deadline.
        await g.answer('Bob', 0, choice('opt-paris'), openAt + 200);
      };
      await g.close(0);
      expect(h.transport.last(g.players.Bob!.connectionId, 'answer.ack')).toMatchObject({
        status: 'rejected',
        reason: 'too-late',
      });
      expect(h.transport.last(g.players.Ann!.connectionId, 'reveal').result).toMatchObject({
        answered: 1,
        totalPlayers: 2,
      });
    });

    it('closes by timer and by host.close reason the same way', async () => {
      const h = await make({ scheduler: true });
      const g = await startGame(h, { players: ['Ann'] });
      const { deadline } = await g.open({ phase: 'lobby', questionIndex: -1 });
      expect(h.scheduler.scheduled).toEqual([
        { sessionId: g.sessionId, questionIndex: 0, at: deadline! + 750 },
      ]);
      h.clock.set(deadline! + 750);
      await h.service.onTimer(g.sessionId, 0);
      expect(await h.store.getSession(g.sessionId)).toMatchObject({
        phase: 'reveal',
        closedAt: deadline! + 750,
      });
      expect(h.transport.ofType(g.players.Ann!.connectionId, 'reveal')).toHaveLength(1);
      // A timer for a question that is no longer open does nothing.
      await h.service.onTimer(g.sessionId, 0);
      await h.service.onTimer(g.sessionId, 2);
      await h.service.onTimer('no-such-session', 0);
      expect(h.transport.ofType(g.players.Ann!.connectionId, 'reveal')).toHaveLength(1);
      expect(h.logger.entries.error).toEqual([]);
    });
  });

  describe('scheduler', () => {
    it('schedules only timed questions and cancels on manual close and on end', async () => {
      const h = await make({ scheduler: true });
      const g = await startGame(h);
      await g.open({ phase: 'lobby', questionIndex: -1 });
      expect(h.scheduler.scheduled).toHaveLength(1);
      await g.close(0);
      expect(h.scheduler.cancelled).toEqual([g.sessionId]);
      await g.next('reveal', 0);
      await g.next('leaderboard', 0); // opens the untimed poll
      expect(h.scheduler.scheduled).toHaveLength(1);
      await h.send(g.control, { type: 'host.end' });
      expect(h.scheduler.cancelled).toEqual([g.sessionId, g.sessionId]);
    });

    it('works without a scheduler (Lambda)', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann'] });
      await g.open({ phase: 'lobby', questionIndex: -1 });
      await g.close(0);
      await h.send(g.control, { type: 'host.end' });
      expect(h.transport.ofType(g.players.Ann!.connectionId, 'ended')).toHaveLength(1);
    });
  });
});
