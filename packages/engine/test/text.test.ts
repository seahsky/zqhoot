import { describe, expect, it } from 'vitest';
import { LIMITS } from '@zqhoot/protocol';
import { containsProfanity, normalizeOpenText, normalizeWord } from '../src/index.ts';
import { sanitize } from '../src/text.ts';

const cp = (...codes: number[]) => String.fromCodePoint(...codes);
const ZWSP = cp(0x200b);
const RLO = cp(0x202e);
const BRAILLE_BLANK = cp(0x2800);

describe('normalizeWord', () => {
  it.each([
    ['  Hello!! ', 'hello'],
    ['HELLO', 'hello'],
    ['Café', 'café'.normalize('NFKC')],
    ['ＨＥＬＬＯ', 'hello'],
    ['New   York', 'new york'],
    [`he${ZWSP}llo`, 'hello'],
    ["it's", "it's"],
    ['(hi)', 'hi'],
    ['...wow...', 'wow'],
    ['¿qué?', 'qué'],
    ['-- dash --', 'dash'],
    ['\u{1F389}', '\u{1F389}'],
    ['\u{1F389}!', '\u{1F389}'],
    [`cat${BRAILLE_BLANK}`, 'cat'],
    [`ice${BRAILLE_BLANK}${BRAILLE_BLANK}cream`, 'ice cream'],
  ])('%j -> %j', (raw, expected) => {
    expect(normalizeWord(raw)).toBe(expected);
  });

  it.each([
    [''],
    ['   '],
    ['...'],
    ['!?'],
    ['a\tb'],
    ['a\nb'],
    [`ab${RLO}`],
    [`ab${cp(0x07)}`],
    [cp(0xe000)],
    [BRAILLE_BLANK.repeat(3)],
  ])('rejects %j', (raw) => {
    expect(normalizeWord(raw)).toBeNull();
  });

  it('enforces the length limit in code points, after normalisation', () => {
    expect(normalizeWord('a'.repeat(LIMITS.wordMaxLength))).toBe('a'.repeat(LIMITS.wordMaxLength));
    expect(normalizeWord('a'.repeat(LIMITS.wordMaxLength + 1))).toBeNull();
    expect(normalizeWord('\u{1F600}'.repeat(LIMITS.wordMaxLength))).not.toBeNull();
    expect(normalizeWord('\u{1F600}'.repeat(LIMITS.wordMaxLength + 1))).toBeNull();
    expect(normalizeWord(`${'a'.repeat(LIMITS.wordMaxLength)}!!!`)).not.toBeNull();
  });

  it('is idempotent', () => {
    for (const raw of ['  Hello!! ', 'New   York', "it's", 'A.B.C.']) {
      const once = normalizeWord(raw) as string;
      expect(normalizeWord(once)).toBe(once);
    }
  });
});

describe('normalizeOpenText', () => {
  it.each([
    ['  hello   world  ', 'hello world'],
    ['a\r\nb', 'a\nb'],
    ['a\rb', 'a\nb'],
    ['a\n\n\nb', 'a\nb'],
    ['a \n b', 'a\nb'],
    ['\n\na\n\n', 'a'],
    ['a\tb', 'a b'],
    ['a b', 'a\nb'],
    ['a b', 'a\nb'],
    ['a\u0085b', 'a\nb'],
    [`a${ZWSP}b`, 'ab'],
    [`a${RLO}b`, 'ab'],
    ['Keep Case!', 'Keep Case!'],
    ['ＡＢ', 'AB'],
    [`a${BRAILLE_BLANK}${BRAILLE_BLANK}b${BRAILLE_BLANK}`, 'a b'],
  ])('%j -> %j', (raw, expected) => {
    expect(normalizeOpenText(raw)).toBe(expected);
  });

  it('keeps at most three line breaks and turns the rest into spaces', () => {
    expect(normalizeOpenText('a\nb\nc\nd')).toBe('a\nb\nc\nd');
    expect(normalizeOpenText('a\nb\nc\nd\ne\nf')).toBe('a\nb\nc\nd e f');
  });

  it.each([
    [''],
    ['   '],
    ['\n\n'],
    [`${ZWSP}`],
    [BRAILLE_BLANK],
    [`ab${cp(0x07)}`],
    [`ab${cp(0x00)}`],
    [cp(0xe000)],
    ['\ud800'],
  ])('rejects %j', (raw) => {
    expect(normalizeOpenText(raw)).toBeNull();
  });

  it('enforces the length limit in code points', () => {
    expect(normalizeOpenText('a'.repeat(LIMITS.openTextMax))).not.toBeNull();
    expect(normalizeOpenText('a'.repeat(LIMITS.openTextMax + 1))).toBeNull();
    expect(normalizeOpenText('\u{1F600}'.repeat(LIMITS.openTextMax))).not.toBeNull();
    expect(normalizeOpenText('\u{1F600}'.repeat(LIMITS.openTextMax + 1))).toBeNull();
  });

  it('is idempotent', () => {
    for (const raw of ['  a  b \n\n c ', 'x\ty', 'a\nb\nc\nd\ne']) {
      const once = normalizeOpenText(raw) as string;
      expect(normalizeOpenText(once)).toBe(once);
    }
  });
});

describe('sanitize', () => {
  it('turns the braille blank into the space it looks like', () => {
    expect(sanitize(`a${BRAILLE_BLANK}b`, { bidi: 'reject' })).toBe('a b');
    expect(sanitize(BRAILLE_BLANK, { bidi: 'strip', multiline: true })).toBe(' ');
  });

  it('rejects or drops bidi controls depending on the mode', () => {
    expect(sanitize(`a${RLO}b`, { bidi: 'reject' })).toBeNull();
    expect(sanitize(`a${RLO}b`, { bidi: 'strip' })).toBe('ab');
  });

  it('only allows newline and tab in multiline mode', () => {
    expect(sanitize('a\nb\tc', { bidi: 'reject' })).toBeNull();
    expect(sanitize('a\nb\tc', { bidi: 'reject', multiline: true })).toBe('a\nb c');
    expect(sanitize('a\u0007b', { bidi: 'reject', multiline: true })).toBeNull();
  });
});

describe('containsProfanity', () => {
  it.each([
    ['fuck', true],
    ['What the fuck', true],
    ['sh1t', true],
    ['FuCk', true],
    ['hello', false],
    ['', false],
    ['Scunthorpe', false],
    ['the pen is mightier', false],
  ])('%j -> %s', (text, expected) => {
    expect(containsProfanity(text)).toBe(expected);
  });
});
