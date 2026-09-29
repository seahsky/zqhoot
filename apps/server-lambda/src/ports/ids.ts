import { randomBytes, randomInt } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { Ids } from '@zqhoot/service';

/** nanoid's alphabet is the protocol's `Id` alphabet; 21 characters sit inside its 6-32 range. */
export function createIds(): Ids {
  return {
    sessionId: () => nanoid(),
    playerId: () => nanoid(),
    quizId: () => nanoid(),
    mediaId: () => nanoid(),
    token: () => randomBytes(32).toString('base64url'),
    pin: () => String(randomInt(100_000, 1_000_000)),
  };
}
