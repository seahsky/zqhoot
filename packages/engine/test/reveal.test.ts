import { describe, expect, it } from 'vitest';
import { LIMITS } from '@zqhoot/protocol';
import type { AnswerPayload, QuestionResult } from '@zqhoot/protocol';
import {
  computeReveal,
  refreshModeration,
  revealFromStored,
  toPlayerResult,
} from '../src/index.ts';
import type { PlayerRecord, ResponseRecord, Scoreboard } from '../src/index.ts';
import {
  NOW,
  Q,
  accept,
  board,
  newSession,
  openAtIndex,
  pid,
  player,
  response,
  revealingAt,
  validServerMessage,
} from './helpers.ts';

const NAMES = ['Alice', 'Bob', 'Cara', 'Dan', 'Eve'];
const players = (): PlayerRecord[] =>
  NAMES.map((nickname, i) => player(i + 1, { nickname, kicked: i === 4 }));

const choice = (optionId: string): AnswerPayload => ({ kind: 'choice', optionId });
const bool = (value: boolean): AnswerPayload => ({ kind: 'boolean', value });
const text = (t: string): AnswerPayload => ({ kind: 'text', text: t });
const rating = (value: number): AnswerPayload => ({ kind: 'rating', value });

type Answer = [playerNo: number, payload: AnswerPayload, elapsedMs: number];

/** Runs each answer through the real evaluator so records look exactly like production ones. */
function play(
  s: ReturnType<typeof newSession>,
  index: number,
  answers: Answer[],
): ResponseRecord[] {
  const open = openAtIndex(s, index);
  const byPlayer = new Map<number, ResponseRecord[]>();
  const all: ResponseRecord[] = [];
  for (const [no, payload, elapsed] of answers) {
    const existing = byPlayer.get(no) ?? [];
    const r = accept(s, open, pid(no), payload, (open.openAt as number) + elapsed, existing);
    byPlayer.set(no, [...existing, r]);
    all.push(r);
  }
  return all;
}

function reveal(
  s: ReturnType<typeof newSession>,
  index: number,
  responses: ResponseRecord[],
  prior: Scoreboard | null = null,
  ps: PlayerRecord[] = players(),
) {
  return computeReveal({
    meta: revealingAt(s, index),
    snapshot: s.snapshot,
    responses,
    players: ps,
    scoreboard: prior,
    now: NOW + 99_000,
  });
}

const s = newSession();

describe('computeReveal: a scored single-choice question', () => {
  const responses = play(s, Q.single, [
    [1, choice('opt-paris'), 0],
    [2, choice('opt-paris'), 10_125],
    [3, choice('opt-rome'), 500],
    [5, choice('opt-paris'), 0], // kicked
  ]);
  const out = reveal(s, Q.single, responses);

  it('moves to reveal and bumps the version', () => {
    const before = revealingAt(s, Q.single);
    expect(out.meta).toEqual({ ...before, phase: 'reveal', version: before.version + 1 });
  });

  it('builds the host result with every option present and kicked players excluded', () => {
    expect(out.hostResult).toEqual({
      type: 'single',
      answered: 3,
      totalPlayers: 4,
      correctOptionId: 'opt-paris',
      counts: { 'opt-paris': 2, 'opt-rome': 1, 'opt-oslo': 0 },
    });
  });

  it('scores base points and ranks players', () => {
    expect(out.scoreboard).toEqual({
      sessionId: 'sess-0001',
      version: 1,
      appliedThrough: Q.single,
      players: {
        [pid(1)]: {
          score: 1000,
          streak: 1,
          correct: 1,
          answeredScored: 1,
          lastDelta: 1000,
          lastRank: 1,
        },
        [pid(2)]: {
          score: 700,
          streak: 1,
          correct: 1,
          answeredScored: 1,
          lastDelta: 700,
          lastRank: 2,
        },
        [pid(3)]: { score: 0, streak: 0, correct: 0, answeredScored: 1, lastDelta: 0, lastRank: 3 },
        [pid(4)]: { score: 0, streak: 0, correct: 0, answeredScored: 0, lastDelta: 0, lastRank: 3 },
      },
    });
  });

  it('records a per-player outcome for everyone still in the game', () => {
    expect(Object.keys(out.stored.outcomes).sort()).toEqual([pid(1), pid(2), pid(3), pid(4)]);
    expect(out.stored.outcomes[pid(1)]).toEqual({
      answered: true,
      correct: true,
      points: 1000,
      streakBonus: 0,
      score: 1000,
      rank: 1,
      streak: 1,
    });
    expect(out.stored.outcomes[pid(3)]).toEqual({
      answered: true,
      correct: false,
      points: 0,
      streakBonus: 0,
      score: 0,
      rank: 3,
      streak: 0,
    });
    expect(out.stored.outcomes[pid(4)]).toEqual({
      answered: false,
      correct: false,
      points: 0,
      streakBonus: 0,
      score: 0,
      rank: 3,
      streak: 0,
    });
  });

  it('stores the result with the close and compute times', () => {
    expect(out.stored).toMatchObject({
      sessionId: 'sess-0001',
      questionIndex: Q.single,
      closedAt: revealingAt(s, Q.single).closedAt,
      computedAt: NOW + 99_000,
      result: out.hostResult,
    });
  });

  it('sends one reveal per non-kicked player, stamped with the new version', () => {
    expect(out.playerMessages.map((m) => m.playerId)).toEqual([pid(1), pid(2), pid(3), pid(4)]);
    for (const m of out.playerMessages) {
      expect(m.message).toEqual({
        type: 'reveal',
        sv: out.meta.version,
        index: Q.single,
        result: out.hostResult,
        you: out.stored.outcomes[m.playerId],
      });
      expect(validServerMessage(m.message)).toBe(true);
    }
  });

  it('does not touch its inputs', () => {
    const prior = board({ [pid(1)]: { score: 5, streak: 1 } }, -1);
    const meta = revealingAt(s, Q.single);
    const before = JSON.stringify([meta, responses, players(), prior]);
    computeReveal({
      meta,
      snapshot: s.snapshot,
      responses,
      players: players(),
      scoreboard: prior,
      now: NOW,
    });
    expect(JSON.stringify([meta, responses, players(), prior])).toBe(before);
  });
});

