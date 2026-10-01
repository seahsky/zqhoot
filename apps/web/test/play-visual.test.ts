import { describe, expect, it } from 'vitest';
import { LIMITS } from '@zqhoot/protocol';
import { PLAY_FIXTURES } from '../src/dev/fixtures/player.ts';
import { scoreFigure } from '../src/screens/play/figures.ts';
import { ratingColumns } from '../src/screens/play/ratingLayout.ts';

/** Row sizes a scale of `max` values makes in `columns` columns, first row first. */
function rows(max: number, columns: number): number[] {
  const out: number[] = [];
  for (let left = max; left > 0; left -= columns) out.push(Math.min(columns, left));
  return out;
}

describe('ratingColumns', () => {
  it('splits 7 as 4 + 3, never 5 + 2', () => {
    expect(rows(7, ratingColumns(7))).toEqual([4, 3]);
  });

  it('keeps short scales in one row and splits longer ones in two', () => {
    expect(rows(3, ratingColumns(3))).toEqual([3]);
    expect(rows(5, ratingColumns(5))).toEqual([5]);
    expect(rows(6, ratingColumns(6))).toEqual([3, 3]);
    expect(rows(10, ratingColumns(10))).toEqual([5, 5]);
  });

  it('never leaves a row shorter than half the first, for every size the protocol allows', () => {
    for (let max = LIMITS.ratingMaxMin; max <= LIMITS.ratingMaxMax; max += 1) {
      const [first = 0, ...rest] = rows(max, ratingColumns(max));
      expect(rest.length, `${max} values`).toBeLessThanOrEqual(1);
      for (const n of rest) expect(n, `${max} values`).toBeGreaterThanOrEqual(first - 1);
    }
  });
});

describe('scoreFigure', () => {
  it('pairs the number with its unit, singular for one point', () => {
    expect(scoreFigure(2340)).toEqual({ value: '2,340', label: 'points' });
    expect(scoreFigure(1)).toEqual({ value: '1', label: 'point' });
    expect(scoreFigure(0)).toEqual({ value: '0', label: 'points' });
  });
});

describe('player fixtures', () => {
  it('the lobby has no points and no rank, since nothing has been scored yet', () => {
    expect(PLAY_FIXTURES['play-lobby'].me).toMatchObject({ score: 0, rank: null });
  });

  it('screens from a game under way keep their score', () => {
    for (const id of [
      'play-answer-single',
      'play-kicked',
      'play-session-over',
      'play-out-of-date',
    ] as const) {
      expect(PLAY_FIXTURES[id].me, id).toMatchObject({ score: 1240, rank: 4 });
    }
  });
});
