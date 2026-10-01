import { randomBytes, randomInt } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { Ids } from '@zqhoot/service';

/** nanoid's alphabet (`A-Za-z0-9_-`) and 21 characters satisfy the protocol's `Id` pattern. */
export function createIds(): Ids {
  return {
    sessionId: () => nanoid(),
    playerId: () => nanoid(),
    quizId: () => nanoid(),
    mediaId: () => nanoid(),
    token: () => randomBytes(32).toString('base64url'),
    // The upper bound of `randomInt` is exclusive.
    pin: () => String(randomInt(100_000, 1_000_000)),
  };
}