describe('computeReveal: streaks and the streak bonus', () => {
  const run = (streakBonus: boolean) => {
    const t = newSession(undefined, { streakBonus });
    // q0 single m1, q1 truefalse m2, q2 poll (unscored), q6 single m0, q7 truefalse m1.
    let prior: Scoreboard | null = null;
    const outs = [];
    const rounds: Array<[number, Answer[]]> = [
      [
        Q.single,
        [
          [1, choice('opt-paris'), 0],
          [2, choice('opt-paris'), 0],
          [3, choice('opt-paris'), 0],
        ],
      ],
      [
        Q.truefalse,
        [
          [1, bool(false), 0],
          [2, bool(true), 0],
        ],
      ], // P3 does not answer
      [Q.poll, [[1, choice('opt-red'), 0]]],
      [Q.zeroPoints, [[1, choice('opt-no'), 0]]],
      [
        Q.lastScored,
        [
          [1, bool(true), 0],
          [2, bool(true), 0],
          [3, bool(true), 0],
        ],
      ],
    ];
    for (const [index, answers] of rounds) {
      const out = reveal(t, index, play(t, index, answers), prior);
      outs.push(out);
      prior = out.scoreboard;
    }
    return outs;
  };

  it('adds 100 x m x min(streak - 1, 3) from the second consecutive correct answer', () => {
    const [r0, r1, r2, r3, r4] = run(true);
    expect(r0!.stored.outcomes[pid(1)]).toMatchObject({ points: 1000, streakBonus: 0, streak: 1 });
    // Double-points question, streak 2: 2000 + 100 * 2 * 1.
    expect(r1!.stored.outcomes[pid(1)]).toMatchObject({
      points: 2000,
      streakBonus: 200,
      streak: 2,
      score: 3200,
    });
    // Unscored and zero-point questions leave streaks and scores alone.
    expect(r2!.scoreboard.players[pid(1)]).toEqual(r1!.scoreboard.players[pid(1)]);
    expect(r3!.scoreboard.players[pid(1)]).toEqual(r1!.scoreboard.players[pid(1)]);
    // Streak 3 on a m1 question: 1000 + 100 * 1 * 2.
    expect(r4!.stored.outcomes[pid(1)]).toMatchObject({
      points: 1000,
      streakBonus: 200,
      streak: 3,
      score: 4400,
    });
  });

  it('resets on a wrong answer and on no answer', () => {
    const [, r1, , , r4] = run(true);
    // P2 answered wrong on q1: streak 0, so no bonus on q7 (streak 1).
    expect(r1!.stored.outcomes[pid(2)]).toMatchObject({
      correct: false,
      points: 0,
      streakBonus: 0,
      streak: 0,
    });
    expect(r4!.stored.outcomes[pid(2)]).toMatchObject({ points: 1000, streakBonus: 0, streak: 1 });
    // P3 skipped q1: same.
    expect(r1!.stored.outcomes[pid(3)]).toMatchObject({ answered: false, streak: 0 });
    expect(r4!.stored.outcomes[pid(3)]).toMatchObject({ streakBonus: 0, streak: 1 });
  });

  it('gives no bonus when the quiz setting is off', () => {
    const outs = run(false);
    for (const out of outs) {
      for (const outcome of Object.values(out.stored.outcomes)) expect(outcome.streakBonus).toBe(0);
    }
    expect(outs[1]!.stored.outcomes[pid(1)]).toMatchObject({
      points: 2000,
      streak: 2,
      score: 3000,
    });
    expect(outs[4]!.stored.outcomes[pid(1)]).toMatchObject({ score: 4000, streak: 3 });
  });

  it('keeps lastDelta and lastRank from the latest scored question only', () => {
    const [, r1, r2, r3] = run(true);
    expect(r1!.scoreboard.players[pid(1)]).toMatchObject({ lastDelta: 2200, lastRank: 1 });
    expect(r2!.scoreboard.players[pid(1)]).toMatchObject({ lastDelta: 2200, lastRank: 1 });
    expect(r3!.scoreboard.players[pid(1)]).toMatchObject({ lastDelta: 2200, lastRank: 1 });
  });
});

