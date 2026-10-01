import { describe, expect, it } from 'vitest';
import { SCORING } from '@zqhoot/protocol';
import { basePoints, rankEntries, streakBonus } from '../src/index.ts';
import { base64UrlDecode, base64UrlEncode, clamp, compareCodePoints } from '../src/util.ts';

const L = 20_000;
const pts = (
  elapsedMs: number | null,
  limitMs: number | null,
  multiplier: 0 | 1 | 2 = 1,
  correct = true,
) => basePoints({ correct, elapsedMs, limitMs, multiplier });

describe('basePoints (ADR-0005)', () => {
  it.each([
    ['elapsed 0', 0, 1000],
    ['end of the full-points window', 250, 1000],
    ['one ms past the window', 251, 1000],
    ['midpoint of the decay span', 250 + (L - 250) / 2, 700],
    ['at the limit', L, 400],
    ['beyond the limit', L + 5000, 400],
    ['negative elapsed', -50, 1000],
  ])('%s', (_name, elapsed, expected) => {
    expect(pts(elapsed, L)).toBe(expected);
  });

  it('doubles for multiplier 2 and zeroes for 0', () => {
    expect(pts(0, L, 2)).toBe(2000);
    expect(pts(L, L, 2)).toBe(800);
    expect(pts(0, L, 0)).toBe(0);
    expect(pts(null, null, 0)).toBe(0);
  });

  it('awards nothing for a wrong answer', () => {
    expect(pts(0, L, 1, false)).toBe(0);
    expect(pts(0, L, 2, false)).toBe(0);
  });

  it('awards full points when untimed', () => {
    expect(pts(null, null, 1)).toBe(1000);
    expect(pts(null, null, 2)).toBe(2000);
    expect(pts(99_999, null, 1)).toBe(1000);
  });

  it.each([250, 249, 100, 1, 0, -5])(
    'gives full points without dividing by zero when limitMs is %s',
    (limitMs) => {
      for (const elapsed of [0, 250, 400, limitMs, 10_000]) {
        expect(pts(elapsed, limitMs)).toBe(1000);
        expect(pts(elapsed, limitMs, 2)).toBe(2000);
      }
    },
  );

  it('gives full points when a timed question has no elapsed time recorded', () => {
    expect(pts(null, L)).toBe(1000);
  });

  it('rounds half up', () => {
    // r = 1/1200, so 1000 * 0.6 * r = 0.5 points lost: 999.5 rounds to 1000.
    expect(pts(251, 1450)).toBe(1000);
    // r = 3/1200 loses 1.5 points: 998.5 rounds to 999.
    expect(pts(253, 1450)).toBe(999);
    // r = 5/1200 loses 2.5: 997.5 rounds to 998.
    expect(pts(255, 1450)).toBe(998);
  });

  it('matches the ADR formula over a grid and never increases with time', () => {
    for (const limitMs of [5000, 10_000, 20_000, 240_000]) {
      let previous = Infinity;
      for (let elapsed = 0; elapsed <= limitMs; elapsed += Math.max(1, Math.floor(limitMs / 997))) {
        const r = Math.min(1, Math.max(0, (elapsed - 250) / (limitMs - 250)));
        const expected = Math.round(1000 * (1 - 0.6 * r));
        const actual = pts(elapsed, limitMs);
        expect(actual).toBe(expected);
        expect(actual).toBeLessThanOrEqual(previous);
        expect(actual).toBeGreaterThanOrEqual(400);
        previous = actual;
      }
    }
  });

  it('stays in sync with the protocol constants', () => {
    expect(SCORING.basePoints).toBe(1000);
    expect(SCORING.minFraction).toBe(0.4);
  });
});

describe('streakBonus (ADR-0005)', () => {
  it.each([
    [0, 0],
    [1, 0],
    [2, 100],
    [3, 200],
    [4, 300],
    [5, 300],
    [6, 300],
  ])('streak %i with the bonus on', (streak, expected) => {
    expect(streakBonus({ streak, multiplier: 1, enabled: true })).toBe(expected);
    expect(streakBonus({ streak, multiplier: 2, enabled: true })).toBe(expected * 2);
    expect(streakBonus({ streak, multiplier: 0, enabled: true })).toBe(0);
    expect(streakBonus({ streak, multiplier: 1, enabled: false })).toBe(0);
  });
});

