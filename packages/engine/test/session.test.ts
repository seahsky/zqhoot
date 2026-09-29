import { describe, expect, it } from 'vitest';
import { LIMITS, Quiz } from '@zqhoot/protocol';
import type { Phase } from '@zqhoot/protocol';
import {
  applyHostCommand,
  checkJoinable,
  createSession,
  isExpired,
  timerClose,
} from '../src/index.ts';
import type { SessionMeta, TransitionEffect } from '../src/index.ts';
import { CFG, NOW, Q, metaIn, newSession, questions, quizOf } from './helpers.ts';
import type { Cmd } from './helpers.ts';

const T = NOW + 50_000; // "now" for transitions, distinct from every fixture timestamp

describe('createSession', () => {
  it('starts in the lobby at version 1', () => {
    const { meta, snapshot } = newSession();
    expect(meta).toEqual({
      sessionId: 'sess-0001',
      pin: '123456',
      hostId: 'host-0001',
      quizId: 'quiz-0001',
      quizTitle: 'Fixture quiz',
      totalQuestions: 8,
      hasScoredQuestions: true,
      settings: { streakBonus: false, showQuestionOnDevices: true, readSeconds: 3 },
      phase: 'lobby',
      questionIndex: -1,
      openAt: null,
      deadline: null,
      closedAt: null,
      locked: false,
      maxPlayers: LIMITS.maxPlayersDefault,
      skipped: [],
      version: 1,
      createdAt: NOW,
      expiresAt: NOW + CFG.sessionTtlMs,
      endedAt: null,
    });
    expect(snapshot.quizId).toBe('quiz-0001');
    expect(snapshot.title).toBe('Fixture quiz');
    expect(snapshot.questions).toHaveLength(8);
  });

  it('fixture quiz is a valid quiz', () => {
    expect(Quiz.safeParse(quizOf()).success).toBe(true);
  });

  it('honours maxPlayers and the configured TTL', () => {
    const { meta } = createSession({
      sessionId: 'sess-0002',
      pin: '654321',
      hostId: 'host-0001',
      quiz: quizOf(),
      now: 5,
      cfg: { ...CFG, sessionTtlMs: 1000 },
      maxPlayers: 12,
    });
    expect(meta.maxPlayers).toBe(12);
    expect(meta.expiresAt).toBe(1005);
  });

  it('deep-copies the quiz so later edits cannot change a running session', () => {
    const quiz = quizOf();
    const { meta, snapshot } = createSession({
      sessionId: 'sess-0001',
      pin: '123456',
      hostId: 'host-0001',
      quiz,
      now: NOW,
      cfg: CFG,
    });
    const first = quiz.questions[0];
    if (first?.type !== 'single') throw new Error('fixture');
    first.correctOptionId = 'opt-rome';
    first.options[0]!.text = 'edited';
    quiz.settings.readSeconds = 9;
    quiz.title = 'renamed';
    const snapped = snapshot.questions[0];
    if (snapped?.type !== 'single') throw new Error('fixture');
    expect(snapped.correctOptionId).toBe('opt-paris');
    expect(snapped.options[0]!.text).toBe('Paris');
    expect(snapshot.settings.readSeconds).toBe(3);
    expect(meta.settings.readSeconds).toBe(3);
    expect(meta.quizTitle).toBe('Fixture quiz');
  });

  it('computes hasScoredQuestions from scoring questions only', () => {
    const poll = questions()[Q.poll]!;
    const zero = questions()[Q.zeroPoints]!;
    expect(newSession([poll]).meta.hasScoredQuestions).toBe(false);
    expect(newSession([poll, zero]).meta.hasScoredQuestions).toBe(false);
    expect(newSession([poll, questions()[Q.truefalse]!]).meta.hasScoredQuestions).toBe(true);
  });
});

describe('isExpired', () => {
  it('expires exactly at expiresAt', () => {
    const { meta } = newSession();
    expect(isExpired(meta, meta.expiresAt - 1)).toBe(false);
    expect(isExpired(meta, meta.expiresAt)).toBe(true);
    expect(isExpired(meta, meta.expiresAt + 1)).toBe(true);
  });
});