describe('computeReveal: unscored questions', () => {
  const prior = board(
    {
      [pid(1)]: {
        score: 1000,
        streak: 1,
        correct: 1,
        answeredScored: 1,
        lastDelta: 1000,
        lastRank: 1,
      },
      [pid(2)]: {
        score: 700,
        streak: 2,
        correct: 1,
        answeredScored: 1,
        lastDelta: 700,
        lastRank: 2,
      },
    },
    Q.truefalse,
    4,
  );

  it.each([
    ['poll', Q.poll, [[1, choice('opt-red'), 100]] as Answer[]],
    ['word cloud', Q.wordcloud, [[1, text('sunny'), 100]] as Answer[]],
    ['open-ended', Q.open, [[1, text('a long answer'), 100]] as Answer[]],
    ['rating', Q.rating, [[1, rating(4), 100]] as Answer[]],
    ['zero-point single', Q.zeroPoints, [[1, choice('opt-yes'), 100]] as Answer[]],
  ])('%s keeps scores, streaks and ranks but advances appliedThrough', (_name, index, answers) => {
    const out = reveal(s, index, play(s, index, answers), prior);
    expect(out.scoreboard.players).toEqual(prior.players);
    expect(out.scoreboard.appliedThrough).toBe(index);
    expect(out.scoreboard.version).toBe(5);
    expect(out.stored.outcomes[pid(1)]).toEqual({
      answered: true,
      points: 0,
      streakBonus: 0,
      score: 1000,
      rank: 1,
      streak: 1,
    });
    expect('correct' in (out.stored.outcomes[pid(2)] ?? {})).toBe(false);
    expect(out.stored.outcomes[pid(2)]).toMatchObject({
      answered: false,
      score: 700,
      rank: 2,
      streak: 2,
    });
  });

  it('uses zero score and no rank for players the scoreboard has never seen', () => {
    const out = reveal(s, Q.poll, []);
    expect(out.scoreboard.players).toEqual({});
    expect(out.stored.outcomes[pid(1)]).toEqual({
      answered: false,
      points: 0,
      streakBonus: 0,
      score: 0,
      rank: null,
      streak: 0,
    });
  });
});

