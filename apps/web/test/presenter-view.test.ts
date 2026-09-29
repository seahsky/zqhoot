import { describe, expect, it } from 'vitest';
import type { HostSnapshot, LiveStats, ServerMessage } from '@zqhoot/protocol';
import { NOW } from '../src/dev/fixtures/common.ts';
import {
  LEADERBOARD,
  LUNCH_RESULT,
  MERCURY_RESULT,
  OFFSITE_RESULT,
  PODIUM,
  RATING_RESULT,
  WALL_RESULT,
  WEATHER_RESULT,
  hostSnapshot,
  openQ,
  openResponses,
  pollQ,
  questionSnapshot,
  ratingQ,
  revealSnapshot,
  roster,
  singleQ,
  trueFalseQ,
  wordCloudQ,
} from '../src/dev/fixtures/hostSnapshots.ts';
import { hostReducer, initialHostState } from '../src/state/host.ts';
import type { HostState } from '../src/state/host.ts';
import { presenterView, visibleNewestFirst } from '../src/state/presenterView.ts';
import type { ChartData } from '../src/state/presenterView.ts';

function stateFor(snap: HostSnapshot, ...more: ServerMessage[]): HostState {
  let s = hostReducer(initialHostState('open'), {
    type: 'message',
    msg: { type: 'welcome', ts: NOW, role: 'host', snapshot: snap },
  });
  for (const msg of more) s = hostReducer(s, { type: 'message', msg });
  return s;
}
const statsMsg = (stats: LiveStats, index = 2): ServerMessage => ({
  type: 'stats',
  ts: NOW,
  questionIndex: index,
  stats,
});
const chartOf = (v: ReturnType<typeof presenterView>): ChartData => {
  if (v.screen !== 'reveal') throw new Error(`expected a reveal, got ${v.screen}`);
  return v.chart;
};

describe('screens by phase', () => {
  it('connecting until a snapshot arrives, and over after a final error', () => {
    expect(presenterView(initialHostState(), NOW)).toEqual({ screen: 'connecting' });
    const ended = hostReducer(stateFor(hostSnapshot()), {
      type: 'message',
      msg: { type: 'error', ts: NOW, code: 'session-ended', message: 'over' },
    });
    expect(presenterView(ended, NOW)).toEqual({ screen: 'over', reason: 'session-ended' });
  });

  it('lobby: the PIN and everyone in the room, newest first', () => {
    const v = presenterView(stateFor(hostSnapshot({ roster: roster(3), locked: true })), NOW);
    expect(v).toMatchObject({ screen: 'lobby', pin: '482915', locked: true });
    if (v.screen !== 'lobby') throw new Error();
    expect(v.names).toEqual(
      roster(3)
        .map((r) => r.nickname)
        .reverse(),
    );
  });

  it('get-ready while now < openAt, counting in whole seconds', () => {
    const v = presenterView(stateFor(questionSnapshot(singleQ, -2_400)), NOW);
    expect(v).toMatchObject({ screen: 'get-ready', secondsUntilOpen: 3 });
  });

  it('open question: a countdown that ends at the deadline, and the answer count', () => {
    const state = stateFor(
      questionSnapshot(singleQ, 5_000),
      statsMsg({ type: 'single', answered: 7, totalPlayers: 22, counts: {} }),
    );
    const v = presenterView(state, NOW);
    expect(v).toMatchObject({
      screen: 'question',
      countdown: { secondsLeft: 15, fraction: 0.75 },
      answered: 7,
      totalPlayers: 22,
    });
  });

  it('before the first stats reply the count is 0 of everybody in the roster', () => {
    const v = presenterView(stateFor(questionSnapshot(singleQ, 5_000)), NOW);
    expect(v).toMatchObject({ screen: 'question', answered: 0, totalPlayers: 22 });
  });

  it('an untimed question has no countdown', () => {
    const v = presenterView(stateFor(questionSnapshot(ratingQ, 5_000)), NOW);
    expect(v).toMatchObject({
      screen: 'question',
      countdown: { secondsLeft: null, fraction: null },
    });
  });

  it("shows the Time's up beat after the deadline, and while the server is revealing", () => {
    const late = presenterView(stateFor(questionSnapshot(singleQ, 20_400)), NOW);
    expect(late.screen).toBe('closing');
    const revealing = presenterView(
      stateFor(questionSnapshot(singleQ, 5_000, { phase: 'revealing' })),
      NOW,
    );
    expect(revealing.screen).toBe('closing');
  });

  it('leaderboard: the top five with rank, score and gain', () => {
    const v = presenterView(
      stateFor(hostSnapshot({ phase: 'leaderboard', questionIndex: 2, leaderboard: LEADERBOARD })),
      NOW,
    );
    if (v.screen !== 'leaderboard') throw new Error();
    expect(v.entries).toHaveLength(5);
    expect(v.entries[0]).toEqual({
      rank: 1,
      playerId: 'player-0001',
      nickname: 'Ana',
      score: 3120,
      delta: 940,
    });
  });

  it('ended: a podium when there are scored results, else a thank-you', () => {
    expect(
      presenterView(
        stateFor(hostSnapshot({ phase: 'ended', questionIndex: 9, podium: PODIUM })),
        NOW,
      ),
    ).toMatchObject({ screen: 'podium', players: 22 });
    expect(
      presenterView(stateFor(hostSnapshot({ phase: 'ended', questionIndex: 9, podium: [] })), NOW),
    ).toMatchObject({ screen: 'thanks', players: 22 });
  });
});