describe('checkJoinable', () => {
  const { meta } = newSession();
  const live = (over: Partial<SessionMeta> = {}) => ({ ...meta, ...over });

  it.each<[string, SessionMeta | null, number, number, unknown]>([
    ['unknown session', null, 0, NOW, { ok: false, code: 'not-found' }],
    ['expired session', live(), 0, meta.expiresAt, { ok: false, code: 'not-found' }],
    ['ended session', live({ phase: 'ended' }), 0, NOW, { ok: false, code: 'session-ended' }],
    ['locked session', live({ locked: true }), 0, NOW, { ok: false, code: 'session-locked' }],
    ['full session', live({ maxPlayers: 3 }), 3, NOW, { ok: false, code: 'session-full' }],
    ['over-full session', live({ maxPlayers: 3 }), 4, NOW, { ok: false, code: 'session-full' }],
    ['one seat left', live({ maxPlayers: 3 }), 2, NOW, { ok: true }],
    ['empty lobby', live(), 0, NOW, { ok: true }],
    ['mid-question', live({ phase: 'question', questionIndex: 1 }), 5, NOW, { ok: true }],
    ['revealing', live({ phase: 'revealing', questionIndex: 1 }), 5, NOW, { ok: true }],
    ['reveal', live({ phase: 'reveal', questionIndex: 1 }), 5, NOW, { ok: true }],
    ['leaderboard', live({ phase: 'leaderboard', questionIndex: 1 }), 5, NOW, { ok: true }],
  ])('%s', (_name, m, count, now, expected) => {
    expect(checkJoinable(m, count, now)).toEqual(expected);
  });

  it('checks in the documented order: expired, ended, locked, full', () => {
    const all = live({ phase: 'ended', locked: true, maxPlayers: 1 });
    expect(checkJoinable(all, 9, NOW)).toEqual({ ok: false, code: 'session-ended' });
    expect(checkJoinable({ ...all, phase: 'lobby' }, 9, NOW)).toEqual({
      ok: false,
      code: 'session-locked',
    });
    expect(checkJoinable(all, 9, all.expiresAt)).toEqual({ ok: false, code: 'not-found' });
  });
});

// ---------------------------------------------------------------------------
// State machine: every phase x every host command.
// ---------------------------------------------------------------------------

const base = newSession();
const snapshot = base.snapshot;

interface Expected {
  /** No state change: the very same meta object comes back with effect 'none'. */
  noop?: true;
  phase?: Phase;
  questionIndex?: number;
  effect?: TransitionEffect;
  openAt?: number | null;
  deadline?: number | null;
  closedAt?: number | null;
  endedAt?: number | null;
  skipped?: number[];
  locked?: boolean;
  /** retry-reveal keeps the meta unchanged but is not a 'none' effect. */
  sameMeta?: true;
}

function check(state: SessionMeta, cmd: Cmd, expected: Expected) {
  const r = applyHostCommand(state, snapshot, cmd, T, CFG);
  if (!r.ok) throw new Error(`unexpected error ${r.message}`);
  if (expected.noop || expected.sameMeta) {
    expect(r.meta).toBe(state);
    expect(r.meta.version).toBe(state.version);
    expect(r.effect).toEqual(expected.effect ?? { kind: 'none' });
    return;
  }
  expect(r.meta).not.toBe(state);
  expect(r.effect).toEqual(expected.effect);
  const pick = <K extends keyof SessionMeta>(key: K): SessionMeta[K] =>
    key in expected ? (expected[key as keyof Expected] as SessionMeta[K]) : state[key];
  expect(r.meta).toEqual({
    ...state,
    version: state.version + 1,
    phase: expected.phase,
    questionIndex: pick('questionIndex'),
    openAt: pick('openAt'),
    deadline: pick('deadline'),
    closedAt: pick('closedAt'),
    endedAt: pick('endedAt'),
    skipped: pick('skipped'),
    locked: pick('locked'),
  });
}

const next = (state: SessionMeta): Cmd => ({
  type: 'host.next',
  from: { phase: state.phase, questionIndex: state.questionIndex },
});
const close = (
  questionIndex: number,
  reason: 'manual' | 'timer' | 'all-answered' = 'manual',
): Cmd => ({
  type: 'host.close',
  questionIndex,
  reason,
});
const skip = (questionIndex: number): Cmd => ({ type: 'host.skip', questionIndex });
const END: Cmd = { type: 'host.end' };
const lock = (locked: boolean): Cmd => ({ type: 'host.lock', locked });

/** Opening question i at T with 3 s of reading time (settings) and the fixture's limits. */
const opened = (index: number): Expected => {
  const limit = questions()[index]!.timeLimitSec;
  const openAt = T + 3000;
  return {
    phase: 'question',
    questionIndex: index,
    openAt,
    deadline: limit === null ? null : openAt + limit * 1000,
    closedAt: null,
    effect: { kind: 'question-opened', questionIndex: index },
  };
};
const ended: Expected = {
  phase: 'ended',
  openAt: null,
  deadline: null,
  closedAt: null,
  endedAt: T,
  effect: { kind: 'ended' },
};
const NOOP: Expected = { noop: true };