describe('computeReveal: players', () => {
  it('excludes kicked players from counts, ranks and messages but leaves their scoreboard entry alone', () => {
    const prior = board(
      { [pid(1)]: { score: 300, lastRank: 2 }, [pid(5)]: { score: 900, lastRank: 1 } },
      -1,
    );
    const responses = play(s, Q.single, [
      [1, choice('opt-paris'), 0],
      [5, choice('opt-paris'), 0],
    ]);
    const out = reveal(s, Q.single, responses, prior);
    expect(out.hostResult).toMatchObject({ answered: 1, totalPlayers: 4 });
    expect(out.scoreboard.players[pid(5)]).toEqual(prior.players[pid(5)]);
    expect(out.scoreboard.players[pid(1)]).toMatchObject({ score: 1300, lastRank: 1 });
    expect(out.stored.outcomes[pid(5)]).toBeUndefined();
    expect(out.playerMessages.some((m) => m.playerId === pid(5))).toBe(false);
  });

  it('adds a late joiner to the scoreboard with zeros', () => {
    const prior = board(
      {
        [pid(1)]: {
          score: 1000,
          streak: 1,
          correct: 1,
          answeredScored: 1,
          lastDelta: 1000,
          lastRank: 1,
        },
      },
      Q.single,
    );
    const late = player(6, { nickname: 'Zed', joinedAt: NOW + 20_000 });
    const withLate = [...players(), late];
    const responses = play(s, Q.truefalse, [
      [1, bool(false), 0],
      [6, bool(false), 0],
    ]);
    const out = reveal(s, Q.truefalse, responses, prior, withLate);
    expect(out.scoreboard.players[pid(6)]).toEqual({
      score: 2000,
      streak: 1,
      correct: 1,
      answeredScored: 1,
      lastDelta: 2000,
      lastRank: 2,
    });
    // Players who never answered anything still get an entry, so ranks cover everybody.
    expect(out.scoreboard.players[pid(2)]).toEqual({
      score: 0,
      streak: 0,
      correct: 0,
      answeredScored: 0,
      lastDelta: 0,
      lastRank: 3,
    });
    expect(out.playerMessages).toHaveLength(5);
  });

  it('ranks ties with competition ranks in nickname order', () => {
    const responses = play(s, Q.single, [
      [1, choice('opt-paris'), 0],
      [2, choice('opt-paris'), 0],
      [3, choice('opt-paris'), 20_000],
    ]);
    const out = reveal(s, Q.single, responses);
    expect(
      ['1', '2', '3', '4'].map((n) => out.scoreboard.players[pid(Number(n))]?.lastRank),
    ).toEqual([1, 1, 3, 4]);
  });

  it('ignores responses to other questions', () => {
    const wrongQuestion = response(openAtIndex(s, Q.truefalse), pid(1), bool(false), {
      questionIndex: Q.truefalse,
      correct: true,
      points: 2000,
    });
    const out = reveal(s, Q.single, [wrongQuestion]);
    expect(out.hostResult).toMatchObject({ answered: 0 });
    expect(out.scoreboard.players[pid(1)]?.score).toBe(0);
  });
});

