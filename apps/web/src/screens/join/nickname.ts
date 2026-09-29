import { LIMITS } from '@zqhoot/protocol';
import { graphemeCount } from '../../state/format.ts';

/** Same shape the server checks after normalising: whitespace collapsed, then counted in graphemes. */
export function collapseWhitespace(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** Why the server refused a nickname: the `message` of a `nickname-invalid` error. */
export type NicknameReason = 'too-short' | 'too-long' | 'invalid-characters' | 'inappropriate';

/** Our own sentence per reason. The local checks use the same two for length. */
export const NICKNAME_REASON_COPY: Record<NicknameReason, string> = {
  'too-short': `Nicknames need at least ${LIMITS.nicknameMinGraphemes} characters.`,
  'too-long': `That nickname is too long. Use up to ${LIMITS.nicknameMaxGraphemes} characters; emoji and symbols count for more.`,
  'invalid-characters':
    "Some characters in that nickname aren't allowed. Try letters, numbers or an emoji.",
  inappropriate: "That nickname has a word that isn't allowed. Try a different one.",
};

export function nicknameReasonCopy(reason: string): string | null {
  return Object.hasOwn(NICKNAME_REASON_COPY, reason)
    ? NICKNAME_REASON_COPY[reason as NicknameReason]
    : null;
}

const encoder = typeof TextEncoder === 'undefined' ? null : new TextEncoder();

/**
 * UTF-8 size, which the server caps as well (`LIMITS.nicknameMaxBytes`): a nickname of emoji
 * or another script can be within 16 graphemes and still too big for the roster. Without
 * `TextEncoder` the check is skipped and the server decides.
 */
export function utf8Bytes(text: string): number {
  return encoder ? encoder.encode(text).length : 0;
}

/**
 * A quick local check so an obviously wrong name never costs a round trip. The server stays
 * the authority: it also strips invisible characters and applies the word filter.
 */
export function validateNickname(raw: string): string | null {
  const collapsed = collapseWhitespace(raw);
  const n = graphemeCount(collapsed);
  if (n === 0) return 'Enter a nickname to join.';
  if (n < LIMITS.nicknameMinGraphemes) return NICKNAME_REASON_COPY['too-short'];
  if (n > LIMITS.nicknameMaxGraphemes || utf8Bytes(collapsed) > LIMITS.nicknameMaxBytes) {
    return NICKNAME_REASON_COPY['too-long'];
  }
  return null;
}

/** The count stays in graphemes, what a person sees; the warning also fires for the byte cap. */
export function nicknameCounter(raw: string): string {
  const collapsed = collapseWhitespace(raw);
  const n = graphemeCount(collapsed);
  const count = `${n} / ${LIMITS.nicknameMaxGraphemes}`;
  if (n > LIMITS.nicknameMaxGraphemes) return `${count} (too long)`;
  if (utf8Bytes(collapsed) > LIMITS.nicknameMaxBytes)
    return `${count} (too long: emoji count for more)`;
  return count;
}

export function digitsOnly(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, LIMITS.pinLength);
}
