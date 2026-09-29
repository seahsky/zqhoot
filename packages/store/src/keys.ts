/** Key layout of the single table (ADR-0003). Only the DynamoDB implementation uses these. */

export const RESPONSE_SHARDS = 4;

/** FNV-1a 32-bit over UTF-16 code units (not UTF-8 bytes), so it needs no encoder. */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Spreads one question's responses over `RESPONSE_SHARDS` partition keys. */
export function responseShard(playerId: string): number {
  return fnv1a32(playerId) % RESPONSE_SHARDS;
}

export interface ItemKey {
  pk: string;
  sk: string;
}

export const GSI1 = 'gsi1';

export const pad = (n: number, width: number): string => String(n).padStart(width, '0');

export const hostPk = (hostId: string): string => `HOST#${hostId}`;

export const quizKey = (ownerId: string, quizId: string): ItemKey => ({
  pk: hostPk(ownerId),
  sk: `QUIZ#${quizId}`,
});
export const QUIZ_SK_PREFIX = 'QUIZ#';

export const sessionPk = (sessionId: string): string => `SESS#${sessionId}`;
export const metaKey = (sessionId: string): ItemKey => ({ pk: sessionPk(sessionId), sk: 'META' });
export const snapshotKey = (sessionId: string): ItemKey => ({
  pk: sessionPk(sessionId),
  sk: 'SNAP',
});
export const scoresKey = (sessionId: string): ItemKey => ({
  pk: sessionPk(sessionId),
  sk: 'SCORES',
});

export const pinKey = (pin: string): ItemKey => ({ pk: `PIN#${pin}`, sk: 'PIN' });

export const playerKey = (sessionId: string, playerId: string): ItemKey => ({
  pk: sessionPk(sessionId),
  sk: `PLAYER#${playerId}`,
});
export const PLAYER_SK_PREFIX = 'PLAYER#';
export const nickKey = (sessionId: string, nicknameKey: string): ItemKey => ({
  pk: sessionPk(sessionId),
  sk: `NICK#${nicknameKey}`,
});

export const connByIdKey = (connectionId: string): ItemKey => ({
  pk: `CONN#${connectionId}`,
  sk: 'CONN',
});
export const connBySessionKey = (sessionId: string, connectionId: string): ItemKey => ({
  pk: sessionPk(sessionId),
  sk: `CONN#${connectionId}`,
});
export const CONN_SK_PREFIX = 'CONN#';

export const responsePk = (sessionId: string, questionIndex: number, shard: number): string =>
  `RESP#${sessionId}#${questionIndex}#${shard}`;
export const responseSk = (playerId: string, slot: number): string =>
  `P#${playerId}#${pad(slot, 2)}`;
/** The trailing `#` keeps player `ab` from matching the responses of player `ab-1`. */
export const responsePlayerPrefix = (playerId: string): string => `P#${playerId}#`;
export const responseKey = (
  sessionId: string,
  questionIndex: number,
  playerId: string,
  slot: number,
): ItemKey => ({
  pk: responsePk(sessionId, questionIndex, responseShard(playerId)),
  sk: responseSk(playerId, slot),
});

export const resultKey = (sessionId: string, questionIndex: number): ItemKey => ({
  pk: sessionPk(sessionId),
  sk: `RESULT#${pad(questionIndex, 3)}`,
});
export const RESULT_SK_PREFIX = 'RESULT#';

export const rateLimitKey = (key: string, windowStart: number): ItemKey => ({
  pk: `RL#${key}`,
  sk: `W#${windowStart}`,
});

/** `gsi1sk` orders a host's sessions by creation time; 13 digits cover epoch ms until 2286. */
export const sessionGsiSk = (createdAt: number, sessionId: string): string =>
  `SESS#${pad(createdAt, 13)}#${sessionId}`;

/**
 * Splits `{playerId}-{slot}` on the last `-`: nanoid player IDs may themselves contain `-`.
 * Returns null when the ID cannot name a response.
 */
export function parseResponseId(responseId: string): { playerId: string; slot: number } | null {
  const cut = responseId.lastIndexOf('-');
  if (cut <= 0) return null;
  const slotText = responseId.slice(cut + 1);
  if (!/^(0|[1-9][0-9]{0,5})$/.test(slotText)) return null;
  return { playerId: responseId.slice(0, cut), slot: Number(slotText) };
}