describe('rankEntries', () => {
  const e = (playerId: string, nickname: string, score: number) => ({ playerId, nickname, score });

  it('gives competition ranks: ties share a rank and the next rank skips', () => {
    const ranked = rankEntries([
      e('p1', 'a', 100),
      e('p2', 'b', 90),
      e('p3', 'c', 90),
      e('p4', 'd', 80),
    ]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 2, 4]);
    expect(
      rankEntries([e('p1', 'a', 5), e('p2', 'b', 5), e('p3', 'c', 5)]).map((r) => r.rank),
    ).toEqual([1, 1, 1]);
    expect(
      rankEntries([
        e('p1', 'a', 9),
        e('p2', 'b', 5),
        e('p3', 'c', 5),
        e('p4', 'd', 5),
        e('p5', 'e', 1),
      ]).map((r) => r.rank),
    ).toEqual([1, 2, 2, 2, 5]);
  });

  it('sorts by score, then nickname by code point, then player id', () => {
    const ranked = rankEntries([
      e('p3', 'b', 10),
      e('p9', 'a', 10),
      e('p2', 'a', 10),
      e('p1', 'B', 10),
      e('p4', 'z', 20),
    ]);
    expect(ranked.map((r) => r.playerId)).toEqual(['p4', 'p1', 'p2', 'p9', 'p3']);
  });

  it('orders astral characters after BMP ones like code points do (not UTF-16 units)', () => {
    const ranked = rankEntries([e('p1', '\u{1F600}', 1), e('p2', 'Ａ', 1), e('p3', 'a', 1)]);
    expect(ranked.map((r) => r.nickname)).toEqual(['a', 'Ａ', '\u{1F600}']);
  });

  it('is deterministic under input order and does not mutate the input', () => {
    const input = [e('p1', 'x', 3), e('p2', 'y', 3), e('p3', 'z', 7)];
    const snapshot = JSON.stringify(input);
    const forward = rankEntries(input);
    const reversed = rankEntries([...input].reverse());
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(forward).toEqual(reversed);
  });

  it('keeps extra fields and handles an empty list', () => {
    const [first] = rankEntries([{ playerId: 'p1', nickname: 'a', score: 1, extra: 'kept' }]);
    expect(first).toEqual({ playerId: 'p1', nickname: 'a', score: 1, extra: 'kept', rank: 1 });
    expect(rankEntries([])).toEqual([]);
  });
});

describe('util', () => {
  it('compareCodePoints orders by code point and by length', () => {
    expect(compareCodePoints('a', 'b')).toBeLessThan(0);
    expect(compareCodePoints('b', 'a')).toBeGreaterThan(0);
    expect(compareCodePoints('a', 'a')).toBe(0);
    expect(compareCodePoints('a', 'ab')).toBeLessThan(0);
    expect(compareCodePoints('ab', 'a')).toBeGreaterThan(0);
    expect(compareCodePoints('Ａ', '\u{1F600}')).toBeLessThan(0);
    expect(compareCodePoints('\u{1F600}', '\u{1F601}')).toBeLessThan(0);
    expect(compareCodePoints('\u{1F600}', '\u{1F600}')).toBe(0);
  });

  it('clamp', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(clamp(2, 0, 3)).toBe(2);
  });

  it.each([
    '',
    'a',
    'ab',
    'abc',
    'abcd',
    '1758000000000:player-01-0',
    'é',
    '€',
    '\u{1F600}',
    'mixed é€\u{1F600} text',
  ])('base64url round trip for %j', (s) => {
    const encoded = base64UrlEncode(s);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/);
    expect(base64UrlDecode(encoded)).toBe(s);
    // Agrees with Node's own encoder.
    expect(encoded).toBe(Buffer.from(s, 'utf8').toString('base64url'));
  });

  it.each(['a', '!!!!', 'abc=', '/+/+', '_-_-a', '/w'])('base64url decode rejects %j', (s) => {
    // Invalid alphabet, impossible length, or bytes that are not UTF-8.
    const decoded = base64UrlDecode(s);
    if (decoded !== null) expect(base64UrlEncode(decoded)).toBe(s);
  });

  it('base64url decode rejects malformed UTF-8', () => {
    const enc = (bytes: number[]) => Buffer.from(bytes).toString('base64url');
    expect(base64UrlDecode(enc([0xff]))).toBeNull();
    expect(base64UrlDecode(enc([0xc3]))).toBeNull();
    expect(base64UrlDecode(enc([0xc3, 0x28]))).toBeNull();
    expect(base64UrlDecode(enc([0xed, 0xa0, 0x80]))).toBeNull();
    expect(base64UrlDecode(enc([0xf4, 0x90, 0x80, 0x80]))).toBeNull();
    expect(base64UrlDecode(enc([0x80]))).toBeNull();
    expect(base64UrlDecode('a')).toBeNull();
    expect(base64UrlDecode('ab$d')).toBeNull();
  });
});
