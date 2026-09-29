import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '../src/net/http.ts';
import { LIMITS } from '@zqhoot/protocol';
import {
  NICKNAME_REASON_COPY,
  digitsOnly,
  nicknameCounter,
  utf8Bytes,
  validateNickname,
} from '../src/screens/join/nickname.ts';
import {
  joinErrorMessage,
  lookupErrorMessage,
  lookupRefusalMessage,
} from '../src/screens/join/copy.ts';
import {
  formatNumber,
  graphemeCount,
  ordinal,
  ownAnswerLine,
  pointsLabel,
  revealHeadline,
  standingSentence,
  timerTier,
} from '../src/state/format.ts';
import type { RevealVariant } from '../src/state/player.ts';

describe('ordinal', () => {
  it('handles the teens and every last digit', () => {
    const cases: Array<[number, string]> = [
      [1, '1st'],
      [2, '2nd'],
      [3, '3rd'],
      [4, '4th'],
      [10, '10th'],
      [11, '11th'],
      [12, '12th'],
      [13, '13th'],
      [21, '21st'],
      [22, '22nd'],
      [23, '23rd'],
      [101, '101st'],
      [111, '111th'],
      [112, '112th'],
    ];
    for (const [n, text] of cases) expect(ordinal(n)).toBe(text);
  });
});

describe('standingSentence', () => {
  it('matches the spec example', () => {
    expect(
      standingSentence({ score: 2100, rank: 4, behind: { nickname: 'Kim', points: 120 } }),
    ).toBe("You're 4th, 120 points behind Kim");
  });

  it('uses the singular for one point, and drops the gap when leading', () => {
    expect(standingSentence({ score: 5, rank: 2, behind: { nickname: 'Ana', points: 1 } })).toBe(
      "You're 2nd, 1 point behind Ana",
    );
    expect(standingSentence({ score: 500, rank: 1 })).toBe("You're 1st");
  });

  it('copes with an unranked player', () => {
    expect(standingSentence({ score: 1200, rank: null })).toBe('You have 1,200 points');
  });
});

describe('numbers', () => {
  it('formats with fixed en-US grouping', () => {
    expect(formatNumber(1234567)).toBe('1,234,567');
    expect(pointsLabel(0)).toBe('0 points');
    expect(pointsLabel(1)).toBe('1 point');
  });
});

describe('graphemeCount', () => {
  it('counts what a person would', () => {
    expect(graphemeCount('')).toBe(0);
    expect(graphemeCount('Riley')).toBe(5);
    expect(graphemeCount('é')).toBe(1); // e + combining acute
    expect(graphemeCount('👩‍👩‍👧‍👦')).toBe(1); // family emoji, one glyph
    expect(graphemeCount('🇳🇿🇳🇿')).toBe(2); // two flags
    expect(graphemeCount('日本語')).toBe(3);
  });
});

describe('timerTier', () => {
  it('changes every 10 s above 10, then at 10 and at 5', () => {
    expect(timerTier(45)).toBe(50);
    expect(timerTier(31)).toBe(40);
    expect(timerTier(30)).toBe(30);
    expect(timerTier(21)).toBe(30);
    expect(timerTier(20)).toBe(20);
    expect(timerTier(11)).toBe(20);
    expect(timerTier(10)).toBe(10);
    expect(timerTier(6)).toBe(10);
    expect(timerTier(5)).toBe(5);
    expect(timerTier(1)).toBe(5);
  });
});

