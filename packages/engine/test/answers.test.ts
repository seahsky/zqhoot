import { describe, expect, it } from 'vitest';
import type { AnswerPayload, AnswerRejectReason } from '@zqhoot/protocol';
import { evaluateAnswer } from '../src/index.ts';
import type { AnswerDecision, ResponseRecord, SessionMeta } from '../src/index.ts';
import { CFG, Q, newSession, openAtIndex, questions } from './helpers.ts';

const s = newSession();
const P = 'player-01';

const choice = (optionId: string): AnswerPayload => ({ kind: 'choice', optionId });
const bool = (value: boolean): AnswerPayload => ({ kind: 'boolean', value });
const text = (t: string): AnswerPayload => ({ kind: 'text', text: t });
const rating = (value: number): AnswerPayload => ({ kind: 'rating', value });

function decide(
  meta: SessionMeta,
  payload: AnswerPayload,
  receivedAt: number,
  existing: ResponseRecord[] = [],
  questionIndex = meta.questionIndex,
  snapshot = s.snapshot,
): AnswerDecision {
  return evaluateAnswer({
    meta,
    snapshot,
    playerId: P,
    questionIndex,
    payload,
    receivedAt,
    existing,
    cfg: CFG,
  });
}

const rejected = (reason: AnswerRejectReason): AnswerDecision => ({ kind: 'reject', reason });
const accepted = (d: AnswerDecision): ResponseRecord => {
  if (d.kind !== 'accept') throw new Error(`expected accept, got ${JSON.stringify(d)}`);
  return d.response;
};

const q = (index: number) => openAtIndex(s, index);

describe('phase check', () => {
  const open = q(Q.single);
  const at = open.openAt as number;

  it('accepts in the matching open question', () => {
    expect(decide(open, choice('opt-paris'), at).kind).toBe('accept');
  });

  it('rejects other phases as not-open when the index is not the current one', () => {
    expect(decide(s.meta, choice('opt-paris'), at, [], 0)).toEqual(rejected('not-open'));
    expect(decide(open, choice('opt-paris'), at, [], 1)).toEqual(rejected('not-open'));
    expect(decide(open, choice('opt-paris'), at, [], -1)).toEqual(rejected('not-open'));
    const ended = { ...open, phase: 'ended' as const, openAt: null, deadline: null };
    expect(decide(ended, choice('opt-paris'), at, [], 0)).toEqual(rejected('not-open'));
    for (const phase of ['revealing', 'reveal', 'leaderboard'] as const) {
      expect(decide({ ...open, phase }, choice('opt-paris'), at, [], 3)).toEqual(
        rejected('not-open'),
      );
    }
  });

  it.each(['revealing', 'reveal', 'leaderboard'] as const)(
    'rejects too-late in %s for the same index',
    (phase) => {
      expect(decide({ ...open, phase }, choice('opt-paris'), at)).toEqual(rejected('too-late'));
    },
  );

  it('rejects not-open when the state is inconsistent (no openAt, or no such question)', () => {
    expect(decide({ ...open, openAt: null }, choice('opt-paris'), at)).toEqual(
      rejected('not-open'),
    );
    const beyond = { ...open, questionIndex: 99 };
    expect(decide(beyond, choice('opt-paris'), at, [], 99)).toEqual(rejected('not-open'));
  });
});

describe('timing', () => {
  const open = q(Q.single);
  const openAt = open.openAt as number;
  const deadline = open.deadline as number;
  const pay = choice('opt-paris');

  it.each([
    ['251 ms before openAt', openAt - 251, 'too-early'],
    ['much earlier', openAt - 5000, 'too-early'],
    ['250 ms before openAt', openAt - 250, 'accept'],
    ['at openAt', openAt, 'accept'],
    ['at the deadline', deadline, 'accept'],
    ['at the end of the grace period', deadline + CFG.answerGraceMs, 'accept'],
    ['1 ms after the grace period', deadline + CFG.answerGraceMs + 1, 'too-late'],
    ['long after', deadline + 60_000, 'too-late'],
  ])('%s', (_name, receivedAt, expected) => {
    const d = decide(open, pay, receivedAt);
    expect(d.kind === 'reject' ? d.reason : d.kind).toBe(expected);
  });

  it('uses the configured grace period', () => {
    const d = evaluateAnswer({
      meta: open,
      snapshot: s.snapshot,
      playerId: P,
      questionIndex: 0,
      payload: pay,
      receivedAt: deadline + 100,
      existing: [],
      cfg: { ...CFG, answerGraceMs: 50 },
    });
    expect(d).toEqual(rejected('too-late'));
  });

  it('never times out an untimed question', () => {
    const untimed = q(Q.poll);
    expect(untimed.deadline).toBeNull();
    expect(decide(untimed, choice('opt-red'), (untimed.openAt as number) + 10 ** 9).kind).toBe(
      'accept',
    );
    expect(decide(untimed, choice('opt-red'), (untimed.openAt as number) - 251)).toEqual(
      rejected('too-early'),
    );
  });

  it('checks the phase before timing, and timing before the payload', () => {
    expect(decide({ ...open, phase: 'reveal' }, pay, openAt - 5000)).toEqual(rejected('too-late'));
    expect(decide(open, choice('nope'), openAt - 5000)).toEqual(rejected('too-early'));
    expect(decide(open, choice('nope'), deadline + 5000)).toEqual(rejected('too-late'));
  });
});

