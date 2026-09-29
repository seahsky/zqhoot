import { describe, expect, it } from 'vitest';
import { containsProfanity, normalizeNickname } from '../src/index.ts';
import { CONFUSABLES, nicknameKey } from '../src/nickname.ts';

const cp = (...codes: number[]) => String.fromCodePoint(...codes);
const ok = (raw: string) => {
  const r = normalizeNickname(raw);
  if (!r.ok) throw new Error(`expected ok for ${JSON.stringify(raw)}, got ${r.reason}`);
  return r;
};
const reason = (raw: string) => {
  const r = normalizeNickname(raw);
  return r.ok ? 'ok' : r.reason;
};

const ZWSP = cp(0x200b);
const ZWJ = cp(0x200d);
const VS16 = cp(0xfe0f);
const CYRILLIC_A = cp(0x0410);
const GREEK_ALPHA = cp(0x0391);
const GREEK_NU = cp(0x039d);
const COMBINING_ACUTE = cp(0x0301);
const COMBINING_CIRCUMFLEX = cp(0x0302);

describe('normalizeNickname: examples from ADR-0009', () => {
  it('collapses and trims whitespace', () => {
    expect(ok('  Kim   Lee ')).toMatchObject({ nickname: 'Kim Lee', key: 'kimlee' });
  });

  it('strips zero-width characters', () => {
    expect(ok(`Bob${ZWSP}`).nickname).toBe('Bob');
  });

  it('rejects bidi override characters', () => {
    expect(reason(`a${cp(0x202e)}b`)).toBe('invalid-characters');
  });

  it('gives Ana, ana and a Cyrillic-A Ana the same key', () => {
    const keys = ['Ana', 'ana', `${CYRILLIC_A}na`, `${GREEK_ALPHA}${GREEK_NU}${GREEK_ALPHA}`].map(
      (n) => ok(n).key,
    );
    expect(new Set(keys)).toEqual(new Set(['ana']));
  });

  it('keeps the display form as typed (after NFKC and whitespace cleanup)', () => {
    expect(ok('ana').nickname).toBe('ana');
    expect(ok(`${CYRILLIC_A}na`).nickname).toBe(`${CYRILLIC_A}na`);
  });

  it('accepts 16 emoji and rejects 17', () => {
    expect(ok('😀'.repeat(16)).nickname).toBe('😀'.repeat(16));
    expect(reason('😀'.repeat(17))).toBe('too-long');
  });
});

describe('normalizeNickname: length in graphemes', () => {
  it.each([
    ['', 'too-short'],
    ['   ', 'too-short'],
    ['a', 'too-short'],
    ['ab', 'ok'],
    ['a'.repeat(16), 'ok'],
    ['a'.repeat(17), 'too-long'],
  ])('%j -> %s', (raw, expected) => {
    expect(reason(raw)).toBe(expected);
  });

  it('counts a ZWJ family, a flag and a decomposed accent as one grapheme each', () => {
    const family = ['👨', '👩', '👧'].join(ZWJ);
    expect(reason(family)).toBe('too-short');
    expect(reason(`A${family}`)).toBe('ok');
    expect(reason('🇯🇵')).toBe('too-short');
    expect(reason(`e${COMBINING_ACUTE}`)).toBe('too-short');
    expect(reason('e'.repeat(16) + COMBINING_ACUTE)).toBe('ok');
  });

  it('measures after stripping, so invisible padding cannot dodge the limit', () => {
    expect(reason(`${ZWSP}a${ZWSP}`)).toBe('too-short');
    expect(reason(`${'a'.repeat(16)}${ZWSP.repeat(40)}`)).toBe('ok');
  });

  it('rejects raw input beyond the protocol cap before doing any work', () => {
    expect(reason('a'.repeat(65))).toBe('too-long');
  });
});

