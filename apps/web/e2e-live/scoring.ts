/**
 * ADR-0005 written out again from the text, on purpose: the suite must not import the engine it
 * is checking. Everything here is pure.
 */

/** Full points inside this window, then a straight line down to 40% at the deadline. */
export const FULL_POINTS_WINDOW_MS = 250;
export const POINTS_AT_BEST = 1000;
export const POINTS_AT_DEADLINE_SHARE = 0.4;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Points for one scored answer, without any streak bonus (the quiz leaves it off). */
export function pointsFor(i: {
  correct: boolean;
  elapsedMs: number;
  limitMs: number | null;
  multiplier: 0 | 1 | 2;
}): number {
  if (!i.correct || i.multiplier === 0) return 0;
  if (i.limitMs === null) return POINTS_AT_BEST * i.multiplier;
  const r = clamp(
    (i.elapsedMs - FULL_POINTS_WINDOW_MS) / (i.limitMs - FULL_POINTS_WINDOW_MS),
    0,
    1,
  );
  return Math.round(POINTS_AT_BEST * i.multiplier * (1 - (1 - POINTS_AT_DEADLINE_SHARE) * r));
}

/** Lowest and highest a right answer can be worth, by the same rules. */
export function pointsRange(multiplier: 1 | 2): { min: number; max: number } {
  return {
    min: POINTS_AT_BEST * multiplier * POINTS_AT_DEADLINE_SHARE,
    max: POINTS_AT_BEST * multiplier,
  };
}

/** Code-point order, not locale order (ADR-0005). */
export function compareCodePoints(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

export interface Ranked {
  name: string;
  score: number;
  rank: number;
}

/** Score descending, ties in nickname order, competition ranking: 1, 2, 2, 4. */
export function rankPlayers(rows: ReadonlyArray<{ name: string; score: number }>): Ranked[] {
  const sorted = [...rows].sort((a, b) => b.score - a.score || compareCodePoints(a.name, b.name));
  return sorted.map((row) => ({
    ...row,
    rank: sorted.findIndex((r) => r.score === row.score) + 1,
  }));
}