describe('computeReveal: result by question type', () => {
  it('truefalse', () => {
    const out = reveal(
      s,
      Q.truefalse,
      play(s, Q.truefalse, [
        [1, bool(true), 0],
        [2, bool(false), 0],
        [3, bool(false), 0],
      ]),
    );
    expect(out.hostResult).toEqual({
      type: 'truefalse',
      answered: 3,
      totalPlayers: 4,
      correct: false,
      counts: { true: 1, false: 2 },
    });
    expect(out.stored.outcomes[pid(2)]).toMatchObject({ correct: true, points: 2000 });
  });

  it('poll includes zero counts', () => {
    const out = reveal(s, Q.poll, play(s, Q.poll, [[1, choice('opt-blue'), 0]]));
    expect(out.hostResult).toEqual({
      type: 'poll',
      answered: 1,
      totalPlayers: 4,
      counts: { 'opt-red': 0, 'opt-blue': 1 },
    });
  });

  it('rating: histogram, average rounded to two decimals, null when empty', () => {
    const out = reveal(
      s,
      Q.rating,
      play(s, Q.rating, [
        [1, rating(1), 0],
        [2, rating(2), 0],
        [3, rating(2), 0],
      ]),
    );
    expect(out.hostResult).toEqual({
      type: 'rating',
      answered: 3,
      totalPlayers: 4,
      histogram: [1, 2, 0, 0, 0],
      average: 1.67,
    });
    expect(reveal(s, Q.rating, []).hostResult).toMatchObject({
      histogram: [0, 0, 0, 0, 0],
      average: null,
    });
    const third = reveal(
      s,
      Q.rating,
      play(s, Q.rating, [
        [1, rating(1), 0],
        [2, rating(1), 0],
        [3, rating(2), 0],
      ]),
    );
    expect(third.hostResult).toMatchObject({ average: 1.33 });
  });

  describe('word cloud', () => {
    const meta = openAtIndex(s, Q.wordcloud);
    const word = (
      no: number,
      slot: number,
      t: string,
      status: ResponseRecord['status'] = 'visible',
    ) =>
      response(meta, pid(no), text(t), {
        slot,
        responseId: `${pid(no)}-${slot}`,
        normalizedText: t,
        status,
      });

    it('counts visible words only, most frequent first, ties by text', () => {
      const out = reveal(s, Q.wordcloud, [
        word(1, 0, 'banana'),
        word(2, 0, 'banana'),
        word(3, 0, 'banana'),
        word(1, 1, 'apple'),
        word(2, 1, 'apple'),
        word(3, 1, 'apple'),
        word(4, 0, 'cherry'),
        word(1, 2, 'rude', 'hidden'),
        word(2, 2, 'rude', 'hidden'),
        word(3, 2, 'pending', 'pending'),
      ]);
      expect(out.hostResult).toEqual({
        type: 'wordcloud',
        answered: 4,
        totalPlayers: 4,
        words: [
          { text: 'apple', count: 3 },
          { text: 'banana', count: 3 },
          { text: 'cherry', count: 1 },
        ],
      });
    });

    it('keeps only the top 60', () => {
      const many = Array.from({ length: 70 }, (_, i) =>
        word(1, i, `w${String(i).padStart(2, '0')}`),
      ).concat([word(2, 0, 'w69')]);
      const out = reveal(s, Q.wordcloud, many);
      if (out.hostResult.type !== 'wordcloud') throw new Error('type');
      expect(out.hostResult.words).toHaveLength(60);
      expect(out.hostResult.words[0]).toEqual({ text: 'w69', count: 2 });
      expect(out.hostResult.words[1]).toEqual({ text: 'w00', count: 1 });
      expect(out.hostResult.words[59]).toEqual({ text: 'w58', count: 1 });
    });

    it('counts a player with several entries once in answered', () => {
      const out = reveal(s, Q.wordcloud, [word(1, 0, 'a1'), word(1, 1, 'b1'), word(1, 2, 'c1')]);
      expect(out.hostResult).toMatchObject({ answered: 1 });
      expect(out.stored.outcomes[pid(1)]).toMatchObject({ answered: true });
    });
  });

  describe('open-ended', () => {
    const meta = openAtIndex(s, Q.open);
    const open = (
      no: number,
      slot: number,
      t: string,
      status: ResponseRecord['status'],
      receivedAt: number,
    ) =>
      response(meta, pid(no), text(t), {
        slot,
        responseId: `${pid(no)}-${slot}`,
        normalizedText: t,
        status,
        receivedAt,
      });
    const responses = [
      open(2, 0, 'second', 'visible', NOW + 5000),
      open(1, 0, 'first', 'pending', NOW + 4000),
      open(3, 0, 'tie b', 'hidden', NOW + 6000),
      open(4, 0, 'tie a', 'visible', NOW + 6000),
      open(5, 0, 'kicked', 'visible', NOW + 4500),
    ];
    const out = reveal(s, Q.open, responses);

    it('gives the host every response with status and nickname, oldest first (ties by id)', () => {
      expect(out.hostResult).toEqual({
        type: 'open',
        answered: 4,
        totalPlayers: 4,
        omitted: 0,
        responses: [
          {
            id: 'player-01-0',
            text: 'first',
            status: 'pending',
            nickname: 'Alice',
            receivedAt: NOW + 4000,
          },
          {
            id: 'player-02-0',
            text: 'second',
            status: 'visible',
            nickname: 'Bob',
            receivedAt: NOW + 5000,
          },
          {
            id: 'player-03-0',
            text: 'tie b',
            status: 'hidden',
            nickname: 'Cara',
            receivedAt: NOW + 6000,
          },
          {
            id: 'player-04-0',
            text: 'tie a',
            status: 'visible',
            nickname: 'Dan',
            receivedAt: NOW + 6000,
          },
        ],
      });
    });

    it('remembers how many responses are visible, for players', () => {
      expect(out.stored.visibleResponses).toBe(2);
    });

    it('gives players no responses, only how many were visible', () => {
      for (const { message } of out.playerMessages) {
        if (message.type !== 'reveal') throw new Error('type');
        expect(message.result).toEqual({
          type: 'open',
          answered: 4,
          totalPlayers: 4,
          responses: [],
          omitted: 2,
        });
        const json = JSON.stringify(message);
        for (const secret of ['nickname', 'first', 'second', 'tie a', 'player-0']) {
          expect(json).not.toContain(secret);
        }
      }
    });
  });
});