describe('payload validation', () => {
  const invalid = (index: number, payload: AnswerPayload, existing: ResponseRecord[] = []) => {
    const meta = q(index);
    return decide(meta, payload, meta.openAt as number, existing);
  };

  it.each<[string, number, AnswerPayload]>([
    ['single: unknown option', Q.single, choice('opt-berlin')],
    ['single: boolean', Q.single, bool(true)],
    ['single: text', Q.single, text('Paris')],
    ['single: rating', Q.single, rating(1)],
    ['truefalse: choice', Q.truefalse, choice('opt-paris')],
    ['truefalse: text', Q.truefalse, text('true')],
    ['poll: unknown option', Q.poll, choice('opt-green')],
    ['poll: boolean', Q.poll, bool(true)],
    ['wordcloud: choice', Q.wordcloud, choice('opt-red')],
    ['wordcloud: unusable text', Q.wordcloud, text('!!!')],
    ['wordcloud: too long', Q.wordcloud, text('a'.repeat(26))],
    ['wordcloud: control characters', Q.wordcloud, text('a\u0007b')],
    ['open: rating', Q.open, rating(3)],
    ['open: blank text', Q.open, text('   ')],
    ['open: too long', Q.open, text('a'.repeat(201))],
    ['rating: choice', Q.rating, choice('opt-red')],
    ['rating: text', Q.rating, text('5')],
    ['rating: zero', Q.rating, rating(0)],
    ['rating: above max', Q.rating, rating(6)],
    ['rating: fractional', Q.rating, rating(2.5)],
  ])('%s is invalid', (_name, index, payload) => {
    expect(invalid(index, payload)).toEqual(rejected('invalid'));
  });

  it('checks the payload before duplicates and limits', () => {
    const meta = q(Q.single);
    const first = accept1(meta, choice('opt-paris'));
    expect(decide(meta, choice('opt-berlin'), meta.openAt as number, [first])).toEqual(
      rejected('invalid'),
    );
  });

  it('accepts the boundary values', () => {
    expect(invalid(Q.rating, rating(1)).kind).toBe('accept');
    expect(invalid(Q.rating, rating(5)).kind).toBe('accept');
    expect(invalid(Q.wordcloud, text('a'.repeat(25))).kind).toBe('accept');
    expect(invalid(Q.open, text('a'.repeat(200))).kind).toBe('accept');
  });
});

function accept1(
  meta: SessionMeta,
  payload: AnswerPayload,
  at = meta.openAt as number,
): ResponseRecord {
  return accepted(decide(meta, payload, at));
}

