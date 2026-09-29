import { LIMITS } from '@zqhoot/protocol';
import { graphemeCount } from '../../state/format.ts';

/** Same shape the server checks after normalising: whitespace collapsed, then counted in graphemes. */
export function collapseWhitespace(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * A quick local check so an obviously wrong name never costs a round trip. The server stays
 * the authority: it also strips invisible characters and applies the word filter.
 */
export function validateNickname(raw: string): string | null {
  const n = graphemeCount(collapseWhitespace(raw));
  if (n === 0) return 'Enter a nickname to join.';
  if (n < LIMITS.nicknameMinGraphemes) {
    return `Nicknames need at least ${LIMITS.nicknameMinGraphemes} characters.`;
  }
  if (n > LIMITS.nicknameMaxGraphemes) {
    return `Nicknames can be up to ${LIMITS.nicknameMaxGraphemes} characters.`;
  }
  return null;
}

export function nicknameCounter(raw: string): string {
  const n = graphemeCount(collapseWhitespace(raw));
  const over = n > LIMITS.nicknameMaxGraphemes;
  return `${n} / ${LIMITS.nicknameMaxGraphemes}${over ? ' (too long)' : ''}`;
}

export function digitsOnly(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, LIMITS.pinLength);
}
