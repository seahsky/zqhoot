import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '@zqhoot/engine';
import { ConflictError } from '@zqhoot/store';
import { describeWithStores } from './harness.ts';
import type { Harness } from './harness.ts';
import { choice, startGame, text } from './game.ts';
import { openQuiz, wordCloudQuiz } from './fixtures.ts';

const versionOf = async (h: Harness, sessionId: string) =>
  (await h.store.getSession(sessionId))!.version;

/** Runs `fail` once for the first call that matches, then delegates to the real store. */
function failOnce<K extends 'updateSession' | 'putScoreboard' | 'putQuestionResult'>(
  h: Harness,
  method: K,
  when: (...args: any[]) => boolean = () => true,
): { failures: () => number } {
  let failures = 0;
  h.overrides[method] = async (...args: any[]) => {
    if (failures === 0 && when(...args)) {
      failures++;
      throw new Error(`simulated crash in ${method}`);
    }
    return (h.real[method] as (...a: any[]) => Promise<unknown>).apply(h.real, args);
  };
  return { failures: () => failures };
}

describeWithStores('idempotency and races', (make, kind) => {
  describe('host commands', () => {
    it('ignores a repeated host.next with the same from', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann'] });
      const ann = g.players.Ann!.connectionId;
      await g.next('lobby', -1);
      const statesBefore = h.transport.ofType(g.control, 'host.state').length;
      await g.next('lobby', -1);
      expect(h.transport.ofType(ann, 'question')).toHaveLength(1);
      expect(await versionOf(h, g.sessionId)).toBe(2);
      // The repeat is answered to the requester alone, with the current state.
      expect(h.transport.ofType(g.control, 'host.state')).toHaveLength(statesBefore + 1);
      expect(h.transport.last(g.control, 'host.state').snapshot).toMatchObject({
        phase: 'question',
        sv: 2,
      });
      expect(h.transport.ofType(ann, 'question')).toHaveLength(1);
    });

    it('opens the question once when two host.next arrive together', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann', 'Bob'] });
      h.resetCalls();
      await Promise.all([g.next('lobby', -1), g.next('lobby', -1)]);
      // In memory both commands read version 1: one write won, the other lost and re-decided.
      // Over the network the second may read after the first write and never try at all.
      const writes = h.calls.filter((c) => c === 'updateSession').length;
      if (kind === 'memory') expect(writes).toBe(2);
      else expect(writes).toBeGreaterThanOrEqual(1);
      for (const name of ['Ann', 'Bob']) {
        expect(h.transport.ofType(g.players[name]!.connectionId, 'question')).toHaveLength(1);
      }
      expect(await versionOf(h, g.sessionId)).toBe(2);
      expect(h.transport.ofType(g.control, 'host.state').map((m) => m.snapshot.sv)).toEqual([2, 2]);
      expect(h.logger.entries.error).toEqual([]);
    });

    it('reveals once when host.close is pressed twice, in sequence or together', async () => {
      for (const together of [false, true]) {
        const h = await make();
        const g = await startGame(h, { players: ['Ann'] });
        const { openAt } = await g.open({ phase: 'lobby', questionIndex: -1 });
        await g.answer('Ann', 0, choice('opt-paris'), openAt + 100);
        if (together) await Promise.all([g.close(0), g.close(0)]);
        else {
          await g.close(0);
          await g.close(0);
        }
        expect(
          h.transport.ofType(g.players.Ann!.connectionId, 'reveal'),
          `${together}`,
        ).toHaveLength(1);
        expect(await versionOf(h, g.sessionId)).toBe(4);
        expect(await h.store.getScoreboard(g.sessionId)).toMatchObject({
          version: 1,
          appliedThrough: 0,
          players: { [g.players.Ann!.playerId]: { score: 1000 } },
        });
      }
    });

    it('reveals once when the timer and a manual close race', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann', 'Bob'] });
      const { openAt, deadline } = await g.open({ phase: 'lobby', questionIndex: -1 });
      await g.answer('Ann', 0, choice('opt-paris'), openAt + 100);
      h.clock.set(deadline! + 750);
      await Promise.all([h.service.onTimer(g.sessionId, 0), g.close(0, 'timer')]);
      for (const name of ['Ann', 'Bob']) {
        expect(h.transport.ofType(g.players[name]!.connectionId, 'reveal')).toHaveLength(1);
      }
      expect(await versionOf(h, g.sessionId)).toBe(4);
      expect((await h.store.getScoreboard(g.sessionId))!.version).toBe(1);
    });

    it('lets host.end win over a reveal that is still settling', async () => {
      let duringSettle: (() => Promise<void>) | undefined;
      const h = await make({
        revealSettleMs: 1000,
        onSleep: async () => {
          const run = duringSettle;
          duringSettle = undefined;
          await run?.();
        },
      });
      const g = await startGame(h, { players: ['Ann'] });
      await g.open({ phase: 'lobby', questionIndex: -1 });
      duringSettle = () => h.send(g.control, { type: 'host.end' });
      await g.close(0);
      expect(await h.store.getSession(g.sessionId)).toMatchObject({ phase: 'ended' });
      expect(h.transport.ofType(g.players.Ann!.connectionId, 'reveal')).toEqual([]);
      expect(h.transport.ofType(g.players.Ann!.connectionId, 'ended')).toHaveLength(1);
      expect(await h.store.getQuestionResult(g.sessionId, 0)).toBeNull();
      expect(h.logger.entries.error).toEqual([]);
    });
  });

  describe('a reveal that crashes half way (ADR-0006)', () => {
    async function twoPlayerQuestion(h: Harness) {
      const g = await startGame(h, { players: ['Ann', 'Bob'] });
      const { openAt } = await g.open({ phase: 'lobby', questionIndex: -1 });
      await g.answer('Ann', 0, choice('opt-paris'), openAt + 100);
      await g.answer('Bob', 0, choice('opt-rome'), openAt + 200);
      return g;
    }
    const scores = async (h: Harness, sessionId: string) =>
      Object.values((await h.store.getScoreboard(sessionId))!.players)
        .map((p) => p.score)
        .sort((a, b) => b - a);

    it('does not score twice when the meta write failed after the scoreboard write', async () => {
      const h = await make();
      const g = await twoPlayerQuestion(h);
      const crash = failOnce(h, 'updateSession', (meta: SessionMeta) => meta.phase === 'reveal');
      await g.close(0);

      expect(crash.failures()).toBe(1);
      expect(h.transport.last(g.control, 'error')).toMatchObject({
        code: 'internal',
        ref: 'host.close',
      });
      expect(await h.store.getSession(g.sessionId)).toMatchObject({ phase: 'revealing' });
      expect(await scores(h, g.sessionId)).toEqual([1000, 0]);
      expect(h.transport.ofType(g.players.Ann!.connectionId, 'reveal')).toEqual([]);
      const firstResult = await h.store.getQuestionResult(g.sessionId, 0);
      expect(firstResult).not.toBeNull();

      // The host presses next again: the stored result is reused, nothing is written twice.
      h.clock.advance(5000);
      h.resetCalls();
      await g.next('revealing', 0);
      expect(h.calls).not.toContain('putScoreboard');
      expect(h.calls).not.toContain('putQuestionResult');
      expect(h.calls).not.toContain('listResponses');
      expect(await h.store.getSession(g.sessionId)).toMatchObject({ phase: 'reveal', version: 4 });
      expect(await scores(h, g.sessionId)).toEqual([1000, 0]);
      expect(await h.store.getScoreboard(g.sessionId)).toMatchObject({ version: 1 });
      expect(await h.store.getQuestionResult(g.sessionId, 0)).toEqual(firstResult);
      expect(h.transport.last(g.players.Ann!.connectionId, 'reveal')).toMatchObject({
        sv: 4,
        you: { points: 1000, score: 1000, rank: 1 },
      });
      expect(h.transport.last(g.players.Bob!.connectionId, 'reveal').you).toMatchObject({
        correct: false,
        score: 0,
      });
      expect(h.transport.last(g.control, 'host.state').snapshot).toMatchObject({
        phase: 'reveal',
        result: { answered: 2 },
      });
    });

    it('recomputes when the crash came before the scoreboard write, and scores once', async () => {
      const h = await make();
      const g = await twoPlayerQuestion(h);
      failOnce(h, 'putScoreboard');
      await g.close(0);
      expect(await h.store.getScoreboard(g.sessionId)).toBeNull();
      expect(await h.store.getQuestionResult(g.sessionId, 0)).not.toBeNull();

      await g.next('revealing', 0);
      expect(await scores(h, g.sessionId)).toEqual([1000, 0]);
      expect(await h.store.getScoreboard(g.sessionId)).toMatchObject({
        version: 1,
        appliedThrough: 0,
      });
      expect(await h.store.getSession(g.sessionId)).toMatchObject({ phase: 'reveal' });
      expect(h.transport.ofType(g.players.Ann!.connectionId, 'reveal')).toHaveLength(1);
    });

    it('recomputes when nothing had been written yet', async () => {
      const h = await make();
      const g = await twoPlayerQuestion(h);
      failOnce(h, 'putQuestionResult');
      await g.close(0);
      expect(await h.store.getQuestionResult(g.sessionId, 0)).toBeNull();
      await g.next('revealing', 0);
      expect(await scores(h, g.sessionId)).toEqual([1000, 0]);
      expect(h.transport.ofType(g.players.Ann!.connectionId, 'reveal')).toHaveLength(1);
    });

    it('reveals once when two retries run together', async () => {
      for (const crashAt of ['putQuestionResult', 'updateSession'] as const) {
        const h = await make();
        const g = await twoPlayerQuestion(h);
        failOnce(
          h,
          crashAt,
          (meta?: SessionMeta) => crashAt !== 'updateSession' || meta?.phase === 'reveal',
        );
        await g.close(0);
        await Promise.all([g.next('revealing', 0), g.next('revealing', 0)]);
        expect(h.transport.ofType(g.players.Ann!.connectionId, 'reveal'), crashAt).toHaveLength(1);
        expect(h.transport.ofType(g.players.Bob!.connectionId, 'reveal'), crashAt).toHaveLength(1);
        expect(await scores(h, g.sessionId)).toEqual([1000, 0]);
        expect(await versionOf(h, g.sessionId)).toBe(4);
      }
    });

    it('takes the result of a concurrent run that scored the question first', async () => {
      const h = await make();
      const g = await twoPlayerQuestion(h);
      let raced = false;
      h.overrides.putScoreboard = async (...args: unknown[]) => {
        if (raced) return (h.real.putScoreboard as (...a: unknown[]) => Promise<void>)(...args);
        raced = true;
        // Another invocation finishes its scoreboard write just before ours: ours must lose.
        await (h.real.putScoreboard as (...a: unknown[]) => Promise<void>)(...args);
        throw new ConflictError();
      };
      h.resetCalls();
      await g.close(0);
      expect(raced).toBe(true);
      // Ours were the only writes; the second pass found the scoreboard applied and reused it.
      expect(h.calls.filter((c) => c === 'putScoreboard')).toHaveLength(1);
      expect(h.calls.filter((c) => c === 'putQuestionResult')).toHaveLength(1);
      expect(await scores(h, g.sessionId)).toEqual([1000, 0]);
      expect(await h.store.getScoreboard(g.sessionId)).toMatchObject({ version: 1 });
      expect(await h.store.getSession(g.sessionId)).toMatchObject({ phase: 'reveal', version: 4 });
      expect(h.transport.ofType(g.players.Ann!.connectionId, 'reveal')).toHaveLength(1);
      expect(h.logger.entries.error).toEqual([]);
    });

    it('does nothing for a reveal that is no longer pending', async () => {
      const h = await make();
      const g = await twoPlayerQuestion(h);
      await g.close(0);
      const before = h.transport.log.length;
      // A late timer or a retry for the finished reveal is a no-op.
      await h.service.onTimer(g.sessionId, 0);
      await g.next('reveal', 3);
      expect(h.transport.log.slice(before).map((s) => s.message.type)).toEqual(['host.state']);
    });
  });

  describe('answers', () => {
    it('accepts one of two identical concurrent answers and calls the other a duplicate', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann'] });
      const { openAt } = await g.open({ phase: 'lobby', questionIndex: -1 });
      await Promise.all([
        g.answer('Ann', 0, choice('opt-paris'), openAt + 100),
        g.answer('Ann', 0, choice('opt-paris'), openAt + 100),
      ]);
      const acks = h.transport.ofType(g.players.Ann!.connectionId, 'answer.ack');
      expect(acks.map((a) => a.status).sort()).toEqual(['accepted', 'duplicate']);
      expect(acks.map((a) => a.entries)).toEqual([1, 1]);
      expect(await h.store.listResponses(g.sessionId, 0)).toHaveLength(1);
    });

    it('answers a conflicting concurrent answer with the entry limit', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann'] });
      const { openAt } = await g.open({ phase: 'lobby', questionIndex: -1 });
      await Promise.all([
        g.answer('Ann', 0, choice('opt-paris'), openAt + 100),
        g.answer('Ann', 0, choice('opt-rome'), openAt + 100),
      ]);
      const acks = h.transport.ofType(g.players.Ann!.connectionId, 'answer.ack');
      expect(acks.map((a) => a.status).sort()).toEqual(['accepted', 'rejected']);
      expect(acks.find((a) => a.status === 'rejected')).toMatchObject({
        reason: 'limit',
        entries: 1,
      });
      expect(await h.store.listResponses(g.sessionId, 0)).toHaveLength(1);
    });

    it('takes both of two concurrent different word-cloud entries, in separate slots', async () => {
      const h = await make();
      const g = await startGame(h, { quiz: wordCloudQuiz(3), players: ['Ann'] });
      const { openAt } = await g.open({ phase: 'lobby', questionIndex: -1 });
      await Promise.all([
        g.answer('Ann', 0, text('apple'), openAt + 100),
        g.answer('Ann', 0, text('pear'), openAt + 100),
      ]);
      const acks = h.transport.ofType(g.players.Ann!.connectionId, 'answer.ack');
      expect(acks.map((a) => [a.status, a.entries]).sort()).toEqual([
        ['accepted', 1],
        ['accepted', 2],
      ]);
      const stored = await h.store.listPlayerResponses(g.sessionId, 0, g.players.Ann!.playerId);
      expect(stored.map((r) => r.slot)).toEqual([0, 1]);
      expect(stored.map((r) => r.normalizedText).sort()).toEqual(['apple', 'pear']);
    });

    it('calls the second of two concurrent identical words a duplicate', async () => {
      const h = await make();
      const g = await startGame(h, { quiz: wordCloudQuiz(3), players: ['Ann'] });
      const { openAt } = await g.open({ phase: 'lobby', questionIndex: -1 });
      await Promise.all([
        g.answer('Ann', 0, text('apple'), openAt + 100),
        g.answer('Ann', 0, text('Apple'), openAt + 100),
      ]);
      const acks = h.transport.ofType(g.players.Ann!.connectionId, 'answer.ack');
      expect(acks.map((a) => a.status).sort()).toEqual(['accepted', 'duplicate']);
      expect(await h.store.listResponses(g.sessionId, 0)).toHaveLength(1);
    });

    it('reads and writes nothing else on the answer path and never notifies hosts', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann', 'Bob'] });
      const { openAt } = await g.open({ phase: 'lobby', questionIndex: -1 });
      const logged = h.transport.log.length;

      // First answer on this instance: the snapshot is loaded once; later ones use the cache.
      h.resetCalls();
      await g.answer('Ann', 0, choice('opt-paris'), openAt + 100);
      expect(h.calls).toEqual(['getConnection', 'getSession', 'putResponse']);
      h.resetCalls();
      await g.answer('Bob', 0, choice('opt-rome'), openAt + 100);
      expect(h.calls).toEqual(['getConnection', 'getSession', 'putResponse']);
      // A duplicate costs the same and writes nothing new.
      h.resetCalls();
      await g.answer('Bob', 0, choice('opt-rome'), openAt + 100);
      expect(h.calls).toEqual(['getConnection', 'getSession', 'putResponse']);

      expect(h.transport.log.slice(logged).map((s) => [s.to, s.message.type])).toEqual([
        [g.players.Ann!.connectionId, 'answer.ack'],
        [g.players.Bob!.connectionId, 'answer.ack'],
        [g.players.Bob!.connectionId, 'answer.ack'],
      ]);
    });

    it('reads the player entries only for word clouds and open questions', async () => {
      const h = await make();
      const g = await startGame(h, { quiz: wordCloudQuiz(2), players: ['Ann'] });
      const { openAt } = await g.open({ phase: 'lobby', questionIndex: -1 });
      await g.answer('Ann', 0, text('one'), openAt + 100);
      h.resetCalls();
      await g.answer('Ann', 0, text('two'), openAt + 200);
      expect(h.calls).toEqual([
        'getConnection',
        'getSession',
        'listPlayerResponses',
        'putResponse',
      ]);
    });
  });

  describe('moderation', () => {
    const answeredOpen = async (h: Harness, players: string[]) => {
      const g = await startGame(h, { quiz: openQuiz(), players });
      const { openAt } = await g.open({ phase: 'lobby', questionIndex: -1 });
      for (const [i, name] of players.entries()) {
        await g.answer(name, 0, text(`answer ${name}`), openAt + 100 + i);
      }
      const moderate = (name: string) =>
        h.send(g.control, {
          type: 'host.moderate',
          questionIndex: 0,
          responseId: `${g.players[name]!.playerId}-0`,
          status: 'visible',
        });
      const storedStatuses = async () => {
        const stored = await h.store.getQuestionResult(g.sessionId, 0);
        return stored?.result.type === 'open' ? stored.result.responses.map((r) => r.status) : null;
      };
      return { g, moderate, storedStatuses };
    };
    const revealedOpen = async (h: Harness, players: string[]) => {
      const game = await answeredOpen(h, players);
      await game.g.close(0);
      return game;
    };
    /** Holds the first write of the result until `release()`; `reached` settles once it is held. */
    const gateFirstResultWrite = (h: Harness) => {
      let reachedWrite!: () => void;
      const reached = new Promise<void>((resolve) => (reachedWrite = resolve));
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let writes = 0;
      h.overrides.putQuestionResult = async (...args: unknown[]) => {
        if (writes++ === 0) {
          reachedWrite();
          await released;
        }
        return (h.real.putQuestionResult as (...a: unknown[]) => Promise<void>)(...args);
      };
      return { reached, release };
    };

    it('converges when several host.moderate arrive together during the reveal', async () => {
      const h = await make();
      const { moderate, storedStatuses } = await revealedOpen(h, ['Ann', 'Bob', 'Cy']);
      await Promise.all(['Ann', 'Bob', 'Cy'].map(moderate));
      expect(await storedStatuses()).toEqual(['visible', 'visible', 'visible']);
    });

    it('keeps the stored result in step when a slow moderation writes last', async () => {
      const h = await make();
      const { g, moderate, storedStatuses } = await revealedOpen(h, ['Ann', 'Bob']);

      // Ann's request has read the responses (Bob's still pending) when it reaches its write. Hold it
      // there until Bob's request has finished, so that its stale write is the one that lands last.
      const { reached, release: releaseWrite } = gateFirstResultWrite(h);

      const slow = moderate('Ann');
      await reached;
      await moderate('Bob');
      expect(await storedStatuses()).toEqual(['visible', 'visible']);
      releaseWrite();
      await slow;

      expect(await storedStatuses()).toEqual(['visible', 'visible']);
      // Neither request leaves the host screens on a view that misses the other's approval.
      for (const message of h.transport.ofType(g.control, 'host.state').slice(-2)) {
        const result = message.snapshot.result;
        expect(result?.type === 'open' && result.responses.map((r) => r.status)).toEqual([
          'visible',
          'visible',
        ]);
      }
      // A player who resumes now is told both responses are visible; they never receive the text.
      await h.send(h.cid('ann-new'), {
        type: 'resume',
        v: 1,
        sessionId: g.sessionId,
        playerId: g.players.Ann!.playerId,
        token: g.players.Ann!.token,
      });
      const welcome = h.transport.last(h.cid('ann-new'), 'welcome');
      const result = welcome.role === 'player' ? welcome.snapshot.reveal?.result : undefined;
      expect(result).toMatchObject({ type: 'open', responses: [], omitted: 2 });
      expect(h.logger.entries.error).toEqual([]);
    });

    it('keeps a moderation that lands while the reveal is being written', async () => {
      const h = await make();
      const { g, moderate, storedStatuses } = await answeredOpen(h, ['Ann', 'Bob']);

      // The reveal has read the responses (Ann's still pending) when it reaches its first write.
      // Ann is approved now, while the phase is still 'revealing': the moderation only sets the
      // status and relies on the reveal to notice.
      const gate = gateFirstResultWrite(h);
      const closing = g.close(0);
      await gate.reached;
      await moderate('Ann');
      expect(await h.store.getSession(g.sessionId)).toMatchObject({ phase: 'revealing' });
      gate.release();
      await closing;

      expect(await h.store.getSession(g.sessionId)).toMatchObject({ phase: 'reveal' });
      expect((await storedStatuses())?.sort()).toEqual(['pending', 'visible']);
      const hostResult = h.transport.last(g.control, 'host.state').snapshot.result;
      expect(
        hostResult?.type === 'open' && hostResult.responses.map((r) => r.status).sort(),
      ).toEqual(['pending', 'visible']);
      // Players count the approved response in their reveal, and a resume agrees with it.
      const annSees = h.transport.last(g.players.Ann!.connectionId, 'reveal').result;
      expect(annSees).toMatchObject({ type: 'open', responses: [], omitted: 1 });
      await h.send(h.cid('bob-new'), {
        type: 'resume',
        v: 1,
        sessionId: g.sessionId,
        playerId: g.players.Bob!.playerId,
        token: g.players.Bob!.token,
      });
      const welcome = h.transport.last(h.cid('bob-new'), 'welcome');
      const resumed = welcome.role === 'player' ? welcome.snapshot.reveal?.result : undefined;
      expect(resumed).toMatchObject({ type: 'open', responses: [], omitted: 1 });
      expect(h.logger.entries.error).toEqual([]);
    });

    it('keeps a moderation made between a crashed reveal and its retry', async () => {
      const h = await make();
      const { g, moderate, storedStatuses } = await answeredOpen(h, ['Ann', 'Bob']);
      failOnce(h, 'updateSession', (meta: SessionMeta) => meta.phase === 'reveal');
      await g.close(0);
      expect(await h.store.getSession(g.sessionId)).toMatchObject({ phase: 'revealing' });
      expect((await storedStatuses())?.sort()).toEqual(['pending', 'pending']);

      await moderate('Bob');
      await g.next('revealing', 0);

      expect(await h.store.getSession(g.sessionId)).toMatchObject({ phase: 'reveal' });
      expect((await storedStatuses())?.sort()).toEqual(['pending', 'visible']);
      const hostResult = h.transport.last(g.control, 'host.state').snapshot.result;
      expect(
        hostResult?.type === 'open' && hostResult.responses.map((r) => r.status).sort(),
      ).toEqual(['pending', 'visible']);
      expect(h.transport.last(g.players.Ann!.connectionId, 'reveal').result).toMatchObject({
        responses: [],
        omitted: 1,
      });
    });

    it('gives up after three passes when the statuses keep changing', async () => {
      const h = await make();
      const { g, moderate } = await revealedOpen(h, ['Ann', 'Bob']);
      const bob = `${g.players.Bob!.playerId}-0`;
      // Every write of the result is followed by another status change, as if hosts kept clicking.
      let writes = 0;
      h.overrides.putQuestionResult = async (...args: unknown[]) => {
        writes++;
        await h.real.setResponseStatus(
          g.sessionId,
          0,
          bob,
          writes % 2 === 1 ? 'visible' : 'hidden',
        );
        return (h.real.putQuestionResult as (...a: unknown[]) => Promise<void>)(...args);
      };
      await moderate('Ann');
      expect(writes).toBe(3);
      expect(h.logger.entries.warn).toHaveLength(1);
      // The screens still get a result rather than nothing.
      expect(h.transport.last(g.control, 'host.state').snapshot.result?.type).toBe('open');
    });
  });
});
