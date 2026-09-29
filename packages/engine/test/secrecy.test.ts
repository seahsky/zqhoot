import { describe, expect, it } from 'vitest';
import type { AnswerPayload, Question } from '@zqhoot/protocol';
import {
  buildEnded,
  buildLeaderboard,
  buildPlayerSnapshot,
  buildQuestionMessage,
  toPublicQuestion,
} from '../src/index.ts';
import type { ResponseRecord, SessionMeta } from '../src/index.ts';
import {
  Q,
  SETTINGS,
  board,
  metaIn,
  newSession,
  openAtIndex,
  pid,
  player,
  questions,
  response,
  revealingAt,
} from './helpers.ts';

const ANSWER_KEYS = ['"correctOptionId"', '"correct"', '"requireApproval"'];
/** FinalStanding.correct is the player's own tally of right answers, not an answer key. */
const ANSWER_KEYS_AFTER_REVEALS = ['"correctOptionId"', '"requireApproval"'];

/** Same quiz, but every answer-derived field flipped. */
function flipped(q: Question): Question {
  switch (q.type) {
    case 'single': {
      const other = q.options.find((o) => o.id !== q.correctOptionId);
      return { ...q, correctOptionId: (other ?? q.options[0])!.id };
    }
    case 'truefalse':
      return { ...q, correct: !q.correct };
    case 'open':
      return { ...q, requireApproval: !q.requireApproval };
    default:
      return q;
  }
}

const every = questions().map((q, index) => ({ type: q.type, index, q }));

describe.each(every)('secrecy for $type question #$index', ({ index, q }) => {
  const real = newSession();
  const twin = newSession(questions().map(flipped));

  const ownAnswer = (meta: SessionMeta): ResponseRecord[] => {
    const payload: AnswerPayload =
      q.type === 'single' || q.type === 'poll'
        ? { kind: 'choice', optionId: q.options[0]!.id }
        : q.type === 'truefalse'
          ? { kind: 'boolean', value: true }
          : q.type === 'rating'
            ? { kind: 'rating', value: 3 }
            : { kind: 'text', text: 'hello there' };
    return [response(meta, pid(1), payload, { correct: true, points: 1000 })];
  };

  const messagesFor = (s: typeof real, phase: 'question' | 'revealing') => {
    const meta = phase === 'question' ? openAtIndex(s, index) : revealingAt(s, index);
    const me = player(1);
    return {
      message: buildQuestionMessage({ ...meta, phase: 'question' }, s.snapshot),
      snapshot: buildPlayerSnapshot({
        meta,
        snapshot: s.snapshot,
        player: me,
        players: [me],
        scoreboard: null,
        responses: ownAnswer(meta),
        result: null,
      }),
    };
  };

  it.each(['question', 'revealing'] as const)(
    'player-bound data in phase %s has no answer fields',
    (phase) => {
      const { message, snapshot } = messagesFor(real, phase);
      for (const value of [message, snapshot, toPublicQuestion(q, SETTINGS)]) {
        const json = JSON.stringify(value);
        for (const key of ANSWER_KEYS) expect(json, key).not.toContain(key);
      }
    },
  );

  it.each(['question', 'revealing'] as const)(
    'player-bound data in phase %s is identical whatever the correct answer is',
    (phase) => {
      const a = messagesFor(real, phase);
      const b = messagesFor(twin, phase);
      expect(JSON.stringify(a.message)).toBe(JSON.stringify(b.message));
      expect(JSON.stringify(a.snapshot)).toBe(JSON.stringify(b.snapshot));
    },
  );
});

describe('secrecy in the other pre-reveal phases', () => {
  const s = newSession();
  const me = player(1);
  const players = [me, player(2)];

  it('lobby, leaderboard and ended snapshots carry no answer fields', () => {
    const scoreboard = board({ [pid(1)]: { score: 100 }, [pid(2)]: { score: 50 } }, Q.single);
    const metas = [
      metaIn(s.meta, 'lobby', -1),
      metaIn(s.meta, 'leaderboard', Q.single),
      metaIn(s.meta, 'ended', Q.lastScored),
    ];
    for (const meta of metas) {
      const keys = meta.phase === 'ended' ? ANSWER_KEYS_AFTER_REVEALS : ANSWER_KEYS;
      const snap = buildPlayerSnapshot({
        meta,
        snapshot: s.snapshot,
        player: me,
        players,
        scoreboard,
        responses: [],
        result: null,
      });
      for (const key of keys) expect(JSON.stringify(snap)).not.toContain(key);
    }
    for (const m of buildLeaderboard({ meta: metas[1] as SessionMeta, scoreboard, players })
      .playerMessages) {
      for (const key of ANSWER_KEYS) expect(JSON.stringify(m.message)).not.toContain(key);
    }
    const ended = buildEnded({
      meta: metas[2] as SessionMeta,
      snapshot: s.snapshot,
      scoreboard,
      players,
    });
    for (const m of ended.playerMessages) {
      for (const key of ANSWER_KEYS_AFTER_REVEALS)
        expect(JSON.stringify(m.message)).not.toContain(key);
    }
  });

  it('does not leak the prompt when the quiz hides it on devices', () => {
    const hidden = newSession(undefined, { showQuestionOnDevices: false });
    const meta = openAtIndex(hidden, Q.single);
    const snap = buildPlayerSnapshot({
      meta,
      snapshot: hidden.snapshot,
      player: me,
      players,
      scoreboard: null,
      responses: [],
      result: null,
    });
    expect(JSON.stringify([snap, buildQuestionMessage(meta, hidden.snapshot)])).not.toContain(
      'Capital of France',
    );
  });
});