describe('the room never sees the answer or the live distribution before the reveal', () => {
  /** Every string in the view, keys included. */
  const everything = (value: unknown): string => JSON.stringify(value);

  const OPEN_CHOICE = statsMsg({
    type: 'single',
    answered: 377,
    totalPlayers: 400,
    counts: { 'option-mercury': 211, 'option-venus': 88, 'option-earth': 61, 'option-mars': 17 },
  });

  it('single choice: no answer fields, no ids, no counts, no chart', () => {
    const v = presenterView(stateFor(questionSnapshot(singleQ, 5_000), OPEN_CHOICE), NOW);
    expect(v.screen).toBe('question');
    if (v.screen !== 'question') throw new Error();
    expect(v.live).toBeNull();
    const text = everything(v);
    for (const secret of ['correctOptionId', '"correct"', 'option-mercury', '211', '88', '61']) {
      expect(text, secret).not.toContain(secret);
    }
    // The room does see the options, and how many have answered.
    expect(text).toContain('Mercury');
    expect(v.answered).toBe(377);
  });

  it('true/false: no correct side and no split', () => {
    const state = stateFor(
      questionSnapshot(trueFalseQ, 4_000),
      statsMsg({
        type: 'truefalse',
        answered: 20,
        totalPlayers: 32,
        counts: { true: 6, false: 14 },
      }),
    );
    const v = presenterView(state, NOW);
    if (v.screen !== 'question') throw new Error();
    expect(v.live).toBeNull();
    expect(everything(v)).not.toMatch(/"correct"/);
  });

  it('the same holds while the deadline has passed but the server has not said "revealing"', () => {
    const v = presenterView(stateFor(questionSnapshot(singleQ, 20_400), OPEN_CHOICE), NOW);
    expect(v.screen).toBe('closing');
    expect(everything(v)).not.toContain('option-mercury');
    expect(everything(v)).not.toContain('correctOptionId');
  });

  it('shows live results where seeing them is the point: poll, word cloud, open-ended, rating', () => {
    const poll = presenterView(
      stateFor(
        questionSnapshot(pollQ, 5_000),
        statsMsg({
          type: 'poll',
          answered: 10,
          totalPlayers: 22,
          counts: { 'option-cafe': 6, 'option-park': 3, 'option-deli': 1 },
        }),
      ),
      NOW,
    );
    if (poll.screen !== 'question' || poll.live?.kind !== 'bars') throw new Error('poll');
    expect(poll.live.rows.map((r) => r.count)).toEqual([6, 3, 1]);
    expect(poll.live.markCorrect).toBe(false);

    const cloud = presenterView(
      stateFor(
        questionSnapshot(wordCloudQ, 5_000),
        statsMsg({
          type: 'wordcloud',
          answered: 3,
          totalPlayers: 22,
          words: [{ text: 'sunny', count: 3 }],
        }),
      ),
      NOW,
    );
    if (cloud.screen !== 'question' || cloud.live?.kind !== 'cloud') throw new Error('cloud');
    expect(cloud.live.words[0]).toMatchObject({ text: 'sunny', count: 3 });

    const rating = presenterView(
      stateFor(
        questionSnapshot(ratingQ, 5_000),
        statsMsg({
          type: 'rating',
          answered: 4,
          totalPlayers: 22,
          histogram: [0, 1, 1, 2, 0],
          average: 3.5,
        }),
      ),
      NOW,
    );
    if (rating.screen !== 'question' || rating.live?.kind !== 'rating') throw new Error('rating');
    expect(rating.live.average).toBe(3.5);
  });

  it('live open-ended responses show only the visible ones, newest first', () => {
    const all = openResponses();
    const v = presenterView(
      stateFor(
        questionSnapshot(openQ, 5_000),
        statsMsg({ type: 'open', answered: 10, totalPlayers: 22, responses: all, cursor: null }),
      ),
      NOW,
    );
    if (v.screen !== 'question' || v.live?.kind !== 'wall') throw new Error();
    const shown = v.live.responses.map((r) => r.text);
    expect(shown).toHaveLength(all.filter((r) => r.status === 'visible').length);
    for (const r of all.filter((r) => r.status !== 'visible')) expect(shown).not.toContain(r.text);
    expect(shown[0]).toBe(all.filter((r) => r.status === 'visible').at(-1)?.text);
  });
});

