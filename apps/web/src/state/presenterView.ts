import { LIMITS } from '@zqhoot/protocol';
import type {
  LeaderboardEntry,
  LiveStats,
  OpenResponseView,
  Question,
  QuestionResult,
  QuestionType,
  WordCount,
} from '@zqhoot/protocol';
import { SLOTS } from '../ui/slots.ts';
import { barRow, formatAverage, ratingBars, sizeWords } from './charts.ts';
import type { BarRow, RatingBar, SizedWord } from './charts.ts';
import type { HostEnd, HostState } from './host.ts';

/**
 * What the projector shows, worked out from the host state and the (estimated server) time.
 *
 * Hosts receive the correct answer and the live distribution while a question is open; the
 * room must never see them. The question is therefore rebuilt field by field into
 * `PresentQuestion`, which has nowhere to put an answer, and live figures are only turned into
 * charts for the types where seeing them is the point (poll, word cloud, open-ended, rating).
 * The unit tests search the result for the answer fields.
 */

export interface PresentOption {
  /** 0-5: fixes the letter, glyph and colour. */
  slot: number;
  text: string;
}

export interface PresentQuestion {
  index: number;
  total: number;
  type: QuestionType;
  prompt: string;
  imageKey: string | null;
  /** Options of a choice question; True and False for a true/false one; empty otherwise. */
  options: PresentOption[];
  /** Seconds players have; null when the question is untimed. */
  timeLimitSec: number | null;
  /** Entries per player for a word cloud or open-ended question. */
  maxEntries: number | null;
  rating: { max: number; minLabel: string | null; maxLabel: string | null } | null;
}

export interface ChartTable {
  caption: string;
  head: string[];
  rows: string[][];
}

interface ChartBase {
  /** One sentence for the `role="status"` line. */
  summary: string;
  /** The same numbers as a visually hidden table. */
  table: ChartTable;
}

export type ChartData = ChartBase &
  (
    | { kind: 'bars'; rows: BarRow[]; answered: number; markCorrect: boolean }
    | { kind: 'cloud'; words: SizedWord[] }
    | { kind: 'wall'; responses: Array<{ id: string; text: string }> }
    | {
        kind: 'rating';
        max: number;
        bars: RatingBar[];
        average: number | null;
        count: number;
        minLabel: string | null;
        maxLabel: string | null;
      }
  );

export interface Countdown {
  /** Whole seconds, rounded up; null when untimed. */
  secondsLeft: number | null;
  /** 1 at opening down to 0 at the deadline; null when untimed. */
  fraction: number | null;
}

export interface StandingRow {
  rank: number;
  playerId: string;
  nickname: string;
  score: number;
  delta: number;
}

export type PresenterView =
  | { screen: 'connecting' }
  | {
      screen: 'lobby';
      quizTitle: string;
      pin: string;
      locked: boolean;
      /** Everyone in the room, newest first. */
      names: string[];
    }
  | { screen: 'get-ready'; q: PresentQuestion; secondsUntilOpen: number }
  | {
      screen: 'question';
      q: PresentQuestion;
      countdown: Countdown;
      answered: number;
      totalPlayers: number;
      /** Only for the types where the room may watch answers arrive. */
      live: ChartData | null;
    }
  /** Answers are closed; the result is being worked out (about a second on Lambda). */
  | { screen: 'closing'; q: PresentQuestion; answered: number; totalPlayers: number }
  | {
      screen: 'reveal';
      q: PresentQuestion;
      chart: ChartData;
      answered: number;
      totalPlayers: number;
    }
  | { screen: 'leaderboard'; index: number; total: number; entries: StandingRow[] }
  | { screen: 'podium'; quizTitle: string; players: number; podium: StandingRow[] }
  | { screen: 'thanks'; quizTitle: string; players: number }
  | { screen: 'over'; reason: HostEnd };

export type PresenterScreen = PresenterView['screen'];

// ---------------------------------------------------------------------------
// Question
// ---------------------------------------------------------------------------

const TRUE_FALSE: PresentOption[] = [
  { slot: 0, text: 'True' },
  { slot: 1, text: 'False' },
];