describe('nickname helpers', () => {
  it('validates length in graphemes after collapsing whitespace', () => {
    expect(validateNickname('')).toMatch(/Enter a nickname/);
    expect(validateNickname('   ')).toMatch(/Enter a nickname/);
    expect(validateNickname('A')).toMatch(/at least 2/);
    expect(validateNickname('Al')).toBeNull();
    expect(validateNickname('a'.repeat(16))).toBeNull();
    expect(validateNickname('a'.repeat(17))).toMatch(/up to 16/);
    expect(validateNickname('  Kim   Lee  ')).toBeNull();
    // 20 raw characters that collapse to 16 are fine: the server counts after normalising.
    expect(validateNickname('abcd    efgh    ijkl')).toBeNull();
    expect(validateNickname('👩‍👩‍👧‍👦👩‍👩‍👧‍👦')).toBeNull();
  });

  it('shows a live counter against 16', () => {
    expect(nicknameCounter('')).toBe('0 / 16');
    expect(nicknameCounter('Riley')).toBe('5 / 16');
    expect(nicknameCounter('a'.repeat(18))).toBe('18 / 16 (too long)');
  });

  describe('the UTF-8 byte cap (LIMITS.nicknameMaxBytes)', () => {
    // A flag is one grapheme and eight bytes: 12 fit the 96-byte cap, 13 do not, though 13 is
    // far below the 16-grapheme limit.
    const flags = (n: number) => '\u{1F1F3}\u{1F1FF}'.repeat(n);

    it('counts bytes the way the server does', () => {
      expect(utf8Bytes('Riley')).toBe(5);
      expect(utf8Bytes('é')).toBe(2);
      expect(utf8Bytes('日本')).toBe(6);
      expect(utf8Bytes(flags(1))).toBe(8);
      expect(utf8Bytes('')).toBe(0);
      expect(LIMITS.nicknameMaxBytes).toBe(96);
    });

    it('accepts a nickname that is exactly at the cap', () => {
      expect(graphemeCount(flags(12))).toBe(12);
      expect(utf8Bytes(flags(12))).toBe(LIMITS.nicknameMaxBytes);
      expect(validateNickname(flags(12))).toBeNull();
    });

    it('refuses one byte over the cap, before it is sent, with the too-long sentence', () => {
      expect(graphemeCount(flags(13))).toBeLessThanOrEqual(LIMITS.nicknameMaxGraphemes);
      expect(validateNickname(flags(13))).toBe(NICKNAME_REASON_COPY['too-long']);
      // Accented Latin is two bytes a letter: 16 graphemes, 32 bytes, fine; three-byte CJK
      // reaches 48 bytes, still fine. Only the heaviest emoji get near the cap.
      expect(validateNickname('é'.repeat(16))).toBeNull();
      expect(validateNickname('日'.repeat(16))).toBeNull();
    });

    it('measures the collapsed name, like the server, not the raw text', () => {
      expect(validateNickname(`  ${flags(12)}   `)).toBeNull();
    });

    it('keeps the counter in graphemes and warns as soon as the byte cap is passed', () => {
      expect(nicknameCounter(flags(12))).toBe('12 / 16');
      expect(nicknameCounter(flags(13))).toBe('13 / 16 (too long: emoji count for more)');
      expect(nicknameCounter('a'.repeat(17))).toBe('17 / 16 (too long)');
    });
  });

  it('keeps only up to six digits of a PIN', () => {
    expect(digitsOnly('12a3-45 6789')).toBe('123456');
    expect(digitsOnly('')).toBe('');
  });
});