describe('normalizeNickname: invisible and forbidden characters', () => {
  it('strips default-ignorable format characters', () => {
    for (const c of [0x00ad, 0x200b, 0x200c, 0x2060, 0xfeff, 0x034f, 0x3164, 0xe0067]) {
      expect(ok(`ab${cp(c)}cd`).nickname).toBe('abcd');
    }
  });

  it('strips a stray VS16 or ZWJ outside an emoji sequence', () => {
    expect(ok(`ab${VS16}`).nickname).toBe('ab');
    expect(ok(`a${ZWJ}b`).nickname).toBe('ab');
    expect(ok(`a${ZWJ}😀`).nickname).toBe('a😀');
    expect(ok(`😀${ZWJ}b`).nickname).toBe('😀b');
  });

  it('keeps VS16 and ZWJ inside emoji sequences', () => {
    const heart = `❤${VS16}`;
    expect(ok(`x${heart}`).nickname).toBe(`x${heart}`);
    const family = ['👨', '👩', '👧'].join(ZWJ);
    expect(ok(`A${family}`).nickname).toBe(`A${family}`);
    const rainbow = `🏳${VS16}${ZWJ}🌈`;
    expect(ok(`A${rainbow}`).nickname).toBe(`A${rainbow}`);
    const astronaut = `👩${cp(0x1f3fd)}${ZWJ}🚀`;
    expect(ok(`A${astronaut}`).nickname).toBe(`A${astronaut}`);
    const keycap = `1${VS16}${cp(0x20e3)}x`;
    expect(ok(keycap).nickname).toBe(keycap);
  });

  it.each([
    0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
  ])('rejects bidi control U+%s', (c) => {
    expect(reason(`ab${cp(c)}cd`)).toBe('invalid-characters');
  });

  it.each([
    ['C0 control', cp(0x07)],
    ['tab', '\t'],
    ['newline', '\n'],
    ['DEL', cp(0x7f)],
    ['C1 control', cp(0x9b)],
    ['private use', cp(0xe000)],
    ['supplementary private use', cp(0xf0000)],
    ['unassigned', cp(0x0378)],
    ['noncharacter', cp(0xfffe)],
    ['line separator', cp(0x2028)],
    ['paragraph separator', cp(0x2029)],
    ['lone surrogate', '\ud800'],
  ])('rejects %s', (_name, ch) => {
    expect(reason(`ab${ch}cd`)).toBe('invalid-characters');
  });

  it('applies NFKC', () => {
    expect(ok('Ａｎａ').nickname).toBe('Ana');
    expect(ok('ﬁsh').nickname).toBe('fish');
    expect(ok('①②').nickname).toBe('12');
  });

  it('collapses every kind of space to one ASCII space', () => {
    expect(ok(`a${cp(0xa0)}${cp(0x2003)}${cp(0x3000)}b`).nickname).toBe('a b');
    expect(ok(`${cp(0xa0)}ab${cp(0x2003)}`).nickname).toBe('ab');
  });
});

describe('normalizeNickname: anti-Zalgo', () => {
  it('allows up to three non-spacing marks on one base', () => {
    expect(reason(`a${COMBINING_ACUTE}${COMBINING_CIRCUMFLEX}b`)).toBe('ok');
    expect(reason(`a${COMBINING_ACUTE.repeat(3)}b`)).toBe('ok');
  });

  it('rejects four or more', () => {
    expect(reason(`a${COMBINING_ACUTE.repeat(4)}b`)).toBe('invalid-characters');
    expect(reason(`ab${COMBINING_ACUTE.repeat(30)}`)).toBe('invalid-characters');
  });

  it('counts marks per base, not per name', () => {
    expect(
      reason(
        `a${COMBINING_ACUTE}${COMBINING_CIRCUMFLEX}b${COMBINING_ACUTE}${COMBINING_CIRCUMFLEX}`,
      ),
    ).toBe('ok');
  });

  it('counts marks on a precomposed base too', () => {
    // U+00E1 is a + acute, so this is four marks once decomposed.
    expect(reason(`${cp(0xe1)}${COMBINING_CIRCUMFLEX}${COMBINING_ACUTE}${COMBINING_ACUTE}b`)).toBe(
      'invalid-characters',
    );
    expect(reason(`${cp(0xe1)}${COMBINING_CIRCUMFLEX}${COMBINING_ACUTE}b`)).toBe('ok');
  });

  it('is checked before length', () => {
    expect(reason(`a${COMBINING_ACUTE.repeat(4)}${'b'.repeat(20)}`)).toBe('invalid-characters');
  });

  // Node 22 segments an Indic conjunct (consonant, virama, consonant, vowel sign) as one
  // grapheme, so a per-grapheme count would reject these ordinary names. Each base carries
  // at most one mark; only a run of marks on one base is decoration.
  it.each([
    ['Hindi Lakshmi', 'लक्ष्मी'],
    ['Bengali Lakshmi', 'লক্ষ্মী'],
    ['Malayalam Lakshmi', 'ലക്ഷ്മി'],
    ['Devanagari Krishna', 'कृष्ण'],
    ['Tamil', 'தமிழ்'],
    ['Thai', 'สวัสดี'],
    ['Vietnamese with two marks per letter', 'Nguyễn Hậu'],
    ['Arabic with shadda and vowel', 'محمّد'],
    // NFD splits these into nukta (Mn) plus two spacing vowel parts (Mc).
    ['Bengali nukta with split vowel', 'বড়ো'],
    ['Bengali ya-nukta with split vowel', 'হয়ো'],
    // Nukta, vowel sign and anusvara: three non-spacing marks on one base.
    ['Hindi nukta, vowel and anusvara', 'चीज़ें'],
  ])('accepts %s', (_name, raw) => {
    expect(reason(raw)).toBe('ok');
  });

  it('gives an accepted Indic name a usable key and keeps it as typed', () => {
    const r = ok('लक्ष्मी');
    expect(r.nickname).toBe('लक्ष्मी');
    expect(r.key).not.toBe('');
  });

  it('still rejects stacked marks in scripts whose graphemes are long', () => {
    const nukta = cp(0x093c);
    expect(reason(`${cp(0x0915)}${nukta.repeat(4)}${cp(0x0937)}`)).toBe('invalid-characters');
    expect(reason(`लक्ष्मी${COMBINING_ACUTE.repeat(4)}`)).toBe('invalid-characters');
  });
});

