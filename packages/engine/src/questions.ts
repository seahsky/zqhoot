import type { PointsMultiplier, PublicQuestion, Question, QuizSettings } from '@zqhoot/protocol';

/**
 * The only projection of a question that players may receive. Built field by field (never by
 * deleting from the full question) so a field added to `Question` later cannot leak.
 */
export function toPublicQuestion(q: Question, settings: QuizSettings): PublicQuestion {
  const common = {
    id: q.id,
    timeLimitSec: q.timeLimitSec,
    ...(settings.showQuestionOnDevices ? { prompt: q.prompt } : {}),
    ...(q.imageKey !== undefined ? { imageKey: q.imageKey } : {}),
  };
  switch (q.type) {
    case 'single':
      return {
        ...common,
        type: 'single',
        options: q.options.map((o) => ({ id: o.id, text: o.text })),
        points: q.points,
      };
    case 'truefalse':
      return { ...common, type: 'truefalse', points: q.points };
    case 'poll':
      return {
        ...common,
        type: 'poll',
        options: q.options.map((o) => ({ id: o.id, text: o.text })),
      };
    case 'wordcloud':
      return { ...common, type: 'wordcloud', maxEntries: q.maxEntries };
    case 'open':
      return { ...common, type: 'open', maxEntries: q.maxEntries };
    case 'rating':
      return {
        ...common,
        type: 'rating',
        max: q.max,
        ...(q.minLabel !== undefined ? { minLabel: q.minLabel } : {}),
        ...(q.maxLabel !== undefined ? { maxLabel: q.maxLabel } : {}),
      };
  }
}

export function questionLimitMs(q: Question): number | null {
  return q.timeLimitSec === null ? null : q.timeLimitSec * 1000;
}

/** Multiplier of a scored type; 0 for types that never award points. */
export function pointsMultiplier(q: Question): PointsMultiplier {
  return q.type === 'single' || q.type === 'truefalse' ? q.points : 0;
}

/** Scored type AND a points multiplier above 0 (multiplier 0 makes a scored type behave like a poll). */
export function isScoringQuestion(q: Question): boolean {
  return pointsMultiplier(q) > 0;
}
