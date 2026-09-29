import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '../src/net/http.ts';
import { digitsOnly, nicknameCounter, validateNickname } from '../src/screens/join/nickname.ts';
import {
  joinErrorMessage,
  lookupErrorMessage,
  lookupRefusalMessage,
} from '../src/screens/join/copy.ts';
import {
  formatNumber,
  graphemeCount,
  ordinal,
  pointsLabel,
  standingSentence,
  timerTier,
} from '../src/state/format.ts';

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