describe('duplicates and entry limits', () => {
  it.each<[string, number, AnswerPayload, AnswerPayload]>([
    ['single', Q.single, choice('opt-paris'), choice('opt-rome')],
    ['truefalse', Q.truefalse, bool(true), bool(false)],
    ['poll', Q.poll, choice('opt-red'), choice('opt-blue')],
    ['rating', Q.rating, rating(4), rating(2)],
  ])('%s: same payload is a duplicate, a different one hits the limit', (_name, index, a, b) => {
    const meta = q(index);
    const at = meta.openAt as number;
    const first = accept1(meta, a);
    expect(decide(meta, a, at + 100, [first])).toEqual({ kind: 'duplicate', existing: first });
    expect(decide(meta, b, at + 100, [first])).toEqual(rejected('limit'));
  });

  it('wordcloud: duplicates compare the normalised word', () => {
    const meta = q(Q.wordcloud);
    const first = accept1(meta, text('Hello!'));
    for (const again of ['hello', 'HELLO', ' hello. ', 'ｈｅｌｌｏ']) {
      expect(decide(meta, text(again), meta.openAt as number, [first])).toEqual({
        kind: 'duplicate',
        existing: first,
      });
    }
  });

  it('wordcloud: allows maxEntries different words, then hits the limit', () => {
    const meta = q(Q.wordcloud);
    const at = meta.openAt as number;
    const existing: ResponseRecord[] = [];
    for (const [i, word] of ['one', 'two', 'three'].entries()) {
      const r = accepted(decide(meta, text(word), at, existing));
      expect(r.slot).toBe(i);
      existing.push(r);
    }
    expect(decide(meta, text('four'), at, existing)).toEqual(rejected('limit'));
    expect(decide(meta, text('TWO'), at, existing)).toEqual({
      kind: 'duplicate',
      existing: existing[1],
    });
  });

  it('open: two entries, duplicate by normalised text, then limit', () => {
    const meta = q(Q.open);
    const at = meta.openAt as number;
    const first = accept1(meta, text('same  words'));
    expect(decide(meta, text('same words'), at, [first])).toEqual({
      kind: 'duplicate',
      existing: first,
    });
    const second = accepted(decide(meta, text('other'), at, [first]));
    expect(second.slot).toBe(1);
    expect(decide(meta, text('third'), at, [first, second])).toEqual(rejected('limit'));
  });

  it('returns the matching record even when it is not the first one', () => {
    const meta = q(Q.wordcloud);
    const at = meta.openAt as number;
    const a = accepted(decide(meta, text('a1'), at, []));
    const b = accepted(decide(meta, text('b1'), at, [a]));
    expect(decide(meta, text('b1'), at, [a, b])).toEqual({ kind: 'duplicate', existing: b });
  });

  it('respects a smaller maxEntries', () => {
    const one = [
      { ...questions()[Q.wordcloud]!, maxEntries: 1 } as ReturnType<typeof questions>[number],
    ];
    const t = newSession(one);
    const meta = openAtIndex(t, 0);
    const first = accepted(decide(meta, text('a1'), meta.openAt as number, [], 0, t.snapshot));
    expect(decide(meta, text('b1'), meta.openAt as number, [first], 0, t.snapshot)).toEqual(
      rejected('limit'),
    );
  });
});

