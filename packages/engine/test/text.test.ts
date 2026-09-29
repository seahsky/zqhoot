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

describe('anti-Zalgo in word-cloud and open-ended entries', () => {
  const ACUTE = cp(0x0301);
  const CIRCUMFLEX = cp(0x0302);
  const NUKTA = cp(0x093c);
  const both = [
    ['normalizeWord', normalizeWord],
    ['normalizeOpenText', normalizeOpenText],
  ] as const;

  describe.each(both)('%s', (_name, normalize) => {
    it('allows up to three non-spacing marks on one base', () => {
      expect(normalize(`a${ACUTE}${CIRCUMFLEX}b`)).not.toBeNull();
      expect(normalize(`a${ACUTE.repeat(3)}b`)).not.toBeNull();
    });

    it('rejects four or more', () => {
      expect(normalize(`a${ACUTE.repeat(4)}b`)).toBeNull();
      expect(normalize(`ab${ACUTE.repeat(30)}`)).toBeNull();
    });

    it('counts marks per base, not per entry', () => {
      expect(normalize(`a${ACUTE}${CIRCUMFLEX}b${ACUTE}${CIRCUMFLEX}`)).not.toBeNull();
    });

    it('counts marks on a precomposed base and across removed invisible characters', () => {
      // U+00E1 is a + acute, so this is four marks once decomposed.
      expect(normalize(`${cp(0xe1)}${CIRCUMFLEX}${ACUTE}${ACUTE}b`)).toBeNull();
      expect(normalize(`a${ACUTE}${ZWSP}${ACUTE}${ZWSP}${ACUTE}${ZWSP}${ACUTE}`)).toBeNull();
    });

    it('rejects stacked marks in a script whose graphemes are long', () => {
      expect(normalize(`${cp(0x0915)}${NUKTA.repeat(4)}${cp(0x0937)}`)).toBeNull();
    });

    // Same words as the nickname tests: a per-grapheme count would reject these.
    it.each([
      ['Hindi Lakshmi', 'लक्ष्मी'],
      ['Bengali Lakshmi', 'লক্ষ্মী'],
      ['Devanagari Krishna', 'कृष्ण'],
      ['Tamil', 'தமிழ்'],
      ['Thai', 'สวัสดี'],
      ['Vietnamese with two marks per letter', 'Nguyễn Hậu'],
      ['Arabic with shadda and vowel', 'محمّد'],
      ['Bengali nukta with split vowel', 'বড়ো'],
      ['Hindi nukta, vowel and anusvara', 'चीज़ें'],
    ])('accepts %s', (_label, raw) => {
      const out = normalize(raw);
      expect(out).not.toBeNull();
      expect(out?.normalize('NFKC').toLowerCase()).toBe(raw.normalize('NFKC').toLowerCase());
    });
  });

  it('rejects Zalgo on any line of a multi-line entry', () => {
    expect(
      normalizeOpenText(`fine
z${ACUTE.repeat(4)}algo`),
    ).toBeNull();
    expect(
      normalizeOpenText(`fine
z${ACUTE.repeat(3)}algo`),
    ).not.toBeNull();
  });

  it('does not let a following word inherit the marks of the last one', () => {
    expect(normalizeWord(`a${ACUTE.repeat(3)} b${ACUTE.repeat(3)}`)).not.toBeNull();
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
