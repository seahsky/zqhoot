import { englishDataset, englishRecommendedTransformers, RegExpMatcher } from 'obscenity';
import { LIMITS } from '@zqhoot/protocol';

const BIDI_CONTROL = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
/** Characters that make a string unusable rather than merely invisible. */
const FORBIDDEN = /[\p{Cc}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u;
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/u;
/** Renders as blank space but is a symbol, so it survives category checks and would forge a name. */
const BRAILLE_BLANK = '\u2800';
const ZWJ = '\u200D';
const VS16 = '\uFE0F';
const EMOJI_LEFT_OF_ZWJ = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F]/u;

export interface SanitizeOptions {
  /** Bidi controls can reorder text on the projector: nicknames and words reject them, free text drops them. */
  bidi: 'reject' | 'strip';
  /** Free text keeps `\n` and turns `\t` into a space; everything else in `\p{Cc}` is still rejected. */
  multiline?: boolean;
}

/**
 * NFKC, then remove invisible format characters and reject characters that cannot be shown
 * safely. ZWJ and VS16 survive only inside emoji sequences so family/flag/heart emoji stay
 * one grapheme; anywhere else they are just another way to forge an invisible difference.
 * The braille blank becomes a space, which is what it looks like, so callers collapse and trim it.
 * Returns null when the input must be rejected.
 */
export function sanitize(raw: string, opts: SanitizeOptions): string | null {
  const chars = Array.from(raw.normalize('NFKC'));
  const out: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as string;
    if (BIDI_CONTROL.test(ch)) {
      if (opts.bidi === 'reject') return null;
      continue;
    }
    if (opts.multiline) {
      if (ch === '\n') {
        out.push(ch);
        continue;
      }
      if (ch === '\t') {
        out.push(' ');
        continue;
      }
    }
    if (FORBIDDEN.test(ch)) return null;
    if (ch === BRAILLE_BLANK) {
      out.push(' ');
      continue;
    }
    if (ch === ZWJ) {
      const prev = out[out.length - 1];
      const next = chars[i + 1];
      if (
        prev !== undefined &&
        next !== undefined &&
        EMOJI_LEFT_OF_ZWJ.test(prev) &&
        /\p{Extended_Pictographic}/u.test(next)
      ) {
        out.push(ch);
      }
      continue;
    }
    if (ch === VS16) {
      const prev = out[out.length - 1];
      if (prev !== undefined && /\p{Emoji}/u.test(prev)) out.push(ch);
      continue;
    }
    if (INVISIBLE.test(ch)) continue;
    out.push(ch);
  }
  return out.join('');
}

const collapseSpaces = (s: string) => s.replace(/\p{Zs}+/gu, ' ').trim();
const codePointLength = (s: string) => Array.from(s).length;

/** Word-cloud entry: lower-cased, no surrounding punctuation. Null if unusable. */
export function normalizeWord(raw: string): string | null {
  const clean = sanitize(raw, { bidi: 'reject' });
  if (clean === null) return null;
  const word = collapseSpaces(clean)
    .toLowerCase()
    .replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, '');
  if (word === '' || codePointLength(word) > LIMITS.wordMaxLength) return null;
  return word;
}

const MAX_OPEN_TEXT_NEWLINES = 3;

/** Open-ended entry: whitespace collapsed, a few single newlines kept. Null if unusable. */
export function normalizeOpenText(raw: string): string | null {
  const unified = raw.replace(/\r\n?|\u0085|\u2028|\u2029/g, '\n');
  const clean = sanitize(unified, { bidi: 'strip', multiline: true });
  if (clean === null) return null;
  const lines = clean
    .split('\n')
    .map(collapseSpaces)
    .filter((line) => line !== '');
  let text = '';
  let newlines = 0;
  lines.forEach((line, i) => {
    if (i > 0) {
      // Past the cap a line break becomes a space rather than rejecting the whole entry.
      if (newlines < MAX_OPEN_TEXT_NEWLINES) {
        text += '\n';
        newlines++;
      } else {
        text += ' ';
      }
    }
    text += line;
  });
  if (text === '' || codePointLength(text) > LIMITS.openTextMax) return null;
  return text;
}

let matcher: RegExpMatcher | undefined;

/** English profanity heuristic (obscenity dataset + recommended transformers). Not a guarantee. */
export function containsProfanity(text: string): boolean {
  matcher ??= new RegExpMatcher({
    ...englishDataset.build(),
    ...englishRecommendedTransformers,
  });
  return matcher.hasMatch(text);
}