describe('toPlayerResult', () => {
  it('returns non-open results unchanged', () => {
    const results: QuestionResult[] = [
      {
        type: 'single',
        answered: 1,
        totalPlayers: 2,
        correctOptionId: 'opt-paris',
        counts: { 'opt-paris': 1 },
      },
      {
        type: 'truefalse',
        answered: 1,
        totalPlayers: 2,
        correct: true,
        counts: { true: 1, false: 0 },
      },
      { type: 'poll', answered: 1, totalPlayers: 2, counts: { 'opt-red': 1 } },
      { type: 'wordcloud', answered: 1, totalPlayers: 2, words: [{ text: 'a1', count: 1 }] },
      { type: 'rating', answered: 1, totalPlayers: 2, histogram: [0, 1, 0], average: 2 },
    ];
    for (const r of results) expect(toPlayerResult(r)).toEqual(r);
  });

  it('drops every open-ended response and counts the visible ones without mutating the input', () => {
    const host: QuestionResult = {
      type: 'open',
      answered: 3,
      totalPlayers: 3,
      responses: [
        { id: 'r-000001', text: 'a', status: 'visible', nickname: 'Alice', receivedAt: 1 },
        { id: 'r-000002', text: 'b', status: 'pending', nickname: 'Bob', receivedAt: 2 },
        { id: 'r-000003', text: 'c', status: 'hidden', nickname: 'Cara', receivedAt: 3 },
      ],
      omitted: 4,
    };
    const before = JSON.stringify(host);
    expect(toPlayerResult(host)).toEqual({
      type: 'open',
      answered: 3,
      totalPlayers: 3,
      responses: [],
      omitted: 1,
    });
    expect(JSON.stringify(host)).toBe(before);
  });

  it('prefers the stored total of visible responses when the host view was capped', () => {
    const host: QuestionResult = {
      type: 'open',
      answered: 3,
      totalPlayers: 3,
      responses: [{ id: 'r-000001', text: 'a', status: 'visible', receivedAt: 1 }],
      omitted: 40,
    };
    expect(toPlayerResult(host, 37)).toMatchObject({ responses: [], omitted: 37 });
    expect(toPlayerResult(host, 0)).toMatchObject({ responses: [], omitted: 0 });
  });
});

describe('computeReveal: preconditions', () => {
  const call = (
    phase: 'question' | 'revealing' | 'reveal',
    prior: Scoreboard | null,
    index: number = Q.single,
  ) =>
    computeReveal({
      meta: { ...revealingAt(s, index), phase },
      snapshot: s.snapshot,
      responses: [],
      players: players(),
      scoreboard: prior,
      now: NOW,
    });

  it('requires the revealing phase', () => {
    expect(() => call('question', null)).toThrow(/revealing/);
    expect(() => call('reveal', null)).toThrow(/revealing/);
    expect(() => call('revealing', null)).not.toThrow();
  });

  it('refuses to score a question the scoreboard already includes', () => {
    expect(() => call('revealing', board({}, Q.single))).toThrow(/already applied/);
    expect(() => call('revealing', board({}, 5))).toThrow(/already applied/);
    expect(() => call('revealing', board({}, Q.single - 1))).not.toThrow();
    expect(() => call('revealing', board({}, Q.truefalse - 1), Q.truefalse)).not.toThrow();
    expect(() => call('revealing', board({}, Q.truefalse), Q.truefalse)).toThrow(/already applied/);
  });

  it('throws when the question does not exist', () => {
    const meta = { ...revealingAt(s, Q.single), questionIndex: 40 };
    expect(() =>
      computeReveal({
        meta,
        snapshot: s.snapshot,
        responses: [],
        players: players(),
        scoreboard: null,
        now: NOW,
      }),
    ).toThrow(/no question/);
  });

  it('falls back to now when the close time is missing', () => {
    const meta = { ...revealingAt(s, Q.single), closedAt: null };
    const out = computeReveal({
      meta,
      snapshot: s.snapshot,
      responses: [],
      players: players(),
      scoreboard: null,
      now: NOW + 1,
    });
    expect(out.stored.closedAt).toBe(NOW + 1);
  });
});

describe('revealFromStored', () => {
  const responses = play(s, Q.single, [
    [1, choice('opt-paris'), 0],
    [2, choice('opt-rome'), 0],
  ]);
  const meta = revealingAt(s, Q.single);
  const out = reveal(s, Q.single, responses);

  it('rebuilds the same meta transition, host result and messages as computeReveal', () => {
    const again = revealFromStored({ meta, stored: out.stored, players: players() });
    expect(again.meta).toEqual(out.meta);
    expect(again.hostResult).toEqual(out.hostResult);
    expect(again.playerMessages).toEqual(out.playerMessages);
  });

  it('skips players who were kicked since the reveal was stored', () => {
    const kicked = players().map((p) => (p.playerId === pid(2) ? { ...p, kicked: true } : p));
    const again = revealFromStored({ meta, stored: out.stored, players: kicked });
    expect(again.playerMessages.map((m) => m.playerId)).toEqual([pid(1), pid(3), pid(4)]);
  });

  it('skips players who joined after the reveal was stored (no outcome)', () => {
    const late = [...players(), player(9, { nickname: 'Late' })];
    const again = revealFromStored({ meta, stored: out.stored, players: late });
    expect(again.playerMessages).toHaveLength(4);
  });

  it('requires a matching revealing meta', () => {
    expect(() =>
      revealFromStored({
        meta: { ...meta, phase: 'reveal' },
        stored: out.stored,
        players: players(),
      }),
    ).toThrow(/does not match/);
    expect(() =>
      revealFromStored({
        meta: { ...meta, questionIndex: 3 },
        stored: out.stored,
        players: players(),
      }),
    ).toThrow(/does not match/);
  });
});

