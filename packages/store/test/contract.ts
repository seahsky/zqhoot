import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionMeta } from '@zqhoot/engine';
import type { AnswerPayload } from '@zqhoot/protocol';
import {
  ConflictError,
  NotFoundError,
  RESPONSE_SHARDS,
  responseShard,
  type Store,
} from '../src/index.ts';
import {
  CLOCK_START,
  DAY_MS,
  allQuestions,
  allResults,
  createClock,
  makeConnection,
  makeMeta,
  makePlayer,
  makeQuiz,
  makeResponse,
  makeScoreboard,
  makeSnapshot,
  settings,
  uid,
  type TestClock,
} from './fixtures.ts';

const HOUR_MS = 3_600_000;

/** A player ID (nanoid-style) that hashes into `shard`, found by search. */
function playerIdInShard(shard: number, prefix: string): string {
  for (let i = 0; ; i++) {
    const id = `${prefix}${i}`;
    if (responseShard(id) === shard) return id;
  }
}

const rejectsConflict = (promise: Promise<unknown>) =>
  expect(promise).rejects.toBeInstanceOf(ConflictError);

/** How many of `results` are 'ok' etc. */
const countOf = <T>(results: T[], value: T) => results.filter((r) => r === value).length;

/**
 * The behaviour every `Store` implementation must have. `makeStore` receives a manually
 * driven clock that the store must use for expiry; each test gets a fresh store and clock,
 * but stores may share a backing table, so every test uses IDs from `uid()`.
 */
