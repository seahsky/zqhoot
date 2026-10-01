import { describe, expect, it } from 'vitest';
import { describeWithStores } from './harness.ts';
import type { Harness } from './harness.ts';
import { choice, startGame, text } from './game.ts';
import type { Game } from './game.ts';
import { miniQuiz, openQuiz, wordCloudQuiz } from './fixtures.ts';

const HOUR = 3_600_000;

describeWithStores('hosts: hello, commands, kick, moderate, stats', (make) => {
  describe('host.hello', () => {
    it('welcomes with the host snapshot, roster and connection state', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann', 'Bob'] });
      await h.service.onDisconnect(g.players.Bob!.connectionId);
      const present = await h.hostHello('present', g.sessionId, 'a', 'present');
      const welcome = h.transport.last(present, 'welcome');
      expect(welcome).toMatchObject({
        role: 'host',
        snapshot: {
          sv: 1,
          sessionId: g.sessionId,
          pin: g.pin,
          quizTitle: 'Mini quiz',
          phase: 'lobby',
          locked: false,
          totalQuestions: 3,
          hasScoredQuestions: true,
          roster: [
            { nickname: 'Ann', connected: true },
            { nickname: 'Bob', connected: false },
          ],
        },
      });
      expect(await h.store.getConnection(present)).toMatchObject({
        role: 'host',
        client: 'present',
        sessionId: g.sessionId,
        expiresAt: h.clock.now() + 3 * HOUR,
      });
      // The presenter is a host too: it hears about everything.
      await g.open({ phase: 'lobby', questionIndex: -1 });
      expect(h.transport.last(present, 'host.state').snapshot).toMatchObject({ phase: 'question' });
    });

    it('sends the right snapshot in every phase, with answers for hosts only', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann'] });
      const hello = async (label: string) => {
        const id = await h.hostHello(`hello-${label}`, g.sessionId);
        const welcome = h.transport.last(id, 'welcome');
        if (welcome.role !== 'host') throw new Error('role');
        return welcome.snapshot;
      };
      const { openAt } = await g.open({ phase: 'lobby', questionIndex: -1 });
      await g.answer('Ann', 0, choice('opt-paris'), openAt + 100);
      expect(await hello('question')).toMatchObject({
        phase: 'question',
        question: { question: { correctOptionId: 'opt-paris' }, openAt },
      });
      await g.close(0);
      const reveal = await hello('reveal');
      expect(reveal).toMatchObject({
        phase: 'reveal',
        result: { type: 'single', answered: 1 },
        question: { closedAt: expect.any(Number) },
      });
      await g.next('reveal', 0);
      expect(await hello('leaderboard')).toMatchObject({
        phase: 'leaderboard',
        leaderboard: [{ nickname: 'Ann', rank: 1, score: 1000 }],
      });
      await h.send(g.control, { type: 'host.end' });
      expect(await hello('ended')).toMatchObject({
        phase: 'ended',
        podium: [{ nickname: 'Ann', rank: 1 }],
      });
    });

    it('registers the connection until the session expires when that comes first', async () => {
      const h = await make();
      const g = await startGame(h);
      const meta = (await h.store.getSession(g.sessionId))!;
      h.clock.set(meta.expiresAt - HOUR);
      const id = await h.hostHello('late', g.sessionId);
      expect((await h.store.getConnection(id))!.expiresAt).toBe(meta.expiresAt);
    });
  });

  describe('transitions and their effects', () => {
    it('sends players the public question and hosts the full one', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann'] });
      await g.open({ phase: 'lobby', questionIndex: -1 });
      const player = h.transport.last(g.players.Ann!.connectionId, 'question');
      expect(JSON.stringify(player)).not.toContain('correctOptionId');
      expect(player.question).toMatchObject({ type: 'single', points: 1 });
      expect(h.transport.last(g.control, 'host.state').snapshot.question?.question).toMatchObject({
        correctOptionId: 'opt-paris',
      });
      // Nobody else got anything: hosts hear host.state, players question.
      expect(h.transport.to(g.players.Ann!.connectionId).map((m) => m.type)).toEqual([
        'welcome',
        'question',
      ]);
    });

    it('treats host.next during a question as a close (a presenter clicker has one key)', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann'] });
      await g.open({ phase: 'lobby', questionIndex: -1 });
      await g.next('question', 0);
      expect(await h.store.getSession(g.sessionId)).toMatchObject({ phase: 'reveal' });
      expect(h.transport.ofType(g.players.Ann!.connectionId, 'reveal')).toHaveLength(1);
    });

    it('skips a question without results or points and opens the next', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann'] });
      const { openAt } = await g.open({ phase: 'lobby', questionIndex: -1 });
      await g.answer('Ann', 0, choice('opt-paris'), openAt + 100);
      await h.send(g.control, { type: 'host.skip', questionIndex: 0 });
      expect(await h.store.getSession(g.sessionId)).toMatchObject({
        phase: 'question',
        questionIndex: 1,
        skipped: [0],
      });
      expect(h.transport.last(g.players.Ann!.connectionId, 'question')).toMatchObject({ index: 1 });
      expect(h.transport.ofType(g.players.Ann!.connectionId, 'reveal')).toEqual([]);
      expect(await h.store.getQuestionResult(g.sessionId, 0)).toBeNull();
      expect(await h.store.getScoreboard(g.sessionId)).toBeNull();
      // Skipping a question that is not the current one does nothing.
      await h.send(g.control, { type: 'host.skip', questionIndex: 0 });
      expect(await h.store.getSession(g.sessionId)).toMatchObject({ questionIndex: 1, version: 3 });
      // Skipping the last question ends the game.
      await h.send(g.control, { type: 'host.skip', questionIndex: 1 });
      await h.send(g.control, { type: 'host.skip', questionIndex: 2 });
      expect(await h.store.getSession(g.sessionId)).toMatchObject({ phase: 'ended' });
      expect(h.transport.ofType(g.players.Ann!.connectionId, 'ended')).toHaveLength(1);
    });

    it('ends the game from any phase: releases the PIN, cancels the timer, no podium without scores', async () => {
      const h = await make({ scheduler: true });
      const g = await startGame(h, { players: ['Ann', 'Bob'] });
      await g.open({ phase: 'lobby', questionIndex: -1 });
      expect(await h.store.getSessionIdByPin(g.pin)).toBe(g.sessionId);
      await h.send(g.control, { type: 'host.end' });
      expect(await h.store.getSessionIdByPin(g.pin)).toBeNull();
      expect(h.scheduler.cancelled).toContain(g.sessionId);
      // Nothing was scored, so every rank would just reflect nickname order: no podium, null ranks.
      for (const name of ['Ann', 'Bob']) {
        expect(h.transport.last(g.players[name]!.connectionId, 'ended')).toMatchObject({
          podium: [],
          totalPlayers: 2,
          you: { rank: null, score: 0, scoredQuestions: 0 },
        });
      }
      expect(h.transport.last(g.control, 'host.state').snapshot).toMatchObject({
        phase: 'ended',
        podium: [],
      });
      // Pressing end again changes nothing and answers only the requester.
      const version = (await h.store.getSession(g.sessionId))!.version;
      const before = h.transport.log.length;
      await h.send(g.control, { type: 'host.end' });
      expect((await h.store.getSession(g.sessionId))!.version).toBe(version);
      expect(h.transport.log.slice(before).map((s) => [s.to, s.message.type])).toEqual([
        [g.control, 'host.state'],
      ]);
      // The PIN can be reused by another session.
      const other = await h.startSession(g.quizId);
      expect(other.sessionId).not.toBe(g.sessionId);
    });

    it('locks and unlocks joining and tells hosts only', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann'] });
      const present = await h.hostHello('present', g.sessionId, 'a', 'present');
      const before = h.transport.to(g.players.Ann!.connectionId).length;
      await h.send(g.control, { type: 'host.lock', locked: true });
      expect(h.transport.last(g.control, 'host.state').snapshot).toMatchObject({ locked: true });
      expect(h.transport.last(present, 'host.state').snapshot).toMatchObject({ locked: true });
      expect(h.transport.to(g.players.Ann!.connectionId)).toHaveLength(before);
      await h.send(g.control, { type: 'host.lock', locked: true }); // no change: reply to the requester only
      expect(h.transport.ofType(present, 'host.state')).toHaveLength(1);
      await h.send(g.control, { type: 'host.lock', locked: false });
      expect(h.transport.last(present, 'host.state').snapshot).toMatchObject({ locked: false });
      expect(await h.store.getSession(g.sessionId)).toMatchObject({ locked: false, version: 3 });
    });

    it('answers a stale host.next to the requester alone', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann'] });
      const present = await h.hostHello('present', g.sessionId, 'a', 'present');
      await g.open({ phase: 'lobby', questionIndex: -1 });
      const log = h.transport.log.length;
      await g.next('question', 5); // wrong question index
      await g.next('leaderboard', 0); // wrong phase
      const sent = h.transport.log.slice(log).map((s) => [s.to, s.message.type]);
      expect(sent).toEqual([
        [g.control, 'host.state'],
        [g.control, 'host.state'],
      ]);
      expect(h.transport.ofType(present, 'host.state')).toHaveLength(1);
      expect(await h.store.getSession(g.sessionId)).toMatchObject({
        phase: 'question',
        version: 2,
      });
    });

    it('reports an internal error when the scoreboard is missing at the leaderboard', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann'] });
      await g.open({ phase: 'lobby', questionIndex: -1 });
      await g.close(0);
      h.overrides.getScoreboard = async () => null;
      await g.next('reveal', 0);
      expect(h.transport.last(g.control, 'error')).toMatchObject({
        code: 'internal',
        ref: 'host.next',
      });
      expect(h.logger.entries.error.at(-1)!.o).toMatchObject({ type: 'host.next' });
      h.overrides = {};
    });
  });

  describe('host.kick', () => {
    it('kicks every connection of the player, closes them and updates the roster', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann', 'Bob'] });
      const present = await h.hostHello('present', g.sessionId, 'a', 'present');
      const ann = g.players.Ann!;
      const second = h.cid('ann-second');
      await h.send(second, {
        type: 'resume',
        v: 1,
        sessionId: g.sessionId,
        playerId: ann.playerId,
        token: ann.token,
      });
      await h.send(g.control, { type: 'host.kick', playerId: ann.playerId });
      for (const id of [ann.connectionId, second]) {
        expect(h.transport.ofType(id, 'kicked')).toHaveLength(1);
        expect(h.transport.closes).toContainEqual({
          connectionId: id,
          code: 1000,
          reason: 'kicked',
        });
        expect(await h.store.getConnection(id)).toBeNull();
      }
      for (const screen of [g.control, present]) {
        expect(h.transport.last(screen, 'roster')).toMatchObject({
          upsert: [],
          removed: [ann.playerId],
        });
      }
      expect((await h.store.getPlayer(g.sessionId, ann.playerId))!.kicked).toBe(true);
      // Kicked players drop out of the roster, the counts and later broadcasts.
      const welcome = h.transport.last(await h.hostHello('again', g.sessionId), 'welcome');
      expect(welcome.role === 'host' && welcome.snapshot.roster.map((r) => r.nickname)).toEqual([
        'Bob',
      ]);
      await g.open({ phase: 'lobby', questionIndex: -1 });
      expect(h.transport.ofType(ann.connectionId, 'question')).toEqual([]);
      expect(h.transport.ofType(g.players.Bob!.connectionId, 'question')).toHaveLength(1);
      await g.close(0);
      expect(h.transport.last(g.control, 'host.state').snapshot.result).toMatchObject({
        totalPlayers: 1,
      });
      // Kicking again is harmless.
      await h.send(g.control, { type: 'host.kick', playerId: ann.playerId });
      expect(h.transport.ofType(g.control, 'error')).toEqual([]);
    });

    it('cannot kick a player of another session', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann'] });
      const other = await startGame(h, { players: ['Zed'], label: 'other-' });
      await h.send(g.control, { type: 'host.kick', playerId: other.players.Zed!.playerId });
      expect(h.transport.last(g.control, 'error')).toMatchObject({ code: 'not-found' });
      expect((await h.store.getPlayer(other.sessionId, other.players.Zed!.playerId))!.kicked).toBe(
        false,
      );
    });
  });

  describe('host.stats', () => {
    it('reports live counts to the requester only, without touching the session', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann', 'Bob'] });
      const present = await h.hostHello('present', g.sessionId, 'a', 'present');
      const { openAt } = await g.open({ phase: 'lobby', questionIndex: -1 });
      await g.answer('Ann', 0, choice('opt-paris'), openAt + 100);
      h.resetCalls();
      const log = h.transport.log.length;
      await h.send(g.control, { type: 'host.stats', questionIndex: 0 });
      expect(h.transport.log.slice(log).map((s) => [s.to, s.message.type])).toEqual([
        [g.control, 'stats'],
      ]);
      expect(h.transport.last(g.control, 'stats')).toMatchObject({
        questionIndex: 0,
        stats: {
          type: 'single',
          answered: 1,
          totalPlayers: 2,
          expected: 2,
          counts: { 'opt-paris': 1 },
        },
      });
      expect(h.calls.sort()).toEqual([
        'getConnection',
        'listConnections',
        'listPlayers',
        'listResponses',
      ]);
      expect(h.transport.ofType(present, 'stats')).toEqual([]);
    });

    describe('who the question waits for (ADR-0006: connected, non-kicked players)', () => {
      const statsOf = async (h: Harness, g: Game) => {
        await h.send(g.control, { type: 'host.stats', questionIndex: 0 });
        return h.transport.last(g.control, 'stats').stats;
      };

      it('does not expect a player who left or dropped without answering', async () => {
        const h = await make();
        const g = await startGame(h, { players: ['Ann', 'Bob', 'Cy'] });
        const { openAt } = await g.open({ phase: 'lobby', questionIndex: -1 });
        expect(await statsOf(h, g)).toMatchObject({ answered: 0, totalPlayers: 3, expected: 3 });

        await h.send(g.players.Cy!.connectionId, { type: 'leave' });
        await h.service.onDisconnect(g.players.Bob!.connectionId);
        // Both are still players of the session, but only Ann is awaited.
        expect(await statsOf(h, g)).toMatchObject({ answered: 0, totalPlayers: 3, expected: 1 });

        await g.answer('Ann', 0, choice('opt-paris'), openAt + 100);
        expect(await statsOf(h, g)).toMatchObject({ answered: 1, totalPlayers: 3, expected: 1 });
      });

      it('still expects a player who answered and then disconnected, as answered', async () => {
        const h = await make();
        const g = await startGame(h, { players: ['Ann', 'Bob'] });
        const { openAt } = await g.open({ phase: 'lobby', questionIndex: -1 });
        await g.answer('Bob', 0, choice('opt-rome'), openAt + 100);
        await h.service.onDisconnect(g.players.Bob!.connectionId);
        // Bob is gone but his answer stands: only Ann is still awaited.
        expect(await statsOf(h, g)).toMatchObject({ answered: 1, totalPlayers: 2, expected: 2 });
        await g.answer('Ann', 0, choice('opt-paris'), openAt + 200);
        expect(await statsOf(h, g)).toMatchObject({ answered: 2, totalPlayers: 2, expected: 2 });
      });

      it('expects a player again when they reconnect', async () => {
        const h = await make();
        const g = await startGame(h, { players: ['Ann', 'Bob'] });
        await g.open({ phase: 'lobby', questionIndex: -1 });
        await h.service.onDisconnect(g.players.Bob!.connectionId);
        expect(await statsOf(h, g)).toMatchObject({ totalPlayers: 2, expected: 1 });
        const bob = g.players.Bob!;
        const again = h.cid('bob-again');
        await h.send(again, {
          type: 'resume',
          v: 1,
          sessionId: bob.sessionId,
          playerId: bob.playerId,
          token: bob.token,
        });
        expect(await statsOf(h, g)).toMatchObject({ answered: 0, totalPlayers: 2, expected: 2 });
      });

      it('leaves a kicked player out of both counts, connected or not', async () => {
        const h = await make();
        const g = await startGame(h, { players: ['Ann', 'Bob'] });
        await g.open({ phase: 'lobby', questionIndex: -1 });
        await h.send(g.control, { type: 'host.kick', playerId: g.players.Bob!.playerId });
        expect(await statsOf(h, g)).toMatchObject({ answered: 0, totalPlayers: 1, expected: 1 });
      });

      it('leaves the result of the closed question counting everyone, with no expected count', async () => {
        const h = await make();
        const g = await startGame(h, { players: ['Ann', 'Bob'] });
        const { openAt } = await g.open({ phase: 'lobby', questionIndex: -1 });
        await g.answer('Ann', 0, choice('opt-paris'), openAt + 100);
        await h.service.onDisconnect(g.players.Bob!.connectionId);
        await g.close(0);
        const { result } = h.transport.last(g.control, 'host.state').snapshot;
        expect(result).toMatchObject({ answered: 1, totalPlayers: 2 });
        expect(result).not.toHaveProperty('expected');
      });
    });

    it('passes the paging cursor through for open-ended questions', async () => {
      const h = await make();
      const g = await startGame(h, { quiz: openQuiz(), players: ['Ann', 'Bob'] });
      const { openAt } = await g.open({ phase: 'lobby', questionIndex: -1 });
      await g.answer('Ann', 0, text('first'), openAt + 1000);
      await g.answer('Bob', 0, text('second'), openAt + 2000);
      await h.send(g.control, { type: 'host.stats', questionIndex: 0 });
      const all = h.transport.last(g.control, 'stats').stats;
      expect(all.type === 'open' && all.responses.map((r) => r.text)).toEqual(['first', 'second']);
      const first = all.type === 'open' ? all.responses[0]! : undefined;
      const after = btoa(`${first!.receivedAt}:${first!.id}`)
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
      await h.send(g.control, { type: 'host.stats', questionIndex: 0, after });
      const page = h.transport.last(g.control, 'stats').stats;
      expect(page.type === 'open' && page.responses.map((r) => r.text)).toEqual(['second']);
    });
  });

  describe('host.moderate', () => {
    it('is silent while the question is open and shows on the next stats poll', async () => {
      const h = await make();
      const g = await startGame(h, { quiz: openQuiz(), players: ['Ann'] });
      const { openAt } = await g.open({ phase: 'lobby', questionIndex: -1 });
      await g.answer('Ann', 0, text('hello'), openAt + 1000);
      const log = h.transport.log.length;
      await h.send(g.control, {
        type: 'host.moderate',
        questionIndex: 0,
        responseId: `${g.players.Ann!.playerId}-0`,
        status: 'visible',
      });
      expect(h.transport.log).toHaveLength(log);
      await h.send(g.control, { type: 'host.stats', questionIndex: 0 });
      const stats = h.transport.last(g.control, 'stats').stats;
      expect(stats.type === 'open' && stats.responses[0]?.status).toBe('visible');
    });

    it('re-aggregates a word cloud when a word is hidden after the reveal', async () => {
      const h = await make();
      const g = await startGame(h, { quiz: wordCloudQuiz(3), players: ['Ann', 'Bob'] });
      const present = await h.hostHello('present', g.sessionId, 'a', 'present');
      const { openAt } = await g.open({ phase: 'lobby', questionIndex: -1 });
      await g.answer('Ann', 0, text('sun'), openAt + 100);
      await g.answer('Ann', 0, text('rude'), openAt + 200);
      await g.answer('Bob', 0, text('sun'), openAt + 300);
      await g.close(0);
      const words = (m: { snapshot: { result?: { type: string; words?: unknown } } }) =>
        m.snapshot.result?.words;
      expect(words(h.transport.last(present, 'host.state'))).toEqual([
        { text: 'sun', count: 2 },
        { text: 'rude', count: 1 },
      ]);

      await h.send(g.control, {
        type: 'host.moderate',
        questionIndex: 0,
        responseId: `${g.players.Ann!.playerId}-1`,
        status: 'hidden',
      });
      for (const screen of [g.control, present]) {
        expect(words(h.transport.last(screen, 'host.state'))).toEqual([{ text: 'sun', count: 2 }]);
      }
      expect((await h.store.getQuestionResult(g.sessionId, 0))!.result).toMatchObject({
        words: [{ text: 'sun', count: 2 }],
        answered: 2,
      });
      // Players who resume now see the moderated cloud.
      await h.send(h.cid('ann-new'), {
        type: 'resume',
        v: 1,
        sessionId: g.sessionId,
        playerId: g.players.Ann!.playerId,
        token: g.players.Ann!.token,
      });
      const welcome = h.transport.last(h.cid('ann-new'), 'welcome');
      expect(welcome.role === 'player' && welcome.snapshot.reveal?.result).toMatchObject({
        words: [{ text: 'sun', count: 2 }],
      });
      await h.send(g.control, {
        type: 'host.moderate',
        questionIndex: 0,
        responseId: `${g.players.Ann!.playerId}-1`,
        status: 'visible',
      });
      expect(words(h.transport.last(g.control, 'host.state'))).toHaveLength(2);
    });

    it('leaves a result from an earlier question untouched', async () => {
      const h = await make();
      const g = await startGame(h, {
        quiz: {
          ...openQuiz(),
          questions: [...openQuiz().questions, ...miniQuiz().questions.slice(0, 1)],
        },
        players: ['Ann'],
      });
      const { openAt } = await g.open({ phase: 'lobby', questionIndex: -1 });
      await g.answer('Ann', 0, text('hello'), openAt + 1000);
      await g.close(0);
      await g.next('reveal', 0); // unscored: straight to question 2
      await g.close(1);
      const stored = await h.store.getQuestionResult(g.sessionId, 0);
      const log = h.transport.log.length;
      await h.send(g.control, {
        type: 'host.moderate',
        questionIndex: 0,
        responseId: `${g.players.Ann!.playerId}-0`,
        status: 'visible',
      });
      // Only the response record changed; the session is showing another question.
      expect(await h.store.getQuestionResult(g.sessionId, 0)).toEqual(stored);
      expect(h.transport.log).toHaveLength(log);
      expect(
        (await h.store.listPlayerResponses(g.sessionId, 0, g.players.Ann!.playerId))[0]?.status,
      ).toBe('visible');
    });
  });

  describe('gone connections (ADR-0007)', () => {
    it('deletes gone connections and tells hosts the player is disconnected', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann', 'Bob', 'Cy'] });
      h.transport.gone.add(g.players.Bob!.connectionId);
      await g.open({ phase: 'lobby', questionIndex: -1 });
      expect(await h.store.getConnection(g.players.Bob!.connectionId)).toBeNull();
      expect(await h.store.getConnection(g.players.Ann!.connectionId)).not.toBeNull();
      expect(h.transport.ofType(g.players.Bob!.connectionId, 'question')).toEqual([]);
      expect(h.transport.ofType(g.players.Ann!.connectionId, 'question')).toHaveLength(1);
      expect(h.transport.ofType(g.players.Cy!.connectionId, 'question')).toHaveLength(1);
      const roster = h.transport.last(g.control, 'roster');
      expect(roster.upsert).toEqual([
        { playerId: g.players.Bob!.playerId, nickname: 'Bob', connected: false },
      ]);
      // The gone socket is not retried on the next broadcast.
      const count = h.transport.ofType(g.control, 'roster').length;
      await g.close(0);
      expect(h.transport.ofType(g.control, 'roster')).toHaveLength(count);
    });

    it('collects several gone players into one roster update', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann', 'Bob', 'Cy'] });
      h.transport.gone.add(g.players.Ann!.connectionId);
      h.transport.gone.add(g.players.Cy!.connectionId);
      const before = h.transport.ofType(g.control, 'roster').length;
      await g.open({ phase: 'lobby', questionIndex: -1 });
      const updates = h.transport.ofType(g.control, 'roster').slice(before);
      expect(updates).toHaveLength(1);
      expect(updates[0]!.upsert.map((e) => [e.nickname, e.connected]).sort()).toEqual([
        ['Ann', false],
        ['Cy', false],
      ]);
    });

    it('keeps the player connected while another of their sockets is alive', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann'] });
      const ann = g.players.Ann!;
      const second = h.cid('ann-second');
      await h.send(second, {
        type: 'resume',
        v: 1,
        sessionId: g.sessionId,
        playerId: ann.playerId,
        token: ann.token,
      });
      h.transport.gone.add(ann.connectionId);
      const before = h.transport.ofType(g.control, 'roster').length;
      await g.open({ phase: 'lobby', questionIndex: -1 });
      expect(await h.store.getConnection(ann.connectionId)).toBeNull();
      expect(h.transport.ofType(second, 'question')).toHaveLength(1);
      expect(h.transport.ofType(g.control, 'roster')).toHaveLength(before);
    });

    it('deletes a gone host connection without a roster update', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann'] });
      const present = await h.hostHello('present', g.sessionId, 'a', 'present');
      h.transport.gone.add(present);
      const before = h.transport.ofType(g.control, 'roster').length;
      await g.open({ phase: 'lobby', questionIndex: -1 });
      expect(await h.store.getConnection(present)).toBeNull();
      expect(h.transport.ofType(g.control, 'roster')).toHaveLength(before);
      expect(h.transport.ofType(g.control, 'host.state')).toHaveLength(1);
    });

    it('cleans up when the reply itself finds the connection gone', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann'] });
      const { openAt } = await g.open({ phase: 'lobby', questionIndex: -1 });
      const ann = g.players.Ann!;
      h.transport.gone.add(ann.connectionId);
      await g.answer('Ann', 0, choice('opt-paris'), openAt + 100);
      // The answer was stored; the ack could not be delivered.
      expect(await h.store.listPlayerResponses(g.sessionId, 0, ann.playerId)).toHaveLength(1);
      expect(await h.store.getConnection(ann.connectionId)).toBeNull();
      expect(h.transport.last(g.control, 'roster').upsert).toEqual([
        { playerId: ann.playerId, nickname: 'Ann', connected: false },
      ]);
    });

    it('does not announce a player as connected when the welcome could not be delivered', async () => {
      const h = await make();
      const g = await startGame(h);
      const id = h.cid('flaky');
      await h.service.onConnect(id, {});
      h.transport.gone.add(id);
      await h.send(id, { type: 'join', v: 1, pin: g.pin, nickname: 'Flaky' });
      expect(await h.store.getConnection(id)).toBeNull();
      expect(h.transport.ofType(g.control, 'roster')).toEqual([
        expect.objectContaining({
          upsert: [expect.objectContaining({ nickname: 'Flaky', connected: false })],
        }),
      ]);
    });

    it('still closes and deletes a kicked player whose socket is already gone', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann'] });
      h.transport.gone.add(g.players.Ann!.connectionId);
      await h.send(g.control, { type: 'host.kick', playerId: g.players.Ann!.playerId });
      expect(h.transport.closed(g.players.Ann!.connectionId)).toBe(true);
      expect(await h.store.getConnection(g.players.Ann!.connectionId)).toBeNull();
      expect(h.transport.last(g.control, 'roster')).toMatchObject({
        removed: [g.players.Ann!.playerId],
      });
      expect(h.transport.ofType(g.control, 'error')).toEqual([]);
    });

    it('logs and carries on when the cleanup itself fails', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann', 'Bob'] });
      h.transport.gone.add(g.players.Ann!.connectionId);
      h.overrides.deleteConnection = async () => {
        throw new Error('store down');
      };
      await g.open({ phase: 'lobby', questionIndex: -1 });
      expect(h.transport.ofType(g.players.Bob!.connectionId, 'question')).toHaveLength(1);
      expect(h.transport.ofType(g.control, 'error')).toEqual([]);
      expect(h.logger.entries.warn.some((w) => w.m === 'gone-connection cleanup failed')).toBe(
        true,
      );
      expect(h.logger.entries.error).toEqual([]);
      h.overrides = {};
    });
  });

  describe('fan-out', () => {
    it('sends a broadcast as one batch and shares the question message between players', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann', 'Bob', 'Cy'] });
      const batches: number[] = [];
      const send = h.transport.send.bind(h.transport);
      h.transport.send = async (batch) => {
        batches.push(batch.length);
        return send(batch);
      };
      await g.open({ phase: 'lobby', questionIndex: -1 });
      // One host.state to the control screen plus one question per player.
      expect(batches).toEqual([4]);
      h.transport.send = send;
    });

    it('lists connections once per broadcast', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann', 'Bob'] });
      h.resetCalls();
      await g.open({ phase: 'lobby', questionIndex: -1 });
      expect(h.calls.filter((c) => c === 'listConnections')).toHaveLength(1);
      h.resetCalls();
      await g.close(0);
      expect(h.calls.filter((c) => c === 'listConnections')).toHaveLength(1);
    });
  });
});
