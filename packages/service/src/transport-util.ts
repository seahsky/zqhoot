import type { OutboundMessage } from '@zqhoot/protocol';

/**
 * Serialises `message` once and returns a function that splices `ts` in front of the keys, so a
 * broadcast pays for one `JSON.stringify` but every recipient still gets its own timestamp.
 * The result of `prepareStamped(m)(ts)` equals `stampAndSerialize(m, ts)`.
 */
export function prepareStamped(message: OutboundMessage): (ts: number) => string {
  const body = JSON.stringify(message);
  // Every server message has a `type`, so `{}` cannot occur; the branch keeps the output valid anyway.
  const rest = body === '{}' ? '}' : `,${body.slice(1)}`;
  return (ts) => {
    // `NaN` or `Infinity` would put invalid JSON on the wire.
    if (!Number.isFinite(ts)) throw new RangeError(`cannot stamp a message with ts ${ts}`);
    return `{"ts":${ts}${rest}`;
  };
}

/** The one place that decides where `ts` goes on the wire; both adapters call it. */
export function stampAndSerialize(message: OutboundMessage, ts: number): string {
  return prepareStamped(message)(ts);
}