describe('join copy', () => {
  it('has our own sentence for every error the spec names, not the server text', () => {
    for (const code of [
      'nickname-invalid',
      'nickname-taken',
      'session-locked',
      'session-full',
      'rate-limited',
    ] as const) {
      const text = joinErrorMessage(code, 'SERVER TEXT');
      expect(text).not.toContain('SERVER TEXT');
      expect(text.length).toBeGreaterThan(10);
    }
  });

  describe('a rejected nickname says why (the reason is the error message)', () => {
    const reasons = ['too-short', 'too-long', 'invalid-characters', 'inappropriate'] as const;

    it('has a different sentence for every reason the server sends', () => {
      const texts = reasons.map((reason) => joinErrorMessage('nickname-invalid', reason));
      expect(new Set(texts).size).toBe(reasons.length);
      expect(texts[0]).toMatch(/at least 2/);
      expect(texts[1]).toMatch(/too long/);
      expect(texts[2]).toMatch(/characters/);
      expect(texts[3]).toMatch(/word/);
      for (const reason of reasons) {
        expect(joinErrorMessage('nickname-invalid', reason)).toBe(NICKNAME_REASON_COPY[reason]);
      }
    });

    it('uses the same sentence as the local check for length', () => {
      expect(joinErrorMessage('nickname-invalid', 'too-long')).toBe(
        validateNickname('a'.repeat(17)),
      );
      expect(joinErrorMessage('nickname-invalid', 'too-short')).toBe(validateNickname('a'));
    });

    it('falls back to the generic sentence for a reason it does not know, or prose', () => {
      const generic = joinErrorMessage('nickname-invalid', '');
      expect(generic).toMatch(/isn't allowed/);
      for (const message of ['nope', 'constructor', '__proto__', 'Nickname rejected.']) {
        expect(joinErrorMessage('nickname-invalid', message)).toBe(generic);
      }
    });

    it('does not let another code borrow the nickname reasons', () => {
      expect(joinErrorMessage('nickname-taken', 'too-long')).toMatch(/already has that nickname/);
      expect(joinErrorMessage('internal', 'too-long')).toBe('too-long');
    });
  });

  it('falls back to the server message for codes without copy', () => {
    expect(joinErrorMessage('internal', 'It broke.')).toBe('It broke.');
    expect(joinErrorMessage('internal', '')).toMatch(/went wrong/);
  });

  it('explains PIN lookup failures', () => {
    expect(lookupErrorMessage(new ApiRequestError(404, 'not-found', 'x'))).toMatch(
      /No game has that PIN/,
    );
    expect(lookupErrorMessage(new ApiRequestError(429, 'rate-limited', 'x'))).toMatch(/Too many/);
    expect(lookupErrorMessage(new ApiRequestError(0, 'network', 'x'))).toMatch(/connection/);
    expect(lookupErrorMessage(new Error('boom'))).toMatch(/went wrong/);
    expect(lookupRefusalMessage('locked')).toMatch(/new players/);
    expect(lookupRefusalMessage('ended')).toMatch(/ended/);
    expect(lookupRefusalMessage('full')).toMatch(/full/);
    expect(lookupRefusalMessage(undefined)).toMatch(/right now/);
  });
});

describe('revealHeadline', () => {
  const view = (variant: RevealVariant, gained = 0) =>
    ({ variant, gained }) as unknown as Parameters<typeof revealHeadline>[0];

  it('has its own words for each of the four outcomes', () => {
    expect(revealHeadline(view('correct', 870))).toBe('Correct, +870');
    expect(revealHeadline(view('incorrect'))).toBe('Not this time');
    expect(revealHeadline(view('no-answer'))).toBe("You didn't answer this one");
    expect(revealHeadline(view('unscored'))).toBe('Question closed');
    const all = (['correct', 'incorrect', 'no-answer', 'unscored'] as const).map((v) =>
      revealHeadline(view(v, 100)),
    );
    expect(new Set(all).size).toBe(4);
  });

  it('an unscored reveal does not repeat the words of the screen the player just left', () => {
    // "Thanks, your response is in" and "Answer locked in" are the submitted screen's headings.
    const locked = ['Thanks, your response is in', 'Answer locked in'];
    expect(locked).not.toContain(revealHeadline(view('unscored')));
  });
});

describe('ownAnswerLine', () => {
  it('a choice is its letter and text: "Your answer: B · Pizza"', () => {
    expect(ownAnswerLine({ kind: 'choice', slot: 1, text: 'Pizza' })).toBe(
      'Your answer: B · Pizza',
    );
    expect(ownAnswerLine({ kind: 'choice', slot: 0, text: 'True' })).toBe('Your answer: A · True');
    expect(ownAnswerLine({ kind: 'choice', slot: 5, text: 'Sushi' })).toBe(
      'Your answer: F · Sushi',
    );
  });

  it('a rating says where on the scale', () => {
    expect(ownAnswerLine({ kind: 'rating', value: 4, max: 5 })).toBe('Your rating: 4 of 5');
  });

  it('words and responses are the ones entered, in order, with the right number', () => {
    expect(ownAnswerLine({ kind: 'words', entries: ['sunny'] })).toBe('Your word: sunny');
    expect(ownAnswerLine({ kind: 'words', entries: ['sunny', 'busy'] })).toBe(
      'Your words: sunny, busy',
    );
    expect(ownAnswerLine({ kind: 'text', entries: ['Quieter desks'] })).toBe(
      'Your response: Quieter desks',
    );
    expect(ownAnswerLine({ kind: 'text', entries: ['Quieter desks', 'A window'] })).toBe(
      'Your responses: Quieter desks · A window',
    );
  });
});
