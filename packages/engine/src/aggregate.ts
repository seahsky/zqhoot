import { LIMITS } from '@zqhoot/protocol';
import type {
  OpenResponseView,
  PollQuestion,
  RatingQuestion,
  SingleChoiceQuestion,
  WordCount,
} from '@zqhoot/protocol';
import type {
  PlayerRecord,
  QuizSnapshot,
  ResponseRecord,
  Scoreboard,
  SessionMeta,
} from './model.ts';
import { isScoringQuestion } from './questions.ts';
import { compareCodePoints } from './util.ts';

/** Responses of non-kicked players plus the head counts every result and live-stat carries. */
export interface Tally {
  responses: ResponseRecord[];
  answered: number;
  totalPlayers: number;
  /** Distinct players with at least one included response. */
  answeredIds: ReadonlySet<string>;
  nicknameOf(playerId: string): string | undefined;
}

export function tally(players: PlayerRecord[], responses: ResponseRecord[]): Tally {
  const active = new Map(players.filter((p) => !p.kicked).map((p) => [p.playerId, p.nickname]));
  const included = responses.filter((r) => active.has(r.playerId));
  const answeredIds = new Set(included.map((r) => r.playerId));
  return {
    responses: included,
    answered: answeredIds.size,
    totalPlayers: active.size,
    answeredIds,
    nicknameOf: (playerId) => active.get(playerId),
  };
}

/**
 * Scoring questions revealed so far (skipped ones never are). While this is 0 every player is
 * tied on zero, so final ranks and a podium would only reflect nickname order.
 */
export function revealedScoredCount(
  meta: SessionMeta,
  snapshot: QuizSnapshot,
  scoreboard: Scoreboard | null,
): number {
  const revealedThrough = scoreboard?.appliedThrough ?? -1;
  return snapshot.questions.filter(
    (q, index) => isScoringQuestion(q) && index <= revealedThrough && !meta.skipped.includes(index),
  ).length;
}

/** The text a text-type response is shown and exported as. */
export function responseText(r: ResponseRecord): string {
  return r.normalizedText ?? (r.payload.kind === 'text' ? r.payload.text : '');
}

export function optionCounts(
  q: SingleChoiceQuestion | PollQuestion,
  t: Tally,
): Record<string, number> {
  // fromEntries defines own properties, so an option id such as "__proto__" stays a plain key.
  const counts: Record<string, number> = Object.fromEntries(q.options.map((o) => [o.id, 0]));
  for (const r of t.responses) {
    if (r.payload.kind === 'choice' && Object.hasOwn(counts, r.payload.optionId)) {
      counts[r.payload.optionId] = (counts[r.payload.optionId] as number) + 1;
    }
  }
  return counts;
}

export function booleanCounts(t: Tally): { true: number; false: number } {
  const counts = { true: 0, false: 0 };
  for (const r of t.responses) {
    if (r.payload.kind === 'boolean') counts[r.payload.value ? 'true' : 'false']++;
  }
  return counts;
}

/** Visible entries only: pending and hidden ones must not reach the projector. */
export function wordCounts(t: Tally): WordCount[] {
  const counts = new Map<string, number>();
  for (const r of t.responses) {
    if (r.status !== 'visible' || r.normalizedText === undefined) continue;
    counts.set(r.normalizedText, (counts.get(r.normalizedText) ?? 0) + 1);
  }
  return Array.from(counts, ([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || compareCodePoints(a.text, b.text))
    .slice(0, LIMITS.wordCloudTopN);
}

export function compareByArrival(
  a: { receivedAt: number; id: string },
  b: { receivedAt: number; id: string },
): number {
  return a.receivedAt - b.receivedAt || compareCodePoints(a.id, b.id);
}

/** Host view: every status, with nicknames, oldest first. */
export function openViews(t: Tally): OpenResponseView[] {
  return t.responses
    .map((r) => {
      const view: OpenResponseView = {
        id: r.responseId,
        text: responseText(r),
        status: r.status,
        receivedAt: r.receivedAt,
      };
      const nickname = t.nicknameOf(r.playerId);
      if (nickname !== undefined) view.nickname = nickname;
      return view;
    })
    .sort(compareByArrival);
}

export function ratingStats(
  q: RatingQuestion,
  t: Tally,
): { histogram: number[]; average: number | null } {
  const histogram = new Array<number>(q.max).fill(0);
  let sum = 0;
  let count = 0;
  for (const r of t.responses) {
    if (r.payload.kind !== 'rating' || r.payload.value < 1 || r.payload.value > q.max) continue;
    histogram[r.payload.value - 1] = (histogram[r.payload.value - 1] as number) + 1;
    sum += r.payload.value;
    count++;
  }
  return { histogram, average: count === 0 ? null : Math.round((sum / count) * 100) / 100 };
}
