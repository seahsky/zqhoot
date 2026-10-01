import type { MemoryStore } from '../src/index.ts';
import {
  allResults,
  makeConnection,
  makeMeta,
  makePlayer,
  makeQuiz,
  makeResponse,
  makeScoreboard,
  makeSnapshot,
  uid,
} from './fixtures.ts';

/** Writes one of every session-scoped record. */
export async function populateSession(
  store: MemoryStore,
  opts: { now: number; sessionExpiresAt: number; dependentsExpireAt: number; hostId?: string },
) {
  const meta = makeMeta({
    ...(opts.hostId !== undefined && { hostId: opts.hostId }),
    createdAt: opts.now,
    expiresAt: opts.sessionExpiresAt,
  });
  const sid = meta.sessionId;
  const player = makePlayer(sid);
  const conn = makeConnection(sid, {
    playerId: player.playerId,
    expiresAt: opts.dependentsExpireAt,
  });
  await store.reservePin(meta.pin, sid, opts.sessionExpiresAt);
  await store.createSession(meta, makeSnapshot(meta.quizId));
  await store.addPlayer(player, opts.dependentsExpireAt);
  await store.putConnection(conn);
  await store.putResponse(makeResponse(sid, 0, player.playerId), opts.dependentsExpireAt);
  await store.putResponse(
    makeResponse(sid, 0, player.playerId, { slot: 1 }),
    opts.dependentsExpireAt,
  );
  for (const r of allResults(sid)) await store.putQuestionResult(r, opts.dependentsExpireAt);
  await store.putScoreboard(makeScoreboard(sid), undefined, opts.dependentsExpireAt);
  return { meta, player, conn, sessionId: sid };
}

/** A store holding every kind of record, for serialisation tests. */
export async function populateAll(store: MemoryStore, now: number) {
  const day = 86_400_000;
  const session = await populateSession(store, {
    now,
    sessionExpiresAt: now + 30 * day,
    dependentsExpireAt: now + day,
  });
  await store.putQuiz(makeQuiz(session.meta.hostId));
  await store.hitRateLimit(uid('rl'), 5, 10_000, now);
  return session;
}
