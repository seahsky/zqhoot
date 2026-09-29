/**
 * The failed-PIN budget (ADR-0013). `GET /api/join/:pin` and the WebSocket `join` draw on the same
 * counter, so guessing over either path spends the same 30 misses a minute and a block set by one
 * is seen by the other.
 */
export const PIN_LOOKUP_LIMIT = 30;
export const PIN_LOOKUP_WINDOW_MS = 60_000;

/** What an adapter that cannot tell the client's address is keyed as. */
export const UNKNOWN_IP = 'unknown';

export const pinLookupCounter = (ip: string): string => `pin:${ip}`;
