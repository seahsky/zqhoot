import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '@zqhoot/engine';
import { describeWithStores } from './harness.ts';
import type { Harness } from './harness.ts';
import { choice, startGame, text } from './game.ts';
import { miniQuiz } from './fixtures.ts';

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

  describe('a timer close that arrives inside the answer grace (ADR-0005)', () => {
    it('keeps the window open on Lambda: the close waits, and an answer inside the grace is scored', async () => {
      let during: (() => Promise<void>) | undefined;
      const h = await make({
        onSleep: async () => {
          const run = during;
          during = undefined;
          await run?.();
        },
      });
      const g = await startGame(h, { players: ['Ann', 'Bob'] });
      const { openAt, deadline } = await g.open({ phase: 'lobby', questionIndex: -1 });
      await g.answer('Ann', 0, choice('opt-paris'), openAt + 100);

      // The host's timer close reaches the server 50 ms after the deadline; Bob's answer,
      // sent before the deadline over a slow link, reaches it at deadline + 300 ms.
      h.clock.set(deadline! + 50);
      during = () => g.answer('Bob', 0, choice('opt-paris'), deadline! + 300);
      await g.close(0, 'timer');

      expect(h.sleeps).toEqual([700]);
      expect(h.transport.last(g.players.Bob!.connectionId, 'answer.ack')).toMatchObject({
        status: 'accepted',
      });
      expect(h.transport.last(g.players.Bob!.connectionId, 'reveal').you).toMatchObject({
        answered: true,
        correct: true,
        points: 400,
      });
      expect(await h.store.getSession(g.sessionId)).toMatchObject({
        phase: 'reveal',
        closedAt: deadline! + 750,
      });
      const board = (await h.store.getScoreboard(g.sessionId))!;
      expect(board.players[g.players.Bob!.playerId]).toMatchObject({ score: 400 });
    });

    it('leaves the close to the scheduler on the VM, which closes at deadline + grace', async () => {
      const h = await make({ scheduler: true });
      const g = await startGame(h, { players: ['Ann'] });
      const { deadline } = await g.open({ phase: 'lobby', questionIndex: -1 });
      h.clock.set(deadline! + 50);
      await g.close(0, 'timer');
      expect(h.sleeps).toEqual([]);
      expect(await h.store.getSession(g.sessionId)).toMatchObject({ phase: 'question' });
      expect(h.transport.ofType(g.control, 'error')).toEqual([]);

      await g.answer('Ann', 0, choice('opt-paris'), deadline! + 300);
      expect(h.transport.last(g.players.Ann!.connectionId, 'answer.ack')).toMatchObject({
        status: 'accepted',
      });
      h.clock.set(deadline! + 750);
      await h.service.onTimer(g.sessionId, 0);
      expect(h.transport.last(g.players.Ann!.connectionId, 'reveal').you).toMatchObject({
        points: 400,
      });
    });

    it('closes at once when the grace is over, and never waits longer than the grace', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann'] });
      const { deadline } = await g.open({ phase: 'lobby', questionIndex: -1 });
      h.clock.set(deadline! + 750);
      await g.close(0, 'timer');
      expect(h.sleeps).toEqual([]);
      expect(await h.store.getSession(g.sessionId)).toMatchObject({ phase: 'reveal' });

      // A host whose clock ran far ahead of the deadline still cannot hold the invocation for long.
      const early = await startGame(h, { label: 'early-' });
      const opened = await early.open({ phase: 'lobby', questionIndex: -1 });
      h.clock.set(opened.deadline! - 5000);
      await early.close(0, 'timer');
      expect(h.sleeps).toEqual([750]);
    });

    it('does not wait for a manual close, an all-answered close, or a close that is already moot', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann'] });
      const { openAt, deadline } = await g.open({ phase: 'lobby', questionIndex: -1 });
      await g.answer('Ann', 0, choice('opt-paris'), openAt + 100);
      h.clock.set(deadline! + 50);
      await g.close(0, 'manual');
      expect(await h.store.getSession(g.sessionId)).toMatchObject({ phase: 'reveal' });
      // Repeats and stale indexes find nothing open and pass straight through.
      await g.close(0, 'timer');
      await g.close(7, 'timer');
      expect(h.sleeps).toEqual([]);

      const other = await startGame(h, { players: ['Bob'], label: 'other-' });
      const opened = await other.open({ phase: 'lobby', questionIndex: -1 });
      h.clock.set(opened.openAt + 1000);
      await other.close(0, 'all-answered');
      expect(h.sleeps).toEqual([]);
      expect(await h.store.getSession(other.sessionId)).toMatchObject({ phase: 'reveal' });
    });

    it('does not hold a timer close for an untimed question', async () => {
      const h = await make();
      const quiz = miniQuiz();
      const g = await startGame(h, { quiz: { ...quiz, questions: [quiz.questions[1]!] } });
      await g.open({ phase: 'lobby', questionIndex: -1 });
      await g.close(0, 'timer');
      expect(h.sleeps).toEqual([]);
      expect(await h.store.getSession(g.sessionId)).toMatchObject({ phase: 'reveal' });
    });

    it('lets a manual close still cut the window short, as the host asked', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann'] });
      const { deadline } = await g.open({ phase: 'lobby', questionIndex: -1 });
      h.clock.set(deadline! - 5000);
      await g.close(0, 'manual');
      await g.answer('Ann', 0, choice('opt-paris'), deadline! - 4000);
      expect(h.transport.last(g.players.Ann!.connectionId, 'answer.ack')).toMatchObject({
        status: 'rejected',
        reason: 'too-late',
      });
    });
  });

  describe('a reveal retried inside the settle (ADR-0006)', () => {
    /**
     * Bob's answer read META while the question was open and is held before its write; the host
     * closes and, during the settle, presses Next again from 'revealing'. `atSecondTap` runs
     * first, so a test can let time pass between the close and the second tap.
     */
    async function doubleTap(atSecondTap: (h: Harness) => void = () => undefined) {
      let gate: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        gate = resolve;
      });
      let held: Promise<void> = Promise.resolve();
      let tap: () => Promise<void> = async () => undefined;
      let sleeping = 0;
      const h = await make({
        revealSettleMs: 1000,
        onSleep: async () => {
          // The first sleep is the close's settle; the next one is the retry's.
          if (sleeping++ === 0) {
            await tap();
          } else {
            gate();
            await held;
          }
        },
      });
      const g = await startGame(h, { players: ['Ann', 'Bob'] });
      const { openAt } = await g.open({ phase: 'lobby', questionIndex: -1 });
      await g.answer('Ann', 0, choice('opt-paris'), openAt + 100);

      let reached: () => void = () => undefined;
      const inFlight = new Promise<void>((resolve) => {
        reached = resolve;
      });
      h.overrides.putResponse = async (...args: unknown[]) => {
        reached();
        await released;
        return (h.real.putResponse as (...a: unknown[]) => Promise<unknown>).apply(h.real, args);
      };
      held = g.answer('Bob', 0, choice('opt-paris'), openAt + 200);
      await inFlight;

      tap = async () => {
        atSecondTap(h);
        await g.next('revealing', 0);
      };
      await g.close(0);
      return { h, g };
    }

    it('waits out the whole interval, so an answer acknowledged as accepted is scored', async () => {
      const { h, g } = await doubleTap();
      expect(h.sleeps).toEqual([1000, 1000]);
      const bob = g.players.Bob!.connectionId;
      expect(h.transport.last(bob, 'answer.ack')).toMatchObject({ status: 'accepted' });
      expect(h.transport.ofType(bob, 'reveal')).toHaveLength(1);
      expect(h.transport.last(bob, 'reveal').you).toMatchObject({ answered: true, points: 1000 });
      const board = (await h.store.getScoreboard(g.sessionId))!;
      expect(board.players[g.players.Bob!.playerId]).toMatchObject({
        score: 1000,
        answeredScored: 1,
      });
      expect(h.transport.last(g.control, 'host.state').snapshot.result).toMatchObject({
        answered: 2,
      });
    });

    it('measures the interval from the close, so only the rest of it is waited', async () => {
      const { h } = await doubleTap((harness) => harness.clock.advance(400));
      expect(h.sleeps).toEqual([1000, 600]);
    });

    it('does not wait once the interval is over', async () => {
      const h = await make({ revealSettleMs: 1000 });
      const g = await startGame(h, { players: ['Ann'] });
      await g.open({ phase: 'lobby', questionIndex: -1 });
      // A reveal that crashed after the close: the host presses Next long afterwards.
      h.overrides.updateSession = async (meta: SessionMeta, expected: number) => {
        if (meta.phase === 'reveal') throw new Error('simulated crash');
        return h.real.updateSession(meta, expected);
      };
      await g.close(0);
      h.overrides = {};
      h.sleeps.length = 0;
      h.clock.advance(5000);
      await g.next('revealing', 0);
      expect(h.sleeps).toEqual([]);
      expect(await h.store.getSession(g.sessionId)).toMatchObject({ phase: 'reveal' });
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