export function runStoreContract(
  name: string,
  makeStore: (clock: TestClock) => Promise<Store>,
): void {
  describe(`Store contract: ${name}`, () => {
    let clock: TestClock;
    let store: Store;
    const advance = (ms: number) => clock.set(clock.now() + ms);

    beforeEach(async () => {
      clock = createClock();
      store = await makeStore(clock);
    });

    describe('quizzes', () => {
      it('creates, reads, lists and deletes', async () => {
        const owner = uid('owner');
        const quiz = makeQuiz(owner);
        await store.putQuiz(quiz);
        expect(await store.getQuiz(owner, quiz.id)).toEqual(quiz);
        expect(await store.listQuizzes(owner)).toEqual([
          {
            id: quiz.id,
            title: quiz.title,
            questionCount: quiz.questions.length,
            updatedAt: quiz.updatedAt,
            version: quiz.version,
          },
        ]);
        await store.deleteQuiz(owner, quiz.id);
        expect(await store.getQuiz(owner, quiz.id)).toBeNull();
        expect(await store.listQuizzes(owner)).toEqual([]);
      });

      it('deleting a missing quiz is a no-op', async () => {
        await expect(store.deleteQuiz(uid('owner'), uid('quiz'))).resolves.toBeUndefined();
      });

      it('returns null and an empty list for unknown owners', async () => {
        expect(await store.getQuiz(uid('owner'), uid('quiz'))).toBeNull();
        expect(await store.listQuizzes(uid('owner'))).toEqual([]);
      });

      it('replaces only when the stored version matches', async () => {
        const owner = uid('owner');
        const quiz = makeQuiz(owner);
        await store.putQuiz(quiz);
        const v1 = { ...quiz, title: 'Edited', version: 1, updatedAt: quiz.updatedAt + 1 };
        await store.putQuiz(v1, 0);
        expect(await store.getQuiz(owner, quiz.id)).toEqual(v1);
        await rejectsConflict(store.putQuiz({ ...quiz, title: 'Stale', version: 1 }, 0));
        expect(await store.getQuiz(owner, quiz.id)).toEqual(v1);
      });

      it('conflicts when creating an id that exists', async () => {
        const owner = uid('owner');
        const quiz = makeQuiz(owner);
        await store.putQuiz(quiz);
        await rejectsConflict(store.putQuiz({ ...quiz, title: 'Other' }));
        expect((await store.getQuiz(owner, quiz.id))?.title).toBe(quiz.title);
      });

      it('conflicts when replacing a quiz that does not exist', async () => {
        await rejectsConflict(store.putQuiz(makeQuiz(uid('owner')), 0));
      });

      it('lets exactly one of several concurrent updates win', async () => {
        const owner = uid('owner');
        const quiz = makeQuiz(owner);
        await store.putQuiz(quiz);
        const results = await Promise.allSettled(
          Array.from({ length: 5 }, (_, i) =>
            store.putQuiz({ ...quiz, title: `Edit ${i}`, version: 1 }, 0),
          ),
        );
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        for (const r of results) {
          if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(ConflictError);
        }
      });

      it('keeps owners apart', async () => {
        const [a, b] = [uid('owner'), uid('owner')];
        const quiz = makeQuiz(a);
        await store.putQuiz(quiz);
        await store.putQuiz({ ...quiz, ownerId: b, title: 'Other owner' });
        expect((await store.getQuiz(a, quiz.id))?.title).toBe(quiz.title);
        expect((await store.getQuiz(b, quiz.id))?.title).toBe('Other owner');
        expect(await store.listQuizzes(a)).toHaveLength(1);
      });

      it('lists more than one page, most recently updated first', async () => {
        const owner = uid('owner');
        const quizzes = Array.from({ length: 12 }, (_, i) =>
          makeQuiz(owner, { updatedAt: CLOCK_START + (i % 6) * 1000 }),
        );
        for (const q of quizzes) await store.putQuiz(q);
        const listed = await store.listQuizzes(owner);
        expect(listed).toHaveLength(12);
        const expected = [...quizzes]
          .sort((x, y) => y.updatedAt - x.updatedAt || (x.id < y.id ? -1 : 1))
          .map((q) => q.id);
        expect(listed.map((q) => q.id)).toEqual(expected);
      });

      it('lists summaries with exactly the summary fields', async () => {
        const owner = uid('owner');
        await store.putQuiz(makeQuiz(owner));
        const [summary] = await store.listQuizzes(owner);
        expect(Object.keys(summary ?? {}).sort()).toEqual([
          'id',
          'questionCount',
          'title',
          'updatedAt',
          'version',
        ]);
      });
    });

    describe('PINs', () => {
      it('reserves, resolves and releases', async () => {
        const pin = uid('pin');
        const sid = uid('sess');
        expect(await store.getSessionIdByPin(pin)).toBeNull();
        expect(await store.reservePin(pin, sid, clock.now() + HOUR_MS)).toBe(true);
        expect(await store.getSessionIdByPin(pin)).toBe(sid);
        await store.releasePin(pin, sid);
        expect(await store.getSessionIdByPin(pin)).toBeNull();
      });

      it('refuses a PIN that a live session holds', async () => {
        const pin = uid('pin');
        const first = uid('sess');
        expect(await store.reservePin(pin, first, clock.now() + HOUR_MS)).toBe(true);
        expect(await store.reservePin(pin, uid('sess'), clock.now() + HOUR_MS)).toBe(false);
        expect(await store.getSessionIdByPin(pin)).toBe(first);
      });

      it('lets the session that holds a PIN claim it again, which renews the claim', async () => {
        const pin = uid('pin');
        const owner = uid('sess');
        const firstExpiry = clock.now() + HOUR_MS;
        expect(await store.reservePin(pin, owner, firstExpiry)).toBe(true);
        expect(await store.reservePin(pin, owner, firstExpiry + 2 * HOUR_MS)).toBe(true);
        expect(await store.reservePin(pin, uid('sess'), firstExpiry + 3 * HOUR_MS)).toBe(false);
        clock.set(firstExpiry);
        expect(await store.getSessionIdByPin(pin)).toBe(owner);
        clock.set(firstExpiry + 2 * HOUR_MS);
        expect(await store.getSessionIdByPin(pin)).toBeNull();
      });

      it('releases only for the owning session', async () => {
        const pin = uid('pin');
        const owner = uid('sess');
        await store.reservePin(pin, owner, clock.now() + HOUR_MS);
        await store.releasePin(pin, uid('sess'));
        expect(await store.getSessionIdByPin(pin)).toBe(owner);
        await store.releasePin(pin, owner);
        expect(await store.reservePin(pin, uid('sess'), clock.now() + HOUR_MS)).toBe(true);
      });

      it('releasing an unknown PIN is a no-op', async () => {
        await expect(store.releasePin(uid('pin'), uid('sess'))).resolves.toBeUndefined();
      });

      it('treats an expired claim as absent and lets the PIN be reused', async () => {
        const pin = uid('pin');
        const old = uid('sess');
        const expiresAt = clock.now() + HOUR_MS;
        await store.reservePin(pin, old, expiresAt);
        clock.set(expiresAt - 1000);
        expect(await store.getSessionIdByPin(pin)).toBe(old);
        clock.set(expiresAt);
        expect(await store.getSessionIdByPin(pin)).toBeNull();
        const next = uid('sess');
        expect(await store.reservePin(pin, next, expiresAt + HOUR_MS)).toBe(true);
        expect(await store.getSessionIdByPin(pin)).toBe(next);
      });

      it('lets exactly one of several concurrent reservations win', async () => {
        const pin = uid('pin');
        const results = await Promise.all(
          Array.from({ length: 10 }, () =>
            store.reservePin(pin, uid('sess'), clock.now() + HOUR_MS),
          ),
        );
        expect(countOf(results, true)).toBe(1);
      });
    });

    describe('sessions', () => {
      it('creates a session and reads meta and snapshot back', async () => {
        const meta = makeMeta();
        const snapshot = makeSnapshot(meta.quizId);
        await store.createSession(meta, snapshot);
        expect(await store.getSession(meta.sessionId)).toEqual(meta);
        expect(await store.getSnapshot(meta.sessionId)).toEqual(snapshot);
      });

      it('returns null for unknown sessions', async () => {
        expect(await store.getSession(uid('sess'))).toBeNull();
        expect(await store.getSnapshot(uid('sess'))).toBeNull();
      });

      it('conflicts when the session exists and leaves it untouched', async () => {
        const meta = makeMeta();
        const snapshot = makeSnapshot(meta.quizId);
        await store.createSession(meta, snapshot);
        await rejectsConflict(
          store.createSession({ ...meta, quizTitle: 'Other' }, { ...snapshot, title: 'Other' }),
        );
        expect((await store.getSession(meta.sessionId))?.quizTitle).toBe(meta.quizTitle);
        expect((await store.getSnapshot(meta.sessionId))?.title).toBe(snapshot.title);
      });

      it('updates meta only when the version matches', async () => {
        const meta = makeMeta({ version: 0 });
        await store.createSession(meta, makeSnapshot(meta.quizId));
        const next = { ...meta, phase: 'reveal' as const, version: 1 };
        await store.updateSession(next, 0);
        expect(await store.getSession(meta.sessionId)).toEqual(next);
        await rejectsConflict(store.updateSession({ ...meta, version: 1 }, 0));
        await store.updateSession({ ...next, version: 2 }, 1);
        expect((await store.getSession(meta.sessionId))?.version).toBe(2);
      });

      it('conflicts when updating a session that does not exist', async () => {
        await rejectsConflict(store.updateSession(makeMeta(), 3));
      });

      it('lets exactly one of two concurrent updates from the same version win', async () => {
        const meta = makeMeta({ version: 1 });
        await store.createSession(meta, makeSnapshot(meta.quizId));
        const results = await Promise.allSettled([
          store.updateSession({ ...meta, locked: false, version: 2 }, 1),
          store.updateSession({ ...meta, phase: 'reveal', version: 2 }, 1),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
        const rejected = results.find((r) => r.status === 'rejected');
        expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(ConflictError);
      });

      it('hides a session once it has expired', async () => {
        const meta = makeMeta({ expiresAt: clock.now() + DAY_MS });
        await store.createSession(meta, makeSnapshot(meta.quizId));
        clock.set(meta.expiresAt - 1000);
        expect(await store.getSession(meta.sessionId)).not.toBeNull();
        expect(await store.getSnapshot(meta.sessionId)).not.toBeNull();
        clock.set(meta.expiresAt);
        expect(await store.getSession(meta.sessionId)).toBeNull();
        expect(await store.getSnapshot(meta.sessionId)).toBeNull();
      });

      it('does not let an update bring an expired session back', async () => {
        const meta = makeMeta({ version: 0, expiresAt: clock.now() + HOUR_MS });
        await store.createSession(meta, makeSnapshot(meta.quizId));
        clock.set(meta.expiresAt);
        const extended = { ...meta, version: 1, expiresAt: meta.expiresAt + DAY_MS };
        await rejectsConflict(store.updateSession(extended, 0));
        expect(await store.getSession(meta.sessionId)).toBeNull();
      });

      it('can create a session again once the one with that id has expired', async () => {
        const meta = makeMeta({ expiresAt: clock.now() + HOUR_MS });
        await store.createSession(meta, makeSnapshot(meta.quizId));
        clock.set(meta.expiresAt);
        const reborn = {
          ...meta,
          quizTitle: 'Again',
          version: 0,
          expiresAt: meta.expiresAt + HOUR_MS,
        };
        const snapshot = { ...makeSnapshot(meta.quizId), title: 'Again' };
        await store.createSession(reborn, snapshot);
        expect(await store.getSession(meta.sessionId)).toEqual(reborn);
        expect(await store.getSnapshot(meta.sessionId)).toEqual(snapshot);
      });

      it('keeps the records that were written before the session itself', async () => {
        const meta = makeMeta();
        const sid = meta.sessionId;
        const expiresAt = clock.now() + DAY_MS;
        const player = makePlayer(sid);
        const conn = makeConnection(sid);
        const response = makeResponse(sid, 0, player.playerId);
        const [result] = allResults(sid);
        const scoreboard = makeScoreboard(sid);
        await store.addPlayer(player, expiresAt);
        await store.putConnection(conn);
        await store.putResponse(response, expiresAt);
        await store.putQuestionResult(result!, expiresAt);
        await store.putScoreboard(scoreboard, undefined, expiresAt);

        await store.createSession(meta, makeSnapshot(meta.quizId));

        expect(await store.getSession(sid)).toEqual(meta);
        expect(await store.getPlayer(sid, player.playerId)).toEqual(player);
        expect(await store.countPlayers(sid)).toBe(1);
        expect(await store.getConnection(conn.connectionId)).toEqual(conn);
        expect(await store.listConnections(sid)).toEqual([conn]);
        expect(await store.listResponses(sid, 0)).toEqual([response]);
        expect(await store.getQuestionResult(sid, 0)).toEqual(result);
        expect(await store.getScoreboard(sid)).toEqual(scoreboard);
        const rival = makePlayer(sid, { nicknameKey: player.nicknameKey });
        expect(await store.addPlayer(rival, expiresAt)).toBe('nickname-taken');
      });

      describe('listSessionsByHost', () => {
        const create = async (
          hostId: string,
          createdAt: number,
          over: Partial<SessionMeta> = {},
        ) => {
          const meta = makeMeta({
            hostId,
            createdAt,
            expiresAt: CLOCK_START + 30 * DAY_MS,
            ...over,
          });
          await store.createSession(meta, makeSnapshot(meta.quizId));
          return meta;
        };

        it('lists newest first and respects the limit', async () => {
          const host = uid('host');
          const metas = [];
          for (const offset of [3, 0, 4, 1, 2])
            metas.push(await create(host, CLOCK_START + offset * 1000));
          const newestFirst = [...metas].sort((a, b) => b.createdAt - a.createdAt);
          const listed = await store.listSessionsByHost(host, 100);
          expect(listed.map((s) => s.sessionId)).toEqual(newestFirst.map((m) => m.sessionId));
          expect(listed[0]).toEqual({
            sessionId: newestFirst[0]?.sessionId,
            pin: newestFirst[0]?.pin,
            quizId: newestFirst[0]?.quizId,
            quizTitle: newestFirst[0]?.quizTitle,
            phase: newestFirst[0]?.phase,
            createdAt: newestFirst[0]?.createdAt,
            expiresAt: newestFirst[0]?.expiresAt,
          });
          const top = await store.listSessionsByHost(host, 2);
          expect(top.map((s) => s.sessionId)).toEqual(
            newestFirst.slice(0, 2).map((m) => m.sessionId),
          );
          expect(await store.listSessionsByHost(host, 0)).toEqual([]);
        });

        it('lists across several pages', async () => {
          const host = uid('host');
          for (let i = 0; i < 12; i++) await create(host, CLOCK_START + i * 1000);
          const listed = await store.listSessionsByHost(host, 100);
          expect(listed).toHaveLength(12);
          expect(listed.map((s) => s.createdAt)).toEqual(
            Array.from({ length: 12 }, (_, i) => CLOCK_START + (11 - i) * 1000),
          );
          expect(await store.listSessionsByHost(host, 7)).toHaveLength(7);
        });

        it('treats an infinite limit as no limit', async () => {
          const host = uid('host');
          for (let i = 0; i < 8; i++) await create(host, CLOCK_START + i * 1000);
          const listed = await store.listSessionsByHost(host, Infinity);
          expect(listed.map((s) => s.createdAt)).toEqual(
            Array.from({ length: 8 }, (_, i) => CLOCK_START + (7 - i) * 1000),
          );
        });

        it('breaks creation-time ties by descending session id', async () => {
          const host = uid('host');
          const a = await create(host, CLOCK_START, { sessionId: `tie-${uid('a')}` });
          const b = await create(host, CLOCK_START, { sessionId: `tie-${uid('b')}` });
          const ids = [a.sessionId, b.sessionId].sort().reverse();
          expect((await store.listSessionsByHost(host, 10)).map((s) => s.sessionId)).toEqual(ids);
        });

        it('lists only the requested host', async () => {
          const [h1, h2] = [uid('host'), uid('host')];
          const mine = await create(h1, CLOCK_START);
          await create(h2, CLOCK_START);
          expect((await store.listSessionsByHost(h1, 10)).map((s) => s.sessionId)).toEqual([
            mine.sessionId,
          ]);
          expect(await store.listSessionsByHost(uid('host'), 10)).toEqual([]);
        });

        it('reflects updates and leaves out expired sessions', async () => {
          const host = uid('host');
          const short = await create(host, CLOCK_START, { expiresAt: CLOCK_START + HOUR_MS });
          const long = await create(host, CLOCK_START + 1000, { version: 0, phase: 'lobby' });
          await store.updateSession({ ...long, phase: 'ended', version: 1 }, 0);
          expect((await store.listSessionsByHost(host, 10)).map((s) => s.phase)).toEqual([
            'ended',
            short.phase,
          ]);
          clock.set(short.expiresAt);
          expect((await store.listSessionsByHost(host, 10)).map((s) => s.sessionId)).toEqual([
            long.sessionId,
          ]);
        });

        it('still returns `limit` sessions when expired ones sit at the front', async () => {
          const host = uid('host');
          const live = await create(host, CLOCK_START);
          for (let i = 1; i <= 5; i++) {
            await create(host, CLOCK_START + i * 1000, { expiresAt: CLOCK_START + HOUR_MS });
          }
          clock.set(CLOCK_START + HOUR_MS);
          expect((await store.listSessionsByHost(host, 1)).map((s) => s.sessionId)).toEqual([
            live.sessionId,
          ]);
        });
      });
    });

    describe('players', () => {
      const expires = () => clock.now() + DAY_MS;

      it('adds a player and reads it back', async () => {
        const sid = uid('sess');
        const player = makePlayer(sid);
        expect(await store.addPlayer(player, expires())).toBe('ok');
        expect(await store.getPlayer(sid, player.playerId)).toEqual(player);
        expect(await store.getPlayer(sid, uid('pl'))).toBeNull();
        expect(await store.getPlayer(uid('sess'), player.playerId)).toBeNull();
      });

      it('rejects a nickname key already taken in the session', async () => {
        const sid = uid('sess');
        const first = makePlayer(sid);
        await store.addPlayer(first, expires());
        const second = makePlayer(sid, { nicknameKey: first.nicknameKey });
        expect(await store.addPlayer(second, expires())).toBe('nickname-taken');
        expect(await store.getPlayer(sid, second.playerId)).toBeNull();
        expect(await store.countPlayers(sid)).toBe(1);
      });

      it('allows the same nickname key in another session', async () => {
        const first = makePlayer(uid('sess'));
        const second = makePlayer(uid('sess'), { nicknameKey: first.nicknameKey });
        expect(await store.addPlayer(first, expires())).toBe('ok');
        expect(await store.addPlayer(second, expires())).toBe('ok');
      });

      it('conflicts on a duplicate player id and claims no nickname for it', async () => {
        const sid = uid('sess');
        const first = makePlayer(sid);
        await store.addPlayer(first, expires());
        const clash = makePlayer(sid, { playerId: first.playerId });
        await rejectsConflict(store.addPlayer(clash, expires()));
        const other = makePlayer(sid, { nicknameKey: clash.nicknameKey });
        expect(await store.addPlayer(other, expires())).toBe('ok');
      });

      it('lets exactly one of ten concurrent joins with the same nickname win', async () => {
        const sid = uid('sess');
        const nicknameKey = uid('nick');
        const players = Array.from({ length: 10 }, () => makePlayer(sid, { nicknameKey }));
        const results = await Promise.all(players.map((p) => store.addPlayer(p, expires())));
        expect(countOf(results, 'ok')).toBe(1);
        expect(countOf(results, 'nickname-taken')).toBe(9);
        expect(await store.countPlayers(sid)).toBe(1);
        const winner = players[results.indexOf('ok')];
        expect(await store.listPlayers(sid)).toEqual([winner]);
      });

      it('updates kicked and lastSeenAt without touching other fields', async () => {
        const sid = uid('sess');
        const player = makePlayer(sid);
        await store.addPlayer(player, expires());
        await store.updatePlayer(sid, player.playerId, { kicked: true });
        expect(await store.getPlayer(sid, player.playerId)).toEqual({ ...player, kicked: true });
        await store.updatePlayer(sid, player.playerId, { lastSeenAt: 99 });
        expect(await store.getPlayer(sid, player.playerId)).toEqual({
          ...player,
          kicked: true,
          lastSeenAt: 99,
        });
        await store.updatePlayer(sid, player.playerId, { kicked: false, lastSeenAt: 5 });
        expect(await store.getPlayer(sid, player.playerId)).toEqual({
          ...player,
          kicked: false,
          lastSeenAt: 5,
        });
      });

      it('throws when the player to update does not exist', async () => {
        const sid = uid('sess');
        await expect(store.updatePlayer(sid, uid('pl'), { kicked: true })).rejects.toBeInstanceOf(
          NotFoundError,
        );
        await expect(store.updatePlayer(sid, uid('pl'), {})).rejects.toBeInstanceOf(NotFoundError);
        const player = makePlayer(sid);
        await store.addPlayer(player, expires());
        await expect(store.updatePlayer(sid, player.playerId, {})).resolves.toBeUndefined();
        expect(await store.getPlayer(sid, player.playerId)).toEqual(player);
      });

      it('does not create a player when updating a missing one', async () => {
        const sid = uid('sess');
        const id = uid('pl');
        await expect(store.updatePlayer(sid, id, { lastSeenAt: 5 })).rejects.toThrow();
        expect(await store.getPlayer(sid, id)).toBeNull();
        expect(await store.countPlayers(sid)).toBe(0);
      });

      it('counts and lists kicked players like any other', async () => {
        const sid = uid('sess');
        const players = Array.from({ length: 12 }, () => makePlayer(sid));
        for (const p of players) await store.addPlayer(p, expires());
        for (const p of players.slice(0, 3))
          await store.updatePlayer(sid, p.playerId, { kicked: true });
        const listed = await store.listPlayers(sid);
        expect(await store.countPlayers(sid)).toBe(12);
        expect(listed).toHaveLength(12);
        expect(listed.filter((p) => p.kicked)).toHaveLength(3);
        expect(listed.map((p) => p.playerId)).toEqual(players.map((p) => p.playerId).sort());
      });

      it('handles an empty or unknown session', async () => {
        expect(await store.listPlayers(uid('sess'))).toEqual([]);
        expect(await store.countPlayers(uid('sess'))).toBe(0);
      });

      it('keeps sessions apart', async () => {
        const [s1, s2] = [uid('sess'), uid('sess')];
        await store.addPlayer(makePlayer(s1), expires());
        await store.addPlayer(makePlayer(s1), expires());
        await store.addPlayer(makePlayer(s2), expires());
        expect(await store.countPlayers(s1)).toBe(2);
        expect(await store.countPlayers(s2)).toBe(1);
      });

      it('hides players once they expire', async () => {
        const sid = uid('sess');
        const player = makePlayer(sid);
        const expiresAt = clock.now() + HOUR_MS;
        await store.addPlayer(player, expiresAt);
        await store.addPlayer(makePlayer(sid), expiresAt + HOUR_MS);
        clock.set(expiresAt - 1000);
        expect(await store.countPlayers(sid)).toBe(2);
        clock.set(expiresAt);
        expect(await store.getPlayer(sid, player.playerId)).toBeNull();
        expect(await store.listPlayers(sid)).toHaveLength(1);
        expect(await store.countPlayers(sid)).toBe(1);
      });

      it('treats an expired player as missing for updates and lets it join afresh', async () => {
        const sid = uid('sess');
        const player = makePlayer(sid);
        const expiresAt = clock.now() + HOUR_MS;
        await store.addPlayer(player, expiresAt);
        clock.set(expiresAt);
        await expect(
          store.updatePlayer(sid, player.playerId, { kicked: true }),
        ).rejects.toBeInstanceOf(NotFoundError);
        await expect(store.updatePlayer(sid, player.playerId, {})).rejects.toBeInstanceOf(
          NotFoundError,
        );
        expect(await store.getPlayer(sid, player.playerId)).toBeNull();

        const again = makePlayer(sid, {
          playerId: player.playerId,
          nicknameKey: player.nicknameKey,
        });
        expect(await store.addPlayer(again, expiresAt + HOUR_MS)).toBe('ok');
        expect(await store.getPlayer(sid, player.playerId)).toEqual(again);
      });
    });

    describe('connections', () => {
      it('stores and reads player and host connections', async () => {
        const sid = uid('sess');
        const player = makeConnection(sid);
        const host = makeConnection(sid, { role: 'host', client: 'present' });
        delete host.playerId;
        await store.putConnection(player);
        await store.putConnection(host);
        expect(await store.getConnection(player.connectionId)).toEqual(player);
        expect(await store.getConnection(host.connectionId)).toEqual(host);
        expect(await store.getConnection(uid('conn'))).toBeNull();
        const listed = await store.listConnections(sid);
        expect(listed).toHaveLength(2);
        expect(listed).toEqual(expect.arrayContaining([player, host]));
      });

      it('lists only the connections of the session', async () => {
        const [s1, s2] = [uid('sess'), uid('sess')];
        const mine = makeConnection(s1);
        await store.putConnection(mine);
        await store.putConnection(makeConnection(s2));
        expect(await store.listConnections(s1)).toEqual([mine]);
        expect(await store.listConnections(uid('sess'))).toEqual([]);
      });

      it('lists more than one page', async () => {
        const sid = uid('sess');
        const conns = Array.from({ length: 12 }, () => makeConnection(sid));
        for (const c of conns) await store.putConnection(c);
        const listed = await store.listConnections(sid);
        expect(listed.map((c) => c.connectionId).sort()).toEqual(
          conns.map((c) => c.connectionId).sort(),
        );
      });

      it('overwrites a connection that is put again', async () => {
        const sid = uid('sess');
        const conn = makeConnection(sid);
        await store.putConnection(conn);
        const renewed = { ...conn, expiresAt: conn.expiresAt + HOUR_MS };
        await store.putConnection(renewed);
        expect(await store.getConnection(conn.connectionId)).toEqual(renewed);
        expect(await store.listConnections(sid)).toEqual([renewed]);
      });

      it('moves a connection that is put again under another session', async () => {
        const [s1, s2] = [uid('sess'), uid('sess')];
        const conn = makeConnection(s1);
        const other = makeConnection(s1);
        await store.putConnection(conn);
        await store.putConnection(other);
        const moved = { ...conn, sessionId: s2 };
        await store.putConnection(moved);
        expect(await store.getConnection(conn.connectionId)).toEqual(moved);
        expect(await store.listConnections(s1)).toEqual([other]);
        expect(await store.listConnections(s2)).toEqual([moved]);
        await store.deleteConnection(conn.connectionId);
        expect(await store.listConnections(s2)).toEqual([]);
        expect(await store.listConnections(s1)).toEqual([other]);
      });

      it('deletes idempotently and removes it from the session list', async () => {
        const sid = uid('sess');
        const [a, b] = [makeConnection(sid), makeConnection(sid)];
        await store.putConnection(a);
        await store.putConnection(b);
        await store.deleteConnection(a.connectionId);
        expect(await store.getConnection(a.connectionId)).toBeNull();
        expect(await store.listConnections(sid)).toEqual([b]);
        await expect(store.deleteConnection(a.connectionId)).resolves.toBeUndefined();
        await expect(store.deleteConnection(uid('conn'))).resolves.toBeUndefined();
        expect(await store.listConnections(sid)).toEqual([b]);
      });

      it('hides connections once they expire', async () => {
        const sid = uid('sess');
        const short = makeConnection(sid, { expiresAt: clock.now() + HOUR_MS });
        const long = makeConnection(sid, { expiresAt: clock.now() + 3 * HOUR_MS });
        await store.putConnection(short);
        await store.putConnection(long);
        clock.set(short.expiresAt - 1000);
        expect(await store.listConnections(sid)).toHaveLength(2);
        clock.set(short.expiresAt);
        expect(await store.getConnection(short.connectionId)).toBeNull();
        expect(await store.getConnection(long.connectionId)).toEqual(long);
        expect(await store.listConnections(sid)).toEqual([long]);
      });

      it('can delete a connection that has already expired', async () => {
        const sid = uid('sess');
        const conn = makeConnection(sid, { expiresAt: clock.now() + HOUR_MS });
        await store.putConnection(conn);
        advance(2 * HOUR_MS);
        await expect(store.deleteConnection(conn.connectionId)).resolves.toBeUndefined();
      });
    });

    describe('responses', () => {
      const expires = () => clock.now() + DAY_MS;

      it('stores the first response and returns it on a duplicate write', async () => {
        const sid = uid('sess');
        const pid = uid('pl');
        const first = makeResponse(sid, 0, pid);
        expect(await store.putResponse(first, expires())).toEqual({ created: true });
        const second = makeResponse(sid, 0, pid, {
          payload: { kind: 'choice', optionId: 'opt-rome' },
          receivedAt: first.receivedAt + 500,
          correct: false,
          points: 0,
        });
        expect(await store.putResponse(second, expires())).toEqual({
          created: false,
          existing: first,
        });
        expect(await store.listPlayerResponses(sid, 0, pid)).toEqual([first]);
      });

      it('lets exactly one of ten concurrent writes for the same identity win', async () => {
        const sid = uid('sess');
        const pid = uid('pl');
        const attempts = Array.from({ length: 10 }, (_, i) =>
          makeResponse(sid, 3, pid, {
            payload: { kind: 'rating', value: (i % 5) + 1 },
            receivedAt: CLOCK_START + i,
          }),
        );
        const results = await Promise.all(attempts.map((r) => store.putResponse(r, expires())));
        const created = results.filter((r) => r.created);
        expect(created).toHaveLength(1);
        const winner = attempts[results.findIndex((r) => r.created)];
        for (const r of results) {
          if (!r.created) expect(r.existing).toEqual(winner);
        }
        expect(await store.listPlayerResponses(sid, 3, pid)).toEqual([winner]);
        expect(await store.listResponses(sid, 3)).toEqual([winner]);
      });

      it('keeps slots of one player apart and lists them in slot order', async () => {
        const sid = uid('sess');
        const pid = uid('pl');
        for (const slot of [2, 0, 1]) {
          const payload: AnswerPayload = { kind: 'text', text: `word ${slot}` };
          const r = makeResponse(sid, 1, pid, { slot, payload, normalizedText: `word ${slot}` });
          expect(await store.putResponse(r, expires())).toEqual({ created: true });
        }
        const listed = await store.listPlayerResponses(sid, 1, pid);
        expect(listed.map((r) => r.slot)).toEqual([0, 1, 2]);
        expect(listed.map((r) => r.responseId)).toEqual([`${pid}-0`, `${pid}-1`, `${pid}-2`]);
      });

      it('lists responses of every shard sorted by receivedAt then responseId', async () => {
        const sid = uid('sess');
        const players = Array.from({ length: RESPONSE_SHARDS * 3 }, (_, i) =>
          playerIdInShard(i % RESPONSE_SHARDS, `p${i}-`),
        );
        expect(new Set(players.map(responseShard)).size).toBe(RESPONSE_SHARDS);
        // Few distinct times, so ties are broken by responseId.
        const all = players.map((pid, i) =>
          makeResponse(sid, 5, pid, { receivedAt: CLOCK_START + ((i * 7) % 5) * 100 }),
        );
        for (const r of [...all].reverse()) await store.putResponse(r, expires());
        const expected = [...all].sort(
          (a, b) =>
            a.receivedAt - b.receivedAt ||
            (a.responseId < b.responseId ? -1 : a.responseId > b.responseId ? 1 : 0),
        );
        expect(await store.listResponses(sid, 5)).toEqual(expected);
      });

      it('lists one question and one session at a time', async () => {
        const [s1, s2] = [uid('sess'), uid('sess')];
        const pid = uid('pl');
        const wanted = makeResponse(s1, 2, pid);
        await store.putResponse(wanted, expires());
        await store.putResponse(makeResponse(s1, 12, pid), expires());
        await store.putResponse(makeResponse(s1, 21, pid), expires());
        await store.putResponse(makeResponse(s2, 2, pid), expires());
        expect(await store.listResponses(s1, 2)).toEqual([wanted]);
        expect(await store.listPlayerResponses(s1, 2, pid)).toEqual([wanted]);
        expect(await store.listResponses(s1, 99)).toEqual([]);
      });

      it('lists more than one page of responses', async () => {
        const sid = uid('sess');
        const players = Array.from({ length: 14 }, () => uid('pl'));
        for (const [i, pid] of players.entries()) {
          await store.putResponse(
            makeResponse(sid, 0, pid, { receivedAt: CLOCK_START + i }),
            expires(),
          );
        }
        const listed = await store.listResponses(sid, 0);
        expect(listed.map((r) => r.playerId)).toEqual(players);
      });

      it('does not mix up a player with one whose id extends it', async () => {
        const sid = uid('sess');
        const shard = 1;
        const base = playerIdInShard(shard, 'base');
        // Same shard, and `longer` starts with `base`, so a sloppy prefix match would confuse them.
        let n = 0;
        let longer = `${base}-0`;
        while (responseShard(longer) !== shard) longer = `${base}-${++n}`;
        const mine = makeResponse(sid, 0, base);
        const theirs = makeResponse(sid, 0, longer);
        await store.putResponse(mine, expires());
        await store.putResponse(theirs, expires());
        expect(await store.listPlayerResponses(sid, 0, base)).toEqual([mine]);
        expect(await store.listPlayerResponses(sid, 0, longer)).toEqual([theirs]);
      });

      it('sets the moderation status of one response', async () => {
        const sid = uid('sess');
        const pid = uid('pl');
        const a = makeResponse(sid, 4, pid, { slot: 0, status: 'pending' });
        const b = makeResponse(sid, 4, pid, { slot: 1, status: 'pending' });
        await store.putResponse(a, expires());
        await store.putResponse(b, expires());
        await store.setResponseStatus(sid, 4, b.responseId, 'hidden');
        expect(await store.listPlayerResponses(sid, 4, pid)).toEqual([
          a,
          { ...b, status: 'hidden' },
        ]);
        await store.setResponseStatus(sid, 4, b.responseId, 'visible');
        expect((await store.listPlayerResponses(sid, 4, pid))[1]?.status).toBe('visible');
      });

      it('splits the response id on the last dash when the player id contains dashes', async () => {
        const sid = uid('sess');
        const pid = 'ab-cd_ef-gh-1';
        const r = makeResponse(sid, 0, pid, { slot: 2, status: 'pending' });
        const sibling = makeResponse(sid, 0, pid, { slot: 0, status: 'pending' });
        expect(r.responseId).toBe('ab-cd_ef-gh-1-2');
        await store.putResponse(r, expires());
        await store.putResponse(sibling, expires());
        await store.setResponseStatus(sid, 0, r.responseId, 'hidden');
        expect(await store.listPlayerResponses(sid, 0, pid)).toEqual([
          sibling,
          { ...r, status: 'hidden' },
        ]);
      });

      it('throws when the response to moderate does not exist', async () => {
        const sid = uid('sess');
        const pid = uid('pl');
        await store.putResponse(makeResponse(sid, 0, pid), expires());
        for (const responseId of [`${pid}-1`, 'nodash', `${pid}-`, '-1', `${pid}-x`, `${pid}-00`]) {
          await expect(
            store.setResponseStatus(sid, 0, responseId, 'hidden'),
          ).rejects.toBeInstanceOf(NotFoundError);
        }
        await expect(store.setResponseStatus(sid, 1, `${pid}-0`, 'hidden')).rejects.toBeInstanceOf(
          NotFoundError,
        );
        expect(await store.listResponses(sid, 1)).toEqual([]);
        expect((await store.listResponses(sid, 0))[0]?.status).toBe('visible');
      });

      it('hides responses once they expire', async () => {
        const sid = uid('sess');
        const pid = uid('pl');
        const other = uid('pl');
        const expiresAt = clock.now() + HOUR_MS;
        await store.putResponse(makeResponse(sid, 0, pid), expiresAt);
        await store.putResponse(makeResponse(sid, 0, other), expiresAt + HOUR_MS);
        clock.set(expiresAt - 1000);
        expect(await store.listResponses(sid, 0)).toHaveLength(2);
        clock.set(expiresAt);
        expect(await store.listPlayerResponses(sid, 0, pid)).toEqual([]);
        expect((await store.listResponses(sid, 0)).map((r) => r.playerId)).toEqual([other]);
      });

      it('treats an expired response as absent: no moderation, and a new answer is stored', async () => {
        const sid = uid('sess');
        const pid = uid('pl');
        const expiresAt = clock.now() + HOUR_MS;
        const old = makeResponse(sid, 0, pid);
        await store.putResponse(old, expiresAt);
        clock.set(expiresAt);
        await expect(
          store.setResponseStatus(sid, 0, old.responseId, 'hidden'),
        ).rejects.toBeInstanceOf(NotFoundError);
        expect(await store.listResponses(sid, 0)).toEqual([]);

        const fresh = makeResponse(sid, 0, pid, {
          payload: { kind: 'choice', optionId: 'opt-rome' },
          receivedAt: clock.now(),
        });
        expect(await store.putResponse(fresh, expiresAt + HOUR_MS)).toEqual({ created: true });
        expect(await store.listPlayerResponses(sid, 0, pid)).toEqual([fresh]);
      });
    });

    describe('question results and scoreboard', () => {
      const expires = () => clock.now() + DAY_MS;

      it('stores, replaces and reads a question result', async () => {
        const sid = uid('sess');
        const [first] = allResults(sid);
        expect(first).toBeDefined();
        expect(await store.getQuestionResult(sid, 0)).toBeNull();
        await store.putQuestionResult(first!, expires());
        expect(await store.getQuestionResult(sid, 0)).toEqual(first);
        const replaced = { ...first!, computedAt: first!.computedAt + 5 };
        await store.putQuestionResult(replaced, expires());
        expect(await store.getQuestionResult(sid, 0)).toEqual(replaced);
      });

      it('lists results in question order, across digit boundaries and pages', async () => {
        const sid = uid('sess');
        const [template] = allResults(sid);
        const indexes = [10, 2, 9, 0, 11, 1, 5, 12, 8, 3, 7, 4, 6];
        for (const questionIndex of indexes) {
          await store.putQuestionResult({ ...template!, questionIndex }, expires());
        }
        await store.putQuestionResult(
          { ...template!, sessionId: uid('sess'), questionIndex: 0 },
          expires(),
        );
        const listed = await store.listQuestionResults(sid);
        expect(listed.map((r) => r.questionIndex)).toEqual([...indexes].sort((a, b) => a - b));
        expect(await store.listQuestionResults(uid('sess'))).toEqual([]);
      });

      it('hides results once they expire', async () => {
        const sid = uid('sess');
        const [template] = allResults(sid);
        const expiresAt = expires();
        await store.putQuestionResult(template!, expiresAt);
        clock.set(expiresAt);
        expect(await store.getQuestionResult(sid, 0)).toBeNull();
        expect(await store.listQuestionResults(sid)).toEqual([]);
      });

      it('creates a scoreboard once and replaces it by version', async () => {
        const sid = uid('sess');
        expect(await store.getScoreboard(sid)).toBeNull();
        const v0 = makeScoreboard(sid, 0);
        await store.putScoreboard(v0, undefined, expires());
        expect(await store.getScoreboard(sid)).toEqual(v0);
        await rejectsConflict(
          store.putScoreboard({ ...v0, appliedThrough: 9 }, undefined, expires()),
        );
        expect((await store.getScoreboard(sid))?.appliedThrough).toBe(v0.appliedThrough);
        const v1 = { ...makeScoreboard(sid, 1), appliedThrough: 3 };
        await store.putScoreboard(v1, 0, expires());
        expect(await store.getScoreboard(sid)).toEqual(v1);
        await rejectsConflict(store.putScoreboard({ ...v1, version: 2 }, 0, expires()));
        expect(await store.getScoreboard(sid)).toEqual(v1);
      });

      it('conflicts when replacing a scoreboard that does not exist', async () => {
        await rejectsConflict(store.putScoreboard(makeScoreboard(uid('sess'), 1), 0, expires()));
      });

      it('lets exactly one of two concurrent scoreboard writes win', async () => {
        const sid = uid('sess');
        await store.putScoreboard(makeScoreboard(sid, 0), undefined, expires());
        const results = await Promise.allSettled([
          store.putScoreboard({ ...makeScoreboard(sid, 1), appliedThrough: 5 }, 0, expires()),
          store.putScoreboard({ ...makeScoreboard(sid, 1), appliedThrough: 6 }, 0, expires()),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      });

      it('hides a scoreboard once it expires, so it can be created again', async () => {
        const sid = uid('sess');
        const expiresAt = expires();
        await store.putScoreboard(makeScoreboard(sid, 0), undefined, expiresAt);
        clock.set(expiresAt);
        expect(await store.getScoreboard(sid)).toBeNull();
        await rejectsConflict(store.putScoreboard(makeScoreboard(sid, 1), 0, expiresAt + HOUR_MS));
        expect(await store.getScoreboard(sid)).toBeNull();

        const again = makeScoreboard(sid, 0);
        await store.putScoreboard(again, undefined, expiresAt + HOUR_MS);
        expect(await store.getScoreboard(sid)).toEqual(again);
      });
    });

    describe('rate limiting', () => {
      const WINDOW = 10_000;

      it('allows up to the limit within one window', async () => {
        const key = uid('rl');
        const t = clock.now();
        const results = [];
        for (const offset of [0, 1, 500, 9_999, 3, 4]) {
          results.push(await store.hitRateLimit(key, 4, WINDOW, t + offset));
        }
        expect(results).toEqual([true, true, true, true, false, false]);
      });

      it('counts exactly under twenty concurrent hits', async () => {
        const key = uid('rl');
        const t = clock.now();
        const results = await Promise.all(
          Array.from({ length: 20 }, () => store.hitRateLimit(key, 7, WINDOW, t)),
        );
        expect(countOf(results, true)).toBe(7);
        expect(countOf(results, false)).toBe(13);
        expect(await store.hitRateLimit(key, 21, WINDOW, t)).toBe(true);
        expect(await store.hitRateLimit(key, 21, WINDOW, t)).toBe(false);
      });

      it('starts a new count in the next window', async () => {
        const key = uid('rl');
        const t = clock.now();
        expect(await store.hitRateLimit(key, 1, WINDOW, t + WINDOW - 1)).toBe(true);
        expect(await store.hitRateLimit(key, 1, WINDOW, t + WINDOW - 2)).toBe(false);
        expect(await store.hitRateLimit(key, 1, WINDOW, t + WINDOW)).toBe(true);
        expect(await store.hitRateLimit(key, 1, WINDOW, t + WINDOW + 1)).toBe(false);
      });

      it('counts each key separately', async () => {
        const [a, b] = [uid('rl'), uid('rl')];
        const t = clock.now();
        expect(await store.hitRateLimit(a, 1, WINDOW, t)).toBe(true);
        expect(await store.hitRateLimit(a, 1, WINDOW, t)).toBe(false);
        expect(await store.hitRateLimit(b, 1, WINDOW, t)).toBe(true);
      });

      it('counts again from zero after the window has long passed on the clock', async () => {
        const key = uid('rl');
        expect(await store.hitRateLimit(key, 1, WINDOW, clock.now())).toBe(true);
        expect(await store.hitRateLimit(key, 1, WINDOW, clock.now())).toBe(false);
        advance(5 * WINDOW);
        expect(await store.hitRateLimit(key, 1, WINDOW, clock.now())).toBe(true);
      });

      it('rejects a window that is not positive', async () => {
        await expect(store.hitRateLimit(uid('rl'), 1, 0, clock.now())).rejects.toBeInstanceOf(
          RangeError,
        );
      });
    });

    describe('isolation from callers', () => {
      it('does not let callers alias stored records', async () => {
        const sid = uid('sess');
        const meta = makeMeta({ sessionId: sid });
        const snapshot = makeSnapshot(meta.quizId);
        const player = makePlayer(sid);
        const response = makeResponse(sid, 0, player.playerId);
        const [result] = allResults(sid);
        const scoreboard = makeScoreboard(sid);
        const conn = makeConnection(sid);
        const quiz = makeQuiz(meta.hostId);
        const keep = structuredClone({
          meta,
          snapshot,
          player,
          response,
          result,
          scoreboard,
          conn,
          quiz,
        });

        await store.createSession(meta, snapshot);
        await store.addPlayer(player, clock.now() + DAY_MS);
        await store.putResponse(response, clock.now() + DAY_MS);
        await store.putQuestionResult(result!, clock.now() + DAY_MS);
        await store.putScoreboard(scoreboard, undefined, clock.now() + DAY_MS);
        await store.putConnection(conn);
        await store.putQuiz(quiz);

        // Mutate everything we handed in.
        meta.skipped.push(99);
        meta.settings.readSeconds = 0;
        snapshot.questions.pop();
        player.nickname = 'changed';
        response.payload = { kind: 'boolean', value: true };
        (result!.outcomes['player-one'] ?? { points: 0 }).points = -1;
        scoreboard.players['player-one']!.score = -1;
        conn.role = 'host';
        quiz.questions.length = 0;

        // Mutate everything we get back, then read again.
        const first = {
          meta: await store.getSession(sid),
          snapshot: await store.getSnapshot(sid),
          player: await store.getPlayer(sid, player.playerId),
          responses: await store.listResponses(sid, 0),
          result: await store.getQuestionResult(sid, 0),
          scoreboard: await store.getScoreboard(sid),
          conns: await store.listConnections(sid),
          quiz: await store.getQuiz(meta.hostId, quiz.id),
        };
        first.meta!.skipped.length = 0;
        first.snapshot!.questions.length = 0;
        first.player!.nickname = 'again';
        first.responses[0]!.payload = { kind: 'rating', value: 1 };
        first.scoreboard!.players = {};
        first.conns[0]!.connectionId = 'x';
        first.quiz!.title = 'x';

        expect(await store.getSession(sid)).toEqual(keep.meta);
        expect(await store.getSnapshot(sid)).toEqual(keep.snapshot);
        expect(await store.getPlayer(sid, player.playerId)).toEqual(keep.player);
        expect(await store.listResponses(sid, 0)).toEqual([keep.response]);
        expect(await store.getQuestionResult(sid, 0)).toEqual(keep.result);
        expect(await store.getScoreboard(sid)).toEqual(keep.scoreboard);
        expect(await store.listConnections(sid)).toEqual([keep.conn]);
        expect(await store.getQuiz(meta.hostId, quiz.id)).toEqual(keep.quiz);
      });
    });

    describe('record round-trip', () => {
      it('returns a quiz with every question type, optional fields present and absent', async () => {
        const quiz = makeQuiz(uid('owner'));
        expect(quiz.questions.map((q) => q.type).sort()).toEqual([
          'open',
          'poll',
          'rating',
          'rating',
          'single',
          'truefalse',
          'wordcloud',
        ]);
        await store.putQuiz(quiz);
        expect(await store.getQuiz(quiz.ownerId, quiz.id)).toEqual(quiz);
      });

      it('returns session meta in each phase shape', async () => {
        const shapes = [
          makeMeta(),
          makeMeta({
            phase: 'ended',
            questionIndex: 6,
            openAt: null,
            deadline: null,
            closedAt: CLOCK_START + 99,
            endedAt: CLOCK_START + 100,
            locked: false,
            skipped: [],
            hasScoredQuestions: false,
          }),
          makeMeta({ phase: 'lobby', questionIndex: -1, openAt: null, deadline: null }),
        ];
        for (const meta of shapes) {
          await store.createSession(meta, makeSnapshot(meta.quizId));
          expect(await store.getSession(meta.sessionId)).toEqual(meta);
        }
      });

      it('returns players', async () => {
        const sid = uid('sess');
        const players = [
          makePlayer(sid),
          makePlayer(sid, { kicked: true, nickname: 'Zoë 🎉', nicknameKey: uid('zoe') }),
        ];
        for (const p of players) await store.addPlayer(p, clock.now() + DAY_MS);
        for (const p of players) expect(await store.getPlayer(sid, p.playerId)).toEqual(p);
      });

      it('returns connections with player and host fields', async () => {
        const sid = uid('sess');
        const host = makeConnection(sid, { role: 'host', client: 'control' });
        delete host.playerId;
        const conns = [makeConnection(sid, { expiresAt: clock.now() + HOUR_MS + 7 }), host];
        for (const c of conns) await store.putConnection(c);
        for (const c of conns) expect(await store.getConnection(c.connectionId)).toEqual(c);
      });

      it('returns responses with every payload variant and optional field', async () => {
        const sid = uid('sess');
        const payloads: AnswerPayload[] = [
          { kind: 'choice', optionId: 'opt-paris' },
          { kind: 'boolean', value: false },
          { kind: 'text', text: 'héllo wörld 🎉' },
          { kind: 'rating', value: 7 },
        ];
        const variants = payloads.map((payload, i) =>
          makeResponse(sid, i, uid('pl'), {
            payload,
            elapsedMs: i % 2 === 0 ? null : 0,
            correct: [null, true, false, null][i] ?? null,
            points: i * 10,
            status: (['visible', 'pending', 'hidden', 'visible'] as const)[i] ?? 'visible',
            ...(i === 2 ? { normalizedText: 'héllo wörld 🎉' } : {}),
          }),
        );
        for (const r of variants) await store.putResponse(r, clock.now() + DAY_MS);
        for (const r of variants) {
          expect(await store.listPlayerResponses(sid, r.questionIndex, r.playerId)).toEqual([r]);
        }
      });

      it('returns a stored result for every result variant', async () => {
        const sid = uid('sess');
        const results = allResults(sid);
        expect(new Set(results.map((r) => r.result.type)).size).toBe(6);
        for (const r of results) await store.putQuestionResult(r, clock.now() + DAY_MS);
        expect(await store.listQuestionResults(sid)).toEqual(results);
        for (const r of results)
          expect(await store.getQuestionResult(sid, r.questionIndex)).toEqual(r);
      });

      it('returns a scoreboard, including null ranks', async () => {
        const sid = uid('sess');
        const board = makeScoreboard(sid, 4);
        await store.putScoreboard(board, undefined, clock.now() + DAY_MS);
        expect(await store.getScoreboard(sid)).toEqual(board);
        expect(Object.values(board.players).some((p) => p.lastRank === null)).toBe(true);
      });

      it('keeps settings and questions in a snapshot', async () => {
        const meta = makeMeta();
        const snapshot = {
          ...makeSnapshot(meta.quizId),
          settings: { ...settings, readSeconds: 0 },
        };
        expect(snapshot.questions).toEqual(allQuestions());
        await store.createSession(meta, snapshot);
        expect(await store.getSnapshot(meta.sessionId)).toEqual(snapshot);
      });
    });
  });
}
