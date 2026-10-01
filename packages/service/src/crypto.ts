const encoder = new TextEncoder();

/** Lower-case hex SHA-256 of the UTF-8 bytes, through WebCrypto so it runs on Node and Lambda alike. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(text));
  let out = '';
  for (const byte of new Uint8Array(digest)) out += byte.toString(16).padStart(2, '0');
  return out;
}

/**
 * Compares two hex digests without stopping at the first difference. Only the length can leak,
 * and both sides are fixed-length digests.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const UTF8_MAX_BYTES_PER_UNIT = 3;

/** True when the UTF-8 encoding of `text` is longer than `maxBytes`, without encoding what is obviously fine. */
export function exceedsUtf8Bytes(text: string, maxBytes: number): boolean {
  // Every UTF-16 code unit takes at least one byte and at most three, so only the middle needs a real count.
  if (text.length > maxBytes) return true;
  if (text.length * UTF8_MAX_BYTES_PER_UNIT <= maxBytes) return false;
  return encoder.encode(text).byteLength > maxBytes;
}
