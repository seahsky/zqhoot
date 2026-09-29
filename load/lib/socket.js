import { WebSocket } from 'k6/websockets';
import { cfg } from './config.js';

/**
 * Every real client sends an Origin and both targets refuse a WebSocket without the site's own
 * (ADR-0013), so the script sends one too.
 */
export const openSocket = (url) => new WebSocket(url, null, { headers: { Origin: cfg.origin } });

/**
 * When k6 read the frame off the wire (its receive loop stamps it), which is what "received"
 * means here. The JavaScript handler can run later on a busy machine; the read time cannot be
 * moved by that. Falls back to the handler's clock if the event carries no usable time.
 */
export function receiptTime(event) {
  const stamped = event === undefined ? undefined : event.timestamp;
  const now = Date.now();
  return typeof stamped === 'number' && Math.abs(stamped - now) < 60000 ? stamped : now;
}

export const parseMessage = (event) => {
  try {
    const message = JSON.parse(event.data);
    return message !== null && typeof message === 'object' ? message : null;
  } catch (err) {
    return null;
  }
};

/**
 * The client's clock offset (ADR-0005): the smallest `local receipt - ts` seen since connecting.
 * It converges on the true offset plus the fastest downlink delay, so a client never believes
 * the server clock is ahead of where it is.
 */
export class ClockOffset {
  constructor() {
    this.min = Infinity;
  }

  reset() {
    this.min = Infinity;
  }

  observe(receivedAt, serverTs) {
    if (typeof serverTs === 'number') this.min = Math.min(this.min, receivedAt - serverTs);
  }

  get() {
    return Number.isFinite(this.min) ? this.min : 0;
  }
}

export const isOpen = (ws) => ws !== null && ws.readyState === 1;

/**
 * Closes an open socket. A socket still connecting is left alone: k6's close() on one blocks the
 * VU until the connection is up, so callers close it from its `open` handler instead.
 */
export function closeSocket(ws, reason) {
  if (!isOpen(ws)) return;
  try {
    ws.close(1000, reason);
  } catch (err) {
    // Already closing.
  }
}
