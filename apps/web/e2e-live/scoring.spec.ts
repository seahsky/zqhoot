import { expect, test } from '@playwright/test';
import { compareCodePoints, pointsFor, pointsRange, rankPlayers } from './scoring.ts';

/**
 * The live suite recomputes points and ranks from ADR-0005 instead of trusting the engine, so
 * the recomputation itself is pinned to the ADR's own numbers first.
 */

const at = (elapsedMs: number, multiplier: 0 | 1 | 2 = 1) =>
  pointsFor({ correct: true, elapsedMs, limitMs: 10_000, multiplier });

test('points fall on a straight line from 1000 to 400 after a 250 ms full-points window', () => {
  expect(at(0)).toBe(1000);
  expect(at(250)).toBe(1000);
  expect(at(10_000)).toBe(400);
  // Halfway between 250 ms and the deadline: 1000 * (1 - 0.6 * 0.5).
  expect(at(5125)).toBe(700);
  expect(at(1000)).toBe(954);
  expect(at(2000)).toBe(892);
});

test('multipliers scale the whole curve; wrong answers and no points score nothing', () => {
  expect(at(250, 2)).toBe(2000);
  expect(at(10_000, 2)).toBe(800);
  expect(at(250, 0)).toBe(0);
  expect(pointsFor({ correct: false, elapsedMs: 0, limitMs: 10_000, multiplier: 1 })).toBe(0);
  expect(pointsFor({ correct: true, elapsedMs: 9_999, limitMs: null, multiplier: 2 })).toBe(2000);
  expect(pointsRange(2)).toEqual({ min: 800, max: 2000 });
});

test('ranks are score descending, ties in code-point order, competition numbering', () => {
  const ranked = rankPlayers([
    { name: 'Zed', score: 500 },
    { name: 'Amy', score: 900 },
    { name: 'Bob', score: 500 },
    { name: 'Cat', score: 0 },
  ]);
  expect(ranked.map((r) => [r.name, r.rank])).toEqual([
    ['Amy', 1],
    ['Bob', 2],
    ['Zed', 2],
    ['Cat', 4],
  ]);
  expect(compareCodePoints('Eve', 'eve')).toBeLessThan(0);
});