describe('refreshModeration', () => {
  const wordMeta = openAtIndex(s, Q.wordcloud);
  const openMeta = openAtIndex(s, Q.open);
  const word = (no: number, slot: number, t: string, status: ResponseRecord['status']) =>
    response(wordMeta, pid(no), text(t), {
      slot,
      responseId: `${pid(no)}-${slot}`,
      normalizedText: t,
      status,
    });
  const open = (no: number, t: string, status: ResponseRecord['status'], receivedAt: number) =>
    response(openMeta, pid(no), text(t), {
      responseId: `${pid(no)}-0`,
      normalizedText: t,
      status,
      receivedAt,
    });

  it('re-derives open-ended statuses from the responses and keeps the counts and outcomes', () => {
    const before = [
      open(1, 'first', 'pending', NOW + 4000),
      open(2, 'second', 'pending', NOW + 5000),
    ];
    const stored = reveal(s, Q.open, before).stored;
    const after = [open(1, 'first', 'visible', NOW + 4000), before[1] as ResponseRecord];
    const out = refreshModeration({ stored, players: players(), responses: after });
    expect(out).toEqual({
      ...stored,
      visibleResponses: 1,
      result: {
        ...stored.result,
        omitted: 0,
        responses: [
          expect.objectContaining({ id: 'player-01-0', status: 'visible', nickname: 'Alice' }),
          expect.objectContaining({ id: 'player-02-0', status: 'pending', nickname: 'Bob' }),
        ],
      },
    });
    expect(stored.result).toMatchObject({
      responses: [{ status: 'pending' }, { status: 'pending' }],
    });
  });

  it('re-aggregates the word cloud without the words that are no longer visible', () => {
    const before = [
      word(1, 0, 'banana', 'visible'),
      word(2, 0, 'banana', 'visible'),
      word(3, 0, 'rude', 'visible'),
    ];
    const stored = reveal(s, Q.wordcloud, before).stored;
    const after = [
      before[0] as ResponseRecord,
      before[1] as ResponseRecord,
      word(3, 0, 'rude', 'hidden'),
    ];
    const out = refreshModeration({ stored, players: players(), responses: after });
    expect(out?.result).toEqual({
      type: 'wordcloud',
      answered: 3,
      totalPlayers: 4,
      words: [{ text: 'banana', count: 2 }],
    });
    const restored = [...after.slice(0, 2), word(3, 0, 'rude', 'visible')];
    expect(
      refreshModeration({ stored: out as typeof stored, players: players(), responses: restored })
        ?.result,
    ).toMatchObject({
      words: [
        { text: 'banana', count: 2 },
        { text: 'rude', count: 1 },
      ],
    });
  });

  it('ignores responses of other questions and of kicked players', () => {
    const stored = reveal(s, Q.wordcloud, [word(1, 0, 'apple', 'visible')]).stored;
    const elsewhere = response(openAtIndex(s, Q.single), pid(2), text('pear'), {
      normalizedText: 'pear',
    });
    const kicked = word(5, 0, 'kicked', 'visible');
    const out = refreshModeration({
      stored,
      players: players(),
      responses: [word(1, 0, 'apple', 'visible'), elsewhere, kicked],
    });
    expect(out?.result).toMatchObject({ words: [{ text: 'apple', count: 1 }] });
  });

  it('returns null for question types with nothing to moderate', () => {
    const stored = reveal(s, Q.poll, play(s, Q.poll, [[1, choice('opt-red'), 0]])).stored;
    expect(refreshModeration({ stored, players: players(), responses: [] })).toBeNull();
  });
});