/** Built field by field: a field added to `Question` later cannot leak into the room. */
export function presentQuestion(q: Question, index: number, total: number): PresentQuestion {
  const base = {
    index,
    total,
    type: q.type,
    prompt: q.prompt,
    imageKey: q.imageKey ?? null,
    timeLimitSec: q.timeLimitSec,
    options: [] as PresentOption[],
    maxEntries: null as number | null,
    rating: null as PresentQuestion['rating'],
  };
  switch (q.type) {
    case 'single':
    case 'poll':
      return { ...base, options: q.options.map((o, slot) => ({ slot, text: o.text })) };
    case 'truefalse':
      return { ...base, options: TRUE_FALSE };
    case 'wordcloud':
    case 'open':
      return { ...base, maxEntries: q.maxEntries };
    case 'rating':
      return {
        ...base,
        rating: { max: q.max, minLabel: q.minLabel ?? null, maxLabel: q.maxLabel ?? null },
      };
  }
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

const optionLabel = (slot: number, text: string) => `${SLOTS[slot]?.letter ?? ''} ${text}`;

function barsChart(
  q: Question,
  rows: BarRow[],
  answered: number,
  markCorrect: boolean,
): Extract<ChartData, { kind: 'bars' }> {
  const parts = rows.map(
    (r) =>
      `${optionLabel(r.slot, r.label)}: ${r.count} (${r.percent}%)${r.correct ? ', correct' : ''}`,
  );
  const correct = rows.find((r) => r.correct);
  const summary =
    `${answered} ${answered === 1 ? 'answer' : 'answers'}. ${parts.join('. ')}.` +
    (markCorrect && correct
      ? ` The correct answer is ${optionLabel(correct.slot, correct.label)}.`
      : '');
  return {
    kind: 'bars',
    rows,
    answered,
    markCorrect,
    summary,
    table: {
      caption: `Answers to: ${q.prompt}`,
      head: ['Answer', 'Text', 'Count', 'Percent', ...(markCorrect ? ['Correct'] : [])],
      rows: rows.map((r) => [
        r.letter,
        r.label,
        String(r.count),
        `${r.percent}%`,
        ...(markCorrect ? [r.correct ? 'Yes' : 'No'] : []),
      ]),
    },
  };
}

function cloudChart(q: Question, words: readonly WordCount[]) {
  const sized = sizeWords(words);
  const top = sized[0];
  return {
    kind: 'cloud' as const,
    words: sized,
    summary:
      sized.length === 0
        ? 'No words yet.'
        : `${sized.length} ${sized.length === 1 ? 'word' : 'words'}. Most votes: ${top?.text}, ${top?.count}.`,
    table: {
      caption: `Words for: ${q.prompt}`,
      head: ['Word', 'Votes'],
      rows: sized.map((w) => [w.text, String(w.count)]),
    },
  };
}

/** Newest first; pending and hidden responses never reach the room. */
export function visibleNewestFirst(
  responses: readonly OpenResponseView[],
): Array<{ id: string; text: string }> {
  return responses
    .filter((r) => r.status === 'visible')
    .sort((a, b) => b.receivedAt - a.receivedAt || (a.id < b.id ? 1 : -1))
    .map((r) => ({ id: r.id, text: r.text }));
}

function wallChart(q: Question, responses: readonly OpenResponseView[]) {
  const shown = visibleNewestFirst(responses);
  return {
    kind: 'wall' as const,
    responses: shown,
    summary:
      shown.length === 0
        ? 'No responses on the screen yet.'
        : `${shown.length} ${shown.length === 1 ? 'response' : 'responses'} on the screen.`,
    table: {
      caption: `Responses to: ${q.prompt}`,
      head: ['Response'],
      rows: shown.map((r) => [r.text]),
    },
  };
}

function ratingChart(q: Question, histogram: readonly number[], average: number | null): ChartData {
  const max = q.type === 'rating' ? q.max : histogram.length;
  const bars = ratingBars(histogram);
  const count = histogram.reduce((n, c) => n + c, 0);
  return {
    kind: 'rating',
    max,
    bars,
    average,
    count,
    minLabel: q.type === 'rating' ? (q.minLabel ?? null) : null,
    maxLabel: q.type === 'rating' ? (q.maxLabel ?? null) : null,
    summary:
      average === null
        ? 'No ratings yet.'
        : `Average ${formatAverage(average)} of ${max} from ${count} ${count === 1 ? 'rating' : 'ratings'}.`,
    table: {
      caption: `Ratings for: ${q.prompt}`,
      head: ['Rating', 'Count'],
      rows: bars.map((b) => [String(b.value), String(b.count)]),
    },
  };
}

/**
 * The chart for a question that is still open, or null when the room must not see one. Single
 * choice and true/false stay dark until the reveal: the answer count is all that shows.
 */
export function liveChart(
  q: Question,
  stats: LiveStats | null,
  responses: readonly OpenResponseView[],
): ChartData | null {
  switch (q.type) {
    case 'single':
    case 'truefalse':
      return null;
    case 'poll': {
      const counts = stats?.type === 'poll' ? stats.counts : {};
      const answered = stats?.answered ?? 0;
      return barsChart(
        q,
        q.options.map((o, slot) => barRow(slot, o.text, counts[o.id] ?? 0, answered)),
        answered,
        false,
      );
    }
    case 'wordcloud':
      return cloudChart(q, stats?.type === 'wordcloud' ? stats.words : []);
    case 'open':
      return wallChart(q, responses);
    case 'rating': {
      const histogram =
        stats?.type === 'rating' ? stats.histogram : new Array<number>(q.max).fill(0);
      return ratingChart(q, histogram, stats?.type === 'rating' ? stats.average : null);
    }
  }
}

/** The chart of a closed question, with the correct answer marked for the two scored types. */
export function resultChart(q: Question, result: QuestionResult): ChartData | null {
  switch (result.type) {
    case 'single': {
      if (q.type !== 'single') return null;
      return barsChart(
        q,
        q.options.map((o, slot) =>
          barRow(
            slot,
            o.text,
            result.counts[o.id] ?? 0,
            result.answered,
            o.id === result.correctOptionId,
          ),
        ),
        result.answered,
        true,
      );
    }
    case 'truefalse':
      return barsChart(
        q,
        [
          barRow(0, 'True', result.counts.true, result.answered, result.correct),
          barRow(1, 'False', result.counts.false, result.answered, !result.correct),
        ],
        result.answered,
        true,
      );
    case 'poll': {
      if (q.type !== 'poll') return null;
      return barsChart(
        q,
        q.options.map((o, slot) => barRow(slot, o.text, result.counts[o.id] ?? 0, result.answered)),
        result.answered,
        false,
      );
    }
    case 'wordcloud':
      return cloudChart(q, result.words);
    case 'open':
      return wallChart(q, result.responses);
    case 'rating':
      return ratingChart(q, result.histogram, result.average);
  }
}

// ---------------------------------------------------------------------------
// The whole screen
// ---------------------------------------------------------------------------

function timerFor(openAt: number, deadline: number | null, now: number): Countdown {
  if (deadline === null) return { secondsLeft: null, fraction: null };
  const remaining = Math.max(0, deadline - now);
  const span = Math.max(1, deadline - openAt);
  return { secondsLeft: Math.ceil(remaining / 1000), fraction: Math.min(1, remaining / span) };
}

function standing(e: LeaderboardEntry): StandingRow {
  return {
    rank: e.rank,
    playerId: e.playerId,
    nickname: e.nickname,
    score: e.score,
    delta: e.delta,
  };
}

export function presenterView(state: HostState, now: number): PresenterView {
  if (state.ended !== null) return { screen: 'over', reason: state.ended };
  const snap = state.snapshot;
  if (snap === null) return { screen: 'connecting' };

  const total = snap.totalQuestions;
  const players = state.roster.length;
  const hosted = snap.question;

  switch (snap.phase) {
    case 'lobby':
      return {
        screen: 'lobby',
        quizTitle: snap.quizTitle,
        pin: snap.pin,
        locked: snap.locked,
        names: state.roster.map((r) => r.nickname).reverse(),
      };

    case 'question':
    case 'revealing': {
      if (!hosted) return { screen: 'connecting' };
      const q = presentQuestion(hosted.question, snap.questionIndex, total);
      const stats = state.live?.stats ?? null;
      const answered = stats?.answered ?? 0;
      const totalPlayers = stats?.totalPlayers ?? players;
      if (snap.phase === 'revealing') return { screen: 'closing', q, answered, totalPlayers };
      if (now < hosted.openAt) {
        return {
          screen: 'get-ready',
          q,
          secondsUntilOpen: Math.max(1, Math.ceil((hosted.openAt - now) / 1000)),
        };
      }
      // The deadline has passed and the server has not yet said "revealing".
      if (hosted.deadline !== null && now > hosted.deadline) {
        return { screen: 'closing', q, answered, totalPlayers };
      }
      return {
        screen: 'question',
        q,
        countdown: timerFor(hosted.openAt, hosted.deadline, now),
        answered,
        totalPlayers,
        live: liveChart(hosted.question, stats, state.live?.responses ?? []),
      };
    }

    case 'reveal': {
      if (!hosted || !snap.result) return { screen: 'connecting' };
      const chart = resultChart(hosted.question, snap.result);
      if (!chart) return { screen: 'connecting' };
      return {
        screen: 'reveal',
        q: presentQuestion(hosted.question, snap.questionIndex, total),
        chart,
        answered: snap.result.answered,
        totalPlayers: snap.result.totalPlayers,
      };
    }

    case 'leaderboard':
      return {
        screen: 'leaderboard',
        index: snap.questionIndex,
        total,
        entries: (snap.leaderboard ?? []).slice(0, LIMITS.leaderboardSize).map(standing),
      };

    case 'ended': {
      const podium = (snap.podium ?? []).map(standing);
      // No scored question was revealed, so there is nobody to put on a podium.
      return podium.length > 0
        ? { screen: 'podium', quizTitle: snap.quizTitle, players, podium }
        : { screen: 'thanks', quizTitle: snap.quizTitle, players };
    }
  }
}