describe('reveal', () => {
  it('single choice: bars by letter with counts, percent of answers, and the correct one marked', () => {
    const c = chartOf(presenterView(stateFor(revealSnapshot(singleQ, MERCURY_RESULT)), NOW));
    if (c.kind !== 'bars') throw new Error();
    expect(c.markCorrect).toBe(true);
    expect(c.rows.map((r) => [r.letter, r.label, r.count, r.percent, r.correct])).toEqual([
      ['A', 'Mercury', 14, 47, true],
      ['B', 'Venus', 9, 30, false],
      ['C', 'Earth', 5, 17, false],
      ['D', 'Mars', 2, 7, false],
    ]);
    expect(c.summary).toContain('The correct answer is A Mercury');
  });

  it('true/false: True and False, the right one marked', () => {
    const c = chartOf(presenterView(stateFor(revealSnapshot(trueFalseQ, WALL_RESULT)), NOW));
    if (c.kind !== 'bars') throw new Error();
    expect(c.rows.map((r) => [r.label, r.count, r.correct])).toEqual([
      ['True', 6, false],
      ['False', 22, true],
    ]);
  });

  it('poll: bars, nothing marked correct', () => {
    const c = chartOf(presenterView(stateFor(revealSnapshot(pollQ, LUNCH_RESULT)), NOW));
    if (c.kind !== 'bars') throw new Error();
    expect(c.markCorrect).toBe(false);
    expect(c.rows.some((r) => r.correct)).toBe(false);
    expect(c.summary).not.toMatch(/correct/i);
  });

  it('word cloud: most votes first, sizes never shrink as votes grow', () => {
    const c = chartOf(presenterView(stateFor(revealSnapshot(wordCloudQ, WEATHER_RESULT)), NOW));
    if (c.kind !== 'cloud') throw new Error();
    expect(c.words[0]).toMatchObject({ text: 'busy', count: 12 });
    for (let i = 1; i < c.words.length; i++) {
      const [a, b] = [c.words[i - 1], c.words[i]];
      expect(a && b && a.count >= b.count).toBe(true);
      expect(a && b && a.units >= b.units).toBe(true);
    }
    for (const w of c.words) {
      expect(w.units).toBeGreaterThanOrEqual(4.3);
      expect(w.units).toBeLessThanOrEqual(12);
    }
  });

  it('open-ended: only visible responses, newest first', () => {
    const c = chartOf(presenterView(stateFor(revealSnapshot(openQ, OFFSITE_RESULT)), NOW));
    if (c.kind !== 'wall') throw new Error();
    const visible =
      OFFSITE_RESULT.type === 'open'
        ? OFFSITE_RESULT.responses.filter((r) => r.status === 'visible')
        : [];
    expect(c.responses).toHaveLength(visible.length);
    expect(c.responses.map((r) => r.text)).toEqual([...visible].reverse().map((r) => r.text));
    expect(JSON.stringify(c)).not.toContain('Karaoke');
  });

  it('rating: a histogram whose tallest bar is full height, and the average', () => {
    const c = chartOf(presenterView(stateFor(revealSnapshot(ratingQ, RATING_RESULT)), NOW));
    if (c.kind !== 'rating') throw new Error();
    expect(c.bars.map((b) => b.count)).toEqual([1, 2, 6, 11, 7]);
    expect(Math.max(...c.bars.map((b) => b.height))).toBe(1);
    expect(c.summary).toBe('Average 3.8 of 5 from 27 ratings.');
  });

  it('every chart has a table alternative and a one-sentence summary', () => {
    const cases: Array<[HostSnapshot, number]> = [
      [revealSnapshot(singleQ, MERCURY_RESULT), 4],
      [revealSnapshot(trueFalseQ, WALL_RESULT), 2],
      [revealSnapshot(pollQ, LUNCH_RESULT), 3],
      [
        revealSnapshot(wordCloudQ, WEATHER_RESULT),
        WEATHER_RESULT.type === 'wordcloud' ? WEATHER_RESULT.words.length : 0,
      ],
      [revealSnapshot(ratingQ, RATING_RESULT), 5],
    ];
    for (const [snap, rows] of cases) {
      const c = chartOf(presenterView(stateFor(snap), NOW));
      expect(c.table.rows, snap.question?.question.type).toHaveLength(rows);
      expect(c.table.head.length).toBeGreaterThan(0);
      expect(c.summary.length).toBeGreaterThan(5);
    }
  });

  it('waits for the result rather than showing an empty reveal', () => {
    const snap = revealSnapshot(singleQ, MERCURY_RESULT);
    delete snap.result;
    expect(presenterView(stateFor(snap), NOW).screen).toBe('connecting');
  });
});

describe('visibleNewestFirst', () => {
  it('breaks ties on id so the order is stable', () => {
    const a = { id: 'a-0', text: 'A', status: 'visible' as const, receivedAt: 5 };
    const b = { id: 'b-0', text: 'B', status: 'visible' as const, receivedAt: 5 };
    expect(visibleNewestFirst([a, b]).map((r) => r.id)).toEqual(['b-0', 'a-0']);
    expect(visibleNewestFirst([b, a]).map((r) => r.id)).toEqual(['b-0', 'a-0']);
  });
});
