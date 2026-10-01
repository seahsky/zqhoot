import { createSession } from '@zqhoot/engine';
import type { SessionMeta } from '@zqhoot/engine';
import type { QuizInput } from '@zqhoot/protocol';
import type { Harness } from './harness.ts';
import { miniQuiz } from './fixtures.ts';

/**
 * Writes a session straight into the store, for states the HTTP flow cannot produce (a tiny
 * `maxPlayers`, an ended session that still holds its PIN).
 */
export async function seedSession(
  h: Harness,
  opts: {
    maxPlayers?: number;
    patch?: Partial<SessionMeta>;
    hostId?: string;
    quiz?: QuizInput;
  } = {},
): Promise<{ sessionId: string; pin: string; meta: SessionMeta }> {
  const now = h.clock.now();
  const sessionId = h.ids.sessionId();
  const pin = h.ids.pin();
  const input = opts.quiz ?? miniQuiz();
  const { meta, snapshot } = createSession({
    sessionId,
    pin,
    hostId: opts.hostId ?? h.hostIds.a,
    quiz: {
      ...input,
      id: h.ids.quizId(),
      ownerId: opts.hostId ?? h.hostIds.a,
      version: 1,
      createdAt: now,
      updatedAt: now,
    },
    now,
    cfg: h.engine,
    ...(opts.maxPlayers !== undefined ? { maxPlayers: opts.maxPlayers } : {}),
  });
  const seeded = { ...meta, ...opts.patch };
  expectReserved(await h.store.reservePin(pin, sessionId, seeded.expiresAt));
  await h.store.createSession(seeded, snapshot);
  return { sessionId, pin, meta: seeded };
}

function expectReserved(reserved: boolean): void {
  if (!reserved) throw new Error('the harness generated a PIN that is already taken');
}