describe('open-ended results are bounded', () => {
  const meta = openAtIndex(s, Q.open);
  const crowd = Array.from({ length: 300 }, (_, i) => player(i + 1, { nickname: `Nick${i + 1}` }));
  const answer = (no: number, status: ResponseRecord['status'], receivedAt = NOW + no * 10) =>
    response(meta, pid(no), text(`answer ${no}`), {
      normalizedText: `answer ${no}`,
      status,
      receivedAt,
    });
  const statusOf = (no: number): ResponseRecord['status'] =>
    no % 5 === 0 ? 'hidden' : no % 3 === 0 ? 'pending' : 'visible';
  const responses = crowd.map((p, i) => answer(i + 1, statusOf(i + 1)));
  const count = (status: 'visible' | 'other') =>
    responses.filter((r) => (r.status === 'visible') === (status === 'visible')).length;

  const revealCrowd = (rs: ResponseRecord[] = responses, ps: PlayerRecord[] = crowd) =>
    computeReveal({
      meta: revealingAt(s, Q.open),
      snapshot: s.snapshot,
      responses: rs,
      players: ps,
      scoreboard: null,
      now: NOW + 99_000,
    });

  const openResult = (result: QuestionResult) => {
    if (result.type !== 'open') throw new Error('type');
    return result;
  };

  it('keeps the newest visible responses and the newest 50 pending or hidden ones', () => {
    expect(count('visible')).toBeGreaterThan(LIMITS.openRevealMax);
    expect(count('other')).toBeGreaterThan(50);
    const host = openResult(revealCrowd().hostResult);
    const newest = (visible: boolean, n: number) =>
      responses
        .filter((r) => (r.status === 'visible') === visible)
        .sort((a, b) => b.receivedAt - a.receivedAt)
        .slice(0, n)
        .map((r) => r.responseId);
    expect(
      host.responses
        .filter((r) => r.status === 'visible')
        .map((r) => r.id)
        .sort(),
    ).toEqual(newest(true, LIMITS.openRevealMax).sort());
    expect(
      host.responses
        .filter((r) => r.status !== 'visible')
        .map((r) => r.id)
        .sort(),
    ).toEqual(newest(false, 50).sort());
    expect(host.omitted).toBe(responses.length - LIMITS.openRevealMax - 50);
    const times = host.responses.map((r) => r.receivedAt);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('breaks receivedAt ties by response id when choosing the newest', () => {
    const tied = crowd.map((p, i) => answer(i + 1, 'visible', NOW));
    const host = openResult(revealCrowd(tied).hostResult);
    const ids = tied.map((r) => r.responseId).sort();
    expect(host.responses.map((r) => r.id)).toEqual(ids.slice(ids.length - LIMITS.openRevealMax));
  });

  it('leaves small results whole, with nothing omitted', () => {
    const host = openResult(revealCrowd(responses.slice(0, 20)).hostResult);
    expect(host.responses).toHaveLength(20);
    expect(host.omitted).toBe(0);
  });

  it('does not count kicked players toward the total', () => {
    const ps = crowd.map((p, i) => (i < 10 ? { ...p, kicked: true } : p));
    const host = openResult(revealCrowd(responses.slice(0, 40), ps).hostResult);
    expect(host.responses).toHaveLength(30);
    expect(host.omitted).toBe(0);
  });

  it('tells every player the exact number of visible responses, not their text', () => {
    const out = revealCrowd();
    expect(out.stored.visibleResponses).toBe(count('visible'));
    expect(out.playerMessages).toHaveLength(crowd.length);
    for (const { message } of out.playerMessages) {
      if (message.type !== 'reveal') throw new Error('type');
      expect(message.result).toMatchObject({ responses: [], omitted: count('visible') });
    }
    const again = revealFromStored({
      meta: revealingAt(s, Q.open),
      stored: out.stored,
      players: crowd,
    });
    const [first] = again.playerMessages;
    expect(first?.message).toMatchObject({ result: { responses: [], omitted: count('visible') } });
  });

  it('caps a moderation rebuild the same way and keeps the visible total exact', () => {
    const stored = revealCrowd().stored;
    // The host approves every pending response that is still listed and hides one visible one.
    const moderated = responses.map((r) =>
      r.status === 'pending' ? { ...r, status: 'visible' as const } : r,
    );
    const out = refreshModeration({ stored, players: crowd, responses: moderated });
    const host = openResult((out as NonNullable<typeof out>).result);
    expect(host.responses.filter((r) => r.status === 'visible')).toHaveLength(LIMITS.openRevealMax);
    expect(host.responses.filter((r) => r.status !== 'visible').length).toBeLessThanOrEqual(50);
    expect(host.responses.length + (host.omitted ?? 0)).toBe(responses.length);
    expect(out?.visibleResponses).toBe(moderated.filter((r) => r.status === 'visible').length);
    expect(out?.outcomes).toEqual(stored.outcomes);
  });
});