describe('normalizeNickname: blank-looking symbols', () => {
  const BRAILLE_BLANK = cp(0x2800);

  it('does not accept a name made only of braille blanks', () => {
    expect(reason(BRAILLE_BLANK.repeat(2))).toBe('too-short');
    expect(reason(`a${BRAILLE_BLANK}`)).toBe('too-short');
  });

  it('treats a braille blank as the space it looks like', () => {
    expect(ok(`Bob${BRAILLE_BLANK}`)).toMatchObject({ nickname: 'Bob', key: 'bob' });
    expect(ok(`${BRAILLE_BLANK}Bob`)).toMatchObject({ nickname: 'Bob', key: 'bob' });
    expect(ok(`Bo${BRAILLE_BLANK}${BRAILLE_BLANK} b`)).toMatchObject({
      nickname: 'Bo b',
      key: 'bob',
    });
  });

  it('cannot forge a near-copy of an existing name', () => {
    expect(ok(`Bob${BRAILLE_BLANK}`).key).toBe(ok('Bob').key);
  });
});

describe('normalizeNickname: uniqueness key', () => {
  it('folds case, accents, confusables and leetspeak', () => {
    const same: Array<[string, string]> = [
      ['Ana', 'ANA'],
      ['Jose', `José`],
      ['Player', 'Pl4y3r'],
      ['Sam', '$am'],
      ['Anna', 'Ann@'],
      ['Tom', 'T0m'],
      ['Lee', 'l33'],
      ['Nick', `${GREEK_NU}ick`],
      ['Ana', 'A.n-a!'],
      ['Ana', 'A n a'],
      ['Kate', 'K47e'],
      ['Slt', '51t'],
    ];
    for (const [a, b] of same) expect(ok(a).key, `${a} vs ${b}`).toBe(ok(b).key);
  });

  it('folds digits the way the spec lists them', () => {
    expect(nicknameKey('0134 57@$')).toBe('oleasta' + 's');
  });

  it('keeps names that only look similar apart', () => {
    const keys = ['Ana', 'Anna', 'Ann', 'Ana2', 'Ana6'].map((n) => ok(n).key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps emoji in the key and drops variation selectors and joiners', () => {
    expect(ok('A😀').key).toBe('a😀');
    expect(ok('😀😀').key).toBe('😀😀');
    expect(ok('😀😀').key).not.toBe(ok('😀🎉').key);
    expect(ok(`A❤${VS16}`).key).toBe(ok('A❤').key);
  });

  it('rejects names with nothing left after dropping punctuation', () => {
    expect(reason('!!')).toBe('invalid-characters');
    expect(reason('. .')).toBe('invalid-characters');
    expect(reason('+-')).toBe('invalid-characters');
  });

  it('maps only non-ASCII look-alikes, each to one lowercase Latin letter', () => {
    expect(CONFUSABLES.size).toBeGreaterThan(50);
    for (const [ch, latin] of CONFUSABLES) {
      expect(ch.codePointAt(0)).toBeGreaterThan(0x7f);
      expect(latin).toMatch(/^[a-z]$/);
    }
  });
});

describe('normalizeNickname: profanity', () => {
  it.each(['fuck', 'FUCK', 'fvck', 'sh1t', 'f u c k', 'F.U.C.K', 'b1tch', 'a$$'])(
    'rejects %j',
    (raw) => {
      expect(reason(raw)).toBe('inappropriate');
    },
  );

  it('also checks the folded key, so Cyrillic look-alikes do not slip through', () => {
    expect(reason(`fu${cp(0x0441)}k`)).toBe('inappropriate');
  });

  it('does not flag the Scunthorpe cases the dataset whitelists', () => {
    for (const n of [
      'Scunthorpe',
      'Assassin',
      'Class Act',
      'Hancock',
      'Cassidy',
      'Dickens',
      'Essex',
    ]) {
      expect(reason(n), n).toBe('ok');
    }
  });

  // Documented limitation: matching the key (spaces removed) is what catches "f u c k", and it
  // also flags innocent word pairs and real place names the dataset does not whitelist.
  it('documents known false positives', () => {
    expect(containsProfanity('Pen Is')).toBe(false);
    expect(reason('Pen Is')).toBe('inappropriate');
    expect(reason('Penistone')).toBe('inappropriate');
  });
});

describe('result priority', () => {
  it('reports invalid characters before length or profanity', () => {
    expect(reason(`fuck${cp(0x07)}`)).toBe('invalid-characters');
    expect(reason(`${'a'.repeat(30)}${cp(0x07)}`)).toBe('invalid-characters');
  });

  it('reports length before profanity', () => {
    expect(reason(`fuck${'k'.repeat(20)}`)).toBe('too-long');
  });
});