describe('state machine', () => {
  describe('lobby', () => {
    const s = metaIn(base.meta, 'lobby', -1, { version: 1 });
    it.each<[string, Cmd, Expected]>([
      ['next opens question 0', next(s), opened(0)],
      [
        'next with a stale phase',
        { type: 'host.next', from: { phase: 'question', questionIndex: -1 } },
        NOOP,
      ],
      [
        'next with a stale index',
        { type: 'host.next', from: { phase: 'lobby', questionIndex: 0 } },
        NOOP,
      ],
      ['close', close(0), NOOP],
      ['skip', skip(0), NOOP],
      ['end', END, ended],
      [
        'lock',
        lock(true),
        { phase: 'lobby', locked: true, effect: { kind: 'lock-changed', locked: true } },
      ],
      ['unlock while unlocked', lock(false), NOOP],
    ])('%s', (_n, cmd, expected) => check(s, cmd, expected));
  });

  describe('question', () => {
    const s = metaIn(base.meta, 'question', Q.single);
    const closing: Expected = {
      phase: 'revealing',
      closedAt: T,
      effect: { kind: 'closing', questionIndex: Q.single },
    };
    it.each<[string, Cmd, Expected]>([
      ['next closes like a manual close', next(s), closing],
      [
        'next with a stale phase',
        { type: 'host.next', from: { phase: 'lobby', questionIndex: 0 } },
        NOOP,
      ],
      [
        'next with a stale index',
        { type: 'host.next', from: { phase: 'question', questionIndex: 1 } },
        NOOP,
      ],
      ['close manual', close(0), closing],
      ['close timer', close(0, 'timer'), closing],
      ['close all-answered', close(0, 'all-answered'), closing],
      ['close for another question', close(1), NOOP],
      ['skip opens the next question', skip(0), { ...opened(1), skipped: [0] }],
      ['skip for another question', skip(1), NOOP],
      ['end', END, ended],
      [
        'lock',
        lock(true),
        { phase: 'question', locked: true, effect: { kind: 'lock-changed', locked: true } },
      ],
      ['unlock while unlocked', lock(false), NOOP],
    ])('%s', (_n, cmd, expected) => check(s, cmd, expected));

    it('closes before openAt too', () => {
      const early = metaIn(base.meta, 'question', 0, { openAt: T + 10_000, deadline: T + 30_000 });
      check(early, close(0), {
        phase: 'revealing',
        closedAt: T,
        effect: { kind: 'closing', questionIndex: 0 },
      });
    });

    it('repeating a close is a no-op', () => {
      const r = applyHostCommand(s, snapshot, close(0), T, CFG);
      if (!r.ok) throw new Error('fixture');
      check(r.meta, close(0), NOOP);
      check(r.meta, close(0, 'timer'), NOOP);
    });
  });

  describe('revealing', () => {
    const s = metaIn(base.meta, 'revealing', Q.single);
    it.each<[string, Cmd, Expected]>([
      [
        'next retries the reveal',
        next(s),
        { sameMeta: true, effect: { kind: 'retry-reveal', questionIndex: 0 } },
      ],
      [
        'next with a stale phase',
        { type: 'host.next', from: { phase: 'question', questionIndex: 0 } },
        NOOP,
      ],
      [
        'next with a stale index',
        { type: 'host.next', from: { phase: 'revealing', questionIndex: 3 } },
        NOOP,
      ],
      ['close', close(0), NOOP],
      ['close timer', close(0, 'timer'), NOOP],
      ['skip', skip(0), NOOP],
      ['end', END, ended],
      [
        'lock',
        lock(true),
        { phase: 'revealing', locked: true, effect: { kind: 'lock-changed', locked: true } },
      ],
    ])('%s', (_n, cmd, expected) => check(s, cmd, expected));
  });

  describe('reveal', () => {
    it.each<[string, number, Expected]>([
      [
        'scored question goes to the leaderboard',
        Q.single,
        {
          phase: 'leaderboard',
          openAt: null,
          deadline: null,
          closedAt: null,
          effect: { kind: 'leaderboard', questionIndex: Q.single },
        },
      ],
      [
        'double-points question goes to the leaderboard',
        Q.truefalse,
        {
          phase: 'leaderboard',
          openAt: null,
          deadline: null,
          closedAt: null,
          effect: { kind: 'leaderboard', questionIndex: Q.truefalse },
        },
      ],
      ['poll goes straight to the next question', Q.poll, opened(Q.poll + 1)],
      ['word cloud goes straight to the next question', Q.wordcloud, opened(Q.wordcloud + 1)],
      ['open-ended goes straight to the next question', Q.open, opened(Q.open + 1)],
      ['rating goes straight to the next question', Q.rating, opened(Q.rating + 1)],
      ['zero-point question counts as unscored', Q.zeroPoints, opened(Q.zeroPoints + 1)],
      [
        'last scored question goes to the leaderboard',
        Q.lastScored,
        {
          phase: 'leaderboard',
          openAt: null,
          deadline: null,
          closedAt: null,
          effect: { kind: 'leaderboard', questionIndex: Q.lastScored },
        },
      ],
    ])('next after %s', (_n, index, expected) => {
      const s = metaIn(base.meta, 'reveal', index);
      check(s, next(s), expected);
    });

    it('next after the last question (unscored) ends the session', () => {
      const one = newSession([questions()[Q.poll]!]);
      const s = metaIn(one.meta, 'reveal', 0);
      const r = applyHostCommand(s, one.snapshot, next(s), T, CFG);
      expect(r).toMatchObject({
        ok: true,
        effect: { kind: 'ended' },
        meta: { phase: 'ended', endedAt: T },
      });
    });

    const s = metaIn(base.meta, 'reveal', Q.single);
    it.each<[string, Cmd, Expected]>([
      [
        'next with a stale phase',
        { type: 'host.next', from: { phase: 'revealing', questionIndex: 0 } },
        NOOP,
      ],
      [
        'next with a stale index',
        { type: 'host.next', from: { phase: 'reveal', questionIndex: 1 } },
        NOOP,
      ],
      ['close', close(0), NOOP],
      ['skip', skip(0), NOOP],
      ['end', END, ended],
      [
        'lock',
        lock(true),
        { phase: 'reveal', locked: true, effect: { kind: 'lock-changed', locked: true } },
      ],
    ])('%s', (_n, cmd, expected) => check(s, cmd, expected));

    it('keeps closedAt and timing while in reveal', () => {
      const r = applyHostCommand(s, snapshot, lock(true), T, CFG);
      if (!r.ok) throw new Error('fixture');
      expect(r.meta.closedAt).toBe(s.closedAt);
      expect(r.meta.openAt).toBe(s.openAt);
    });
  });

  describe('leaderboard', () => {
    it.each<[string, number, Expected]>([
      ['question 0 opens question 1', Q.single, opened(Q.single + 1)],
      ['question 1 opens question 2 (untimed)', Q.truefalse, opened(Q.truefalse + 1)],
      ['the last question ends the session', Q.lastScored, ended],
    ])('next after %s', (_n, index, expected) => {
      const s = metaIn(base.meta, 'leaderboard', index);
      check(s, next(s), expected);
    });

    const s = metaIn(base.meta, 'leaderboard', Q.single);
    it.each<[string, Cmd, Expected]>([
      [
        'next with a stale phase',
        { type: 'host.next', from: { phase: 'reveal', questionIndex: 0 } },
        NOOP,
      ],
      [
        'next with a stale index',
        { type: 'host.next', from: { phase: 'leaderboard', questionIndex: 2 } },
        NOOP,
      ],
      ['close', close(0), NOOP],
      ['skip', skip(0), NOOP],
      ['end', END, ended],
      [
        'lock',
        lock(true),
        { phase: 'leaderboard', locked: true, effect: { kind: 'lock-changed', locked: true } },
      ],
    ])('%s', (_n, cmd, expected) => check(s, cmd, expected));
  });

  describe('ended', () => {
    const s = metaIn(base.meta, 'ended', Q.lastScored, { endedAt: NOW });
    it.each<[string, Cmd]>([
      ['next', next(s)],
      [
        'next with a stale phase',
        { type: 'host.next', from: { phase: 'lobby', questionIndex: -1 } },
      ],
      ['close', close(Q.lastScored)],
      ['skip', skip(Q.lastScored)],
      ['end', END],
      ['lock', lock(true)],
      ['unlock', lock(false)],
    ])('%s is a no-op', (_n, cmd) => check(s, cmd, NOOP));
  });

  describe('lock', () => {
    it('toggles in every live phase and is idempotent', () => {
      for (const phase of ['lobby', 'question', 'revealing', 'reveal', 'leaderboard'] as const) {
        const s = metaIn(base.meta, phase, phase === 'lobby' ? -1 : 0);
        const locked = applyHostCommand(s, snapshot, lock(true), T, CFG);
        if (!locked.ok) throw new Error('fixture');
        expect(locked.meta.locked).toBe(true);
        expect(locked.meta.version).toBe(s.version + 1);
        check(locked.meta, lock(true), NOOP);
        check(locked.meta, lock(false), {
          phase,
          locked: false,
          effect: { kind: 'lock-changed', locked: false },
        });
      }
    });
  });

  describe('opening a question', () => {
    const open = (settings: { readSeconds: number }, cfg = CFG) => {
      const s = newSession(undefined, settings);
      const r = applyHostCommand(s.meta, s.snapshot, next(s.meta), T, cfg);
      if (!r.ok) throw new Error('fixture');
      return r.meta;
    };

    it.each([
      [0, 750],
      [1, 1000],
      [3, 3000],
      [10, 10_000],
    ])('readSeconds %i with a 750 ms floor opens after %i ms', (readSeconds, lead) => {
      const m = open({ readSeconds });
      expect(m.openAt).toBe(T + lead);
      expect(m.deadline).toBe(T + lead + 20_000);
    });

    it('applies the larger Lambda floor', () => {
      expect(open({ readSeconds: 1 }, { ...CFG, minLeadMs: 1500 }).openAt).toBe(T + 1500);
      expect(open({ readSeconds: 0 }, { ...CFG, minLeadMs: 1500 }).openAt).toBe(T + 1500);
      expect(open({ readSeconds: 4 }, { ...CFG, minLeadMs: 1500 }).openAt).toBe(T + 4000);
    });

    it('leaves the deadline null for an untimed question', () => {
      const s = newSession([questions()[Q.poll]!]);
      const r = applyHostCommand(s.meta, s.snapshot, next(s.meta), T, CFG);
      expect(r).toMatchObject({ ok: true, meta: { deadline: null, openAt: T + 3000 } });
    });

    it('resets closedAt when a new question opens', () => {
      const s = metaIn(base.meta, 'leaderboard', 0, { closedAt: 5 });
      const r = applyHostCommand(s, snapshot, next(s), T, CFG);
      expect(r).toMatchObject({ ok: true, meta: { closedAt: null } });
    });
  });

  describe('skip', () => {
    it('opens the next question and records the skipped one', () => {
      const s = metaIn(base.meta, 'question', Q.poll);
      check(s, skip(Q.poll), { ...opened(Q.wordcloud), skipped: [Q.poll] });
    });

    it('accumulates skipped indexes', () => {
      const s = metaIn(base.meta, 'question', 3, { skipped: [1] });
      check(s, skip(3), { ...opened(4), skipped: [1, 3] });
    });

    it('skipping the last question ends the session', () => {
      const s = metaIn(base.meta, 'question', Q.lastScored, { skipped: [2] });
      check(s, skip(Q.lastScored), { ...ended, skipped: [2, Q.lastScored] });
    });
  });

  it('rejects a command that is not a session transition', () => {
    const r = applyHostCommand(
      base.meta,
      snapshot,
      { type: 'host.kick', playerId: 'player-01' } as unknown as Cmd,
      T,
      CFG,
    );
    expect(r).toMatchObject({ ok: false, code: 'bad-request' });
  });

  it('never mutates its inputs', () => {
    const s = metaIn(base.meta, 'question', 0);
    const before = JSON.stringify(s);
    const snap = JSON.stringify(snapshot);
    for (const cmd of [next(s), close(0), skip(0), END, lock(true)])
      applyHostCommand(s, snapshot, cmd, T, CFG);
    expect(JSON.stringify(s)).toBe(before);
    expect(JSON.stringify(snapshot)).toBe(snap);
  });
});

describe('timerClose', () => {
  it('closes the open question like host.close {reason: timer}', () => {
    const s = metaIn(base.meta, 'question', 2);
    const viaTimer = timerClose(s, 2, T);
    const viaCommand = applyHostCommand(s, snapshot, close(2, 'timer'), T, CFG);
    expect(viaTimer).toEqual(viaCommand);
    expect(viaTimer).toMatchObject({
      ok: true,
      meta: { phase: 'revealing', closedAt: T, version: 8 },
      effect: { kind: 'closing', questionIndex: 2 },
    });
  });

  it('is a no-op for another question, another phase, and a repeat', () => {
    const q = metaIn(base.meta, 'question', 2);
    for (const s of [
      q,
      metaIn(base.meta, 'lobby', -1),
      metaIn(base.meta, 'revealing', 2),
      metaIn(base.meta, 'reveal', 2),
      metaIn(base.meta, 'leaderboard', 2),
      metaIn(base.meta, 'ended', 2),
    ]) {
      const r = timerClose(s, s === q ? 3 : 2, T);
      expect(r).toEqual({ ok: true, meta: s, effect: { kind: 'none' } });
      if (r.ok) expect(r.meta).toBe(s);
    }
  });
});
