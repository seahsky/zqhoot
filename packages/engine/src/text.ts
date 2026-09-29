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

const MAX_MARKS_PER_BASE = 3;
/** VS16 and the keycap enclosing mark are part of ordinary emoji, not decoration. */
const NOT_DECORATION = new Set(['\uFE0F', '\u20E3']);

/**
 * Anti-Zalgo: more than three non-spacing marks in a row on one base. The run is counted instead
 * of the marks per grapheme cluster because segmentation rule GB9c makes an Indic conjunct such as
 * the क्ष्मी in Lakshmi a single cluster, although it holds only one mark after each base.
 * Stacked diacritics are still caught: they are consecutive marks on one base.
 */
export function hasStackedMarks(text: string): boolean {
  let run = 0;
  // Decomposed, so a precomposed base (a + acute = U+00E1) cannot hide one of the marks.
  for (const ch of text.normalize('NFD')) {
    // Spacing marks (Mc) take their own width and cannot stack, so only Mn/Me count; this keeps
    // Bengali split vowels (ো = U+09C7 U+09BE) and Hindi nukta + vowel + anusvara valid.
    if (!/\p{M}/u.test(ch)) run = 0;
    else if (/[\p{Mn}\p{Me}]/u.test(ch) && !NOT_DECORATION.has(ch) && ++run > MAX_MARKS_PER_BASE)
      return true;
  }
  return false;
}

const collapseSpaces = (s: string) => s.replace(/\p{Zs}+/gu, ' ').trim();
const codePointLength = (s: string) => Array.from(s).length;

/** Word-cloud entry: lower-cased, no surrounding punctuation. Null if unusable. */
export function normalizeWord(raw: string): string | null {
  const clean = sanitize(raw, { bidi: 'reject' });
  if (clean === null || hasStackedMarks(clean)) return null;
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
  if (clean === null || hasStackedMarks(clean)) return null;
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
