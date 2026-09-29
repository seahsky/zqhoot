import { SCORING, TIMING } from '@zqhoot/protocol';
import type { PlayerScore } from './model.ts';
import { clamp, compareCodePoints } from './util.ts';

export const EMPTY_SCORE: Readonly<PlayerScore> = {
  score: 0,
  streak: 0,
  correct: 0,
  answeredScored: 0,
  lastDelta: 0,
  lastRank: null,
};

export function basePoints(i: {
  correct: boolean;
  elapsedMs: number | null;
  limitMs: number | null;
  multiplier: 0 | 1 | 2;
}): number {
  if (!i.correct || i.multiplier === 0) return 0;
  const full = SCORING.basePoints * i.multiplier;
  const window = TIMING.fullPointsWindowMs;
  // `limitMs <= window` would divide by zero (or flip the sign) and leaves no decay span anyway.
  if (i.limitMs === null || i.elapsedMs === null || i.limitMs <= window) return full;
  const r = clamp((i.elapsedMs - window) / (i.limitMs - window), 0, 1);
  return Math.round(full * (1 - (1 - SCORING.minFraction) * r));
}

export function streakBonus(i: {
  streak: number;
  multiplier: 0 | 1 | 2;
  enabled: boolean;
}): number {
  if (!i.enabled || i.streak < 2) return 0;
  return (
    SCORING.streakBonusStep * i.multiplier * Math.min(i.streak - 1, SCORING.streakBonusMaxSteps)
  );
}

/** Sort by score desc, then nickname (code-point order), then playerId; assign competition ranks. */
export function rankEntries<T extends { playerId: string; nickname: string; score: number }>(
  entries: T[],
): Array<T & { rank: number }> {
  const sorted = [...entries].sort(
    (a, b) =>
      b.score - a.score ||
      compareCodePoints(a.nickname, b.nickname) ||
      compareCodePoints(a.playerId, b.playerId),
  );
  let rank = 0;
  return sorted.map((entry, index) => {
    if (index === 0 || entry.score !== (sorted[index - 1] as T).score) rank = index + 1;
    return { ...entry, rank };
  });
}