describe('accepted record', () => {
  it('fills identity, timing and payload', () => {
    const meta = q(Q.single);
    const at = meta.openAt as number;
    const r = accept1(meta, choice('opt-paris'), at + 4321);
    expect(r).toEqual({
      sessionId: 'sess-0001',
      questionIndex: 0,
      playerId: P,
      slot: 0,
      responseId: 'player-01-0',
      payload: choice('opt-paris'),
      receivedAt: at + 4321,
      elapsedMs: 4321,
      correct: true,
      points: expect.any(Number),
      status: 'visible',
    });
    expect('normalizedText' in r).toBe(false);
  });

  it('allocates the slot from the number of existing entries', () => {
    const meta = q(Q.wordcloud);
    const at = meta.openAt as number;
    const first = accepted(decide(meta, text('aa'), at, []));
    const second = accepted(decide(meta, text('bb'), at, [first]));
    expect([first.slot, second.slot]).toEqual([0, 1]);
    expect([first.responseId, second.responseId]).toEqual(['player-01-0', 'player-01-1']);
  });

  describe('elapsedMs', () => {
    const meta = q(Q.single);
    const openAt = meta.openAt as number;
    it.each([
      ['inside the limit', openAt + 5000, 5000],
      ['at openAt', openAt, 0],
      ['slightly early is clamped to 0', openAt - 200, 0],
      ['at the limit', openAt + 20_000, 20_000],
      ['inside the grace period is clamped to the limit', openAt + 20_500, 20_000],
    ])('%s', (_name, receivedAt, expected) => {
      expect(accept1(meta, choice('opt-paris'), receivedAt).elapsedMs).toBe(expected);
    });

    it('is null for untimed questions', () => {
      const untimed = q(Q.poll);
      expect(
        accept1(untimed, choice('opt-red'), (untimed.openAt as number) + 90_000).elapsedMs,
      ).toBeNull();
    });
  });

  describe('correctness and points', () => {
    it('single', () => {
      const meta = q(Q.single);
      const at = meta.openAt as number;
      expect(accept1(meta, choice('opt-paris'), at)).toMatchObject({ correct: true, points: 1000 });
      expect(accept1(meta, choice('opt-paris'), at + 20_000)).toMatchObject({
        correct: true,
        points: 400,
      });
      expect(accept1(meta, choice('opt-paris'), at + 10_125)).toMatchObject({
        correct: true,
        points: 700,
      });
      expect(accept1(meta, choice('opt-rome'), at)).toMatchObject({ correct: false, points: 0 });
    });

    it('truefalse doubles for m = 2', () => {
      const meta = q(Q.truefalse);
      const at = meta.openAt as number;
      expect(accept1(meta, bool(false), at)).toMatchObject({ correct: true, points: 2000 });
      expect(accept1(meta, bool(false), at + 10_000)).toMatchObject({ correct: true, points: 800 });
      expect(accept1(meta, bool(true), at)).toMatchObject({ correct: false, points: 0 });
    });

    it('records correctness but no points when the multiplier is 0', () => {
      const meta = q(Q.zeroPoints);
      expect(accept1(meta, choice('opt-yes'))).toMatchObject({ correct: true, points: 0 });
      expect(accept1(meta, choice('opt-no'))).toMatchObject({ correct: false, points: 0 });
    });

    it('unscored types have no correctness and no points', () => {
      const cases: Array<[number, AnswerPayload]> = [
        [Q.poll, choice('opt-red')],
        [Q.wordcloud, text('cloud')],
        [Q.open, text('hello there')],
        [Q.rating, rating(4)],
      ];
      for (const [index, payload] of cases) {
        expect(accept1(q(index), payload)).toMatchObject({ correct: null, points: 0 });
      }
    });

    it('untimed scored questions give full points', () => {
      const t = newSession([
        { ...questions()[Q.single]!, timeLimitSec: null } as ReturnType<typeof questions>[number],
      ]);
      const meta = openAtIndex(t, 0);
      const r = accepted(
        decide(meta, choice('opt-paris'), (meta.openAt as number) + 99_999, [], 0, t.snapshot),
      );
      expect(r).toMatchObject({ correct: true, points: 1000, elapsedMs: null });
    });
  });

  describe('normalisedText and status', () => {
    it('stores the normalised word for word clouds', () => {
      expect(accept1(q(Q.wordcloud), text('  Hello!! '))).toMatchObject({
        normalizedText: 'hello',
        status: 'visible',
        payload: text('  Hello!! '),
      });
    });

    it('stores the normalised text for open-ended entries', () => {
      expect(accept1(q(Q.open), text('  hi   there\r\nfriend '))).toMatchObject({
        normalizedText: 'hi there\nfriend',
      });
    });

    it('holds open-ended entries for approval when the question requires it', () => {
      expect(accept1(q(Q.open), text('a fine answer')).status).toBe('pending');
    });

    it('shows open-ended entries at once when approval is off', () => {
      const open = { ...questions()[Q.open]!, requireApproval: false } as ReturnType<
        typeof questions
      >[number];
      const t = newSession([open]);
      const meta = openAtIndex(t, 0);
      const d = decide(meta, text('a fine answer'), meta.openAt as number, [], 0, t.snapshot);
      expect(accepted(d).status).toBe('visible');
    });

    it('always hides profane open-ended entries, even without approval', () => {
      const open = { ...questions()[Q.open]!, requireApproval: false } as ReturnType<
        typeof questions
      >[number];
      const t = newSession([open]);
      const meta = openAtIndex(t, 0);
      const d = decide(meta, text('what the fuck'), meta.openAt as number, [], 0, t.snapshot);
      expect(accepted(d).status).toBe('hidden');
      expect(accept1(q(Q.open), text('what the fuck')).status).toBe('hidden');
    });

    it('hides profane word-cloud entries and shows the rest', () => {
      expect(accept1(q(Q.wordcloud), text('fuck')).status).toBe('hidden');
      expect(accept1(q(Q.wordcloud), text('sunshine')).status).toBe('visible');
    });

    it('keeps every other type visible', () => {
      for (const [index, payload] of [
        [Q.single, choice('opt-paris')],
        [Q.truefalse, bool(true)],
        [Q.poll, choice('opt-red')],
        [Q.rating, rating(3)],
      ] as Array<[number, AnswerPayload]>) {
        expect(accept1(q(index), payload).status).toBe('visible');
      }
    });
  });

  it('does not mutate its inputs', () => {
    const meta = q(Q.wordcloud);
    const first = accept1(meta, text('one'));
    const before = JSON.stringify([meta, first, s.snapshot]);
    decide(meta, text('two'), meta.openAt as number, [first]);
    expect(JSON.stringify([meta, first, s.snapshot])).toBe(before);
  });
});
