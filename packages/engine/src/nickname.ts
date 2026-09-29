import { LIMITS } from '@zqhoot/protocol';
import { containsProfanity, sanitize } from './text.ts';

export type NicknameResult =
  | { ok: true; nickname: string; key: string }
  | { ok: false; reason: 'too-short' | 'too-long' | 'invalid-characters' | 'inappropriate' };

const MAX_MARKS_PER_BASE = 3;
/** VS16 and the keycap enclosing mark are part of ordinary emoji, not decoration. */
const NOT_DECORATION = new Set(['\uFE0F', '\u20E3']);

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

/**
 * Latin letters and the non-Latin letters that render (almost) identically to them. Uppercase
 * forms are listed too because they are mapped before lower-casing: capital Greek Nu looks like
 * N while lowercase nu looks like v. Sources: the Cyrillic and Greek (plus a few Armenian and
 * Latin) rows of Unicode confusables.txt, restricted to pairs that are indistinguishable in
 * common sans-serif fonts. Written as escapes so no homoglyph hides in the source itself.
 */
const LOOKALIKES: Record<string, string> = {
  a: '\u0430\u0410\u0391\u03B1',
  b: '\u0412\u0392',
  c: '\u0441\u0421\u03F9\u03F2',
  d: '\u0501',
  e: '\u0435\u0415\u0395\u03B5',
  h: '\u04BB\u041D\u0397',
  i: '\u0456\u0406\u0399\u03B9\u0131',
  j: '\u0458\u0408',
  k: '\u043A\u041A\u039A\u03BA',
  l: '\u04CF\u04C0\u01C0',
  m: '\u041C\u039C\u043C',
  n: '\u039D',
  o: '\u043E\u041E\u039F\u03BF\u0555',
  p: '\u0440\u0420\u03A1\u03C1',
  q: '\u051B\u051A',
  s: '\u0455\u0405',
  t: '\u0442\u0422\u03A4\u03C4',
  u: '\u03C5',
  v: '\u03BD\u0475\u0474',
  w: '\u051D\u051C\u0461',
  x: '\u0445\u0425\u03A7\u03C7',
  y: '\u0443\u0423\u03A5',
  z: '\u0396',
};

export const CONFUSABLES: ReadonlyMap<string, string> = new Map(
  Object.entries(LOOKALIKES).flatMap(([latin, chars]) =>
    Array.from(chars, (ch): [string, string] => [ch, latin]),
  ),
);

/** Digits and symbols people substitute for letters. Applied after lower-casing. */
export const LEET: ReadonlyMap<string, string> = new Map([
  ['0', 'o'],
  ['1', 'l'],
  ['3', 'e'],
  ['4', 'a'],
  ['5', 's'],
  ['7', 't'],
  ['@', 'a'],
  ['$', 's'],
]);

/** Diacritic blocks; Latin/Greek/Cyrillic accents are cheap to add and hard to see. */
const COMBINING_DIACRITICS = /[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\uFE20-\uFE2F]/gu;
const DROPPED_IN_KEY = /[\p{P}\p{Z}\p{Cf}\p{Default_Ignorable_Code_Point}+<=>^`|~]/gu;

/**
 * Uniqueness skeleton: two nicknames a player could mistake for each other share a key.
 * Steps: accents removed, confusables mapped to Latin, lower-case, leetspeak folded, then
 * spaces, punctuation and invisible characters dropped. Emoji are kept.
 */
export function nicknameKey(nickname: string): string {
  let key = '';
  for (const ch of nickname.normalize('NFD').replace(COMBINING_DIACRITICS, '')) {
    key += CONFUSABLES.get(ch) ?? ch.toLowerCase();
  }
  let leet = '';
  for (const ch of key) leet += LEET.get(ch) ?? ch;
  return leet.replace(DROPPED_IN_KEY, '');
}

/**
 * Anti-Zalgo: more than two combining marks in a row on one base. The run is counted instead of
 * the marks per grapheme cluster because segmentation rule GB9c makes an Indic conjunct such as
 * the क्ष्मी in Lakshmi a single cluster, although it holds only one mark after each base.
 * Stacked diacritics are still caught: they are consecutive marks on one base.
 */
function hasZalgo(name: string): boolean {
  let run = 0;
  // Decomposed, so a precomposed base (a + acute = U+00E1) cannot hide one of the marks.
  for (const ch of name.normalize('NFD')) {
    // Spacing marks (Mc) take their own width and cannot stack, so only Mn/Me count; this keeps
    // Bengali split vowels (ো = U+09C7 U+09BE) and Hindi nukta + vowel + anusvara valid.
    if (!/\p{M}/u.test(ch)) run = 0;
    else if (/[\p{Mn}\p{Me}]/u.test(ch) && !NOT_DECORATION.has(ch) && ++run > MAX_MARKS_PER_BASE)
      return true;
  }
  return false;
}

const graphemeCount = (name: string) => Array.from(segmenter.segment(name)).length;

export function normalizeNickname(raw: string): NicknameResult {
  if (raw.length > LIMITS.nicknameRawMaxLength) return { ok: false, reason: 'too-long' };
  const clean = sanitize(raw, { bidi: 'reject' });
  if (clean === null) return { ok: false, reason: 'invalid-characters' };
  const nickname = clean.replace(/\p{Zs}+/gu, ' ').trim();
  if (hasZalgo(nickname)) return { ok: false, reason: 'invalid-characters' };
  const length = graphemeCount(nickname);
  if (length < LIMITS.nicknameMinGraphemes) return { ok: false, reason: 'too-short' };
  if (length > LIMITS.nicknameMaxGraphemes) return { ok: false, reason: 'too-long' };
  const key = nicknameKey(nickname);
  if (key === '') return { ok: false, reason: 'invalid-characters' };
  if (containsProfanity(nickname) || containsProfanity(key)) {
    return { ok: false, reason: 'inappropriate' };
  }
  return { ok: true, nickname, key };
}
