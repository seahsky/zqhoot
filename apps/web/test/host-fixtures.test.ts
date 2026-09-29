import { describe, expect, it } from 'vitest';
import { LIMITS } from '@zqhoot/protocol';
import { EDIT_QUIZ } from '../src/dev/fixtures/edit.ts';
import { DASHBOARD_QUIZZES, HOST_LIVE_FIXTURES } from '../src/dev/fixtures/host.ts';
import {
  LONGEST_NICKNAME,
  LONG_WORD_NICKNAMES,
  PLAYERS,
  QUIZ_ID,
  QUIZ_QUESTIONS,
  hostRoster,
  hostSnapshot,
  names,
  quizIndexOf,
  singleQ,
} from '../src/dev/fixtures/hostSnapshots.ts';
import { PRESENT_FIXTURES } from '../src/dev/fixtures/present.ts';
import type { HostState } from '../src/state/host.ts';

/** The host and presenter fixtures describe one game of one quiz, so the gallery reads as one session. */

/** Players a screen says exist: the figures its snapshot or live stats carry. */
function playersCounted(state: HostState): number[] {
  const snap = state.snapshot;
  return [snap?.result?.totalPlayers, state.live?.stats?.totalPlayers].filter(
    (n): n is number => n !== undefined,
  );
}

describe('fixture nicknames', () => {
  it('read as names, never as words run together', () => {
    const all = names(400);
    expect(all.filter((n) => /[a-z]the Bold/.test(n))).toEqual([]);
    expect(all).toContain('Jo the Bold');
    for (const n of all) expect(n.length).toBeLessThanOrEqual(LIMITS.nicknameMaxGraphemes);
  });

  it('the host roster puts the longest allowed nickname first, where the list shows it', () => {
    expect(LONGEST_NICKNAME).toHaveLength(LIMITS.nicknameMaxGraphemes);
    const room = hostRoster([3]);
    expect(room).toHaveLength(PLAYERS);
    expect(room.at(-1)?.nickname).toBe(LONGEST_NICKNAME);
    expect(new Set(room.map((r) => r.nickname)).size).toBe(PLAYERS);
    expect(room[3]?.connected).toBe(false);
  });

  it('the host roster also holds 16-character nicknames that are one word, at the top of the list', () => {
    const room = hostRoster();
    // Newest first in the list, so the last entries of the roster head it.
    const top = room.slice(-3).map((r) => r.nickname);
    expect(top).toEqual([...LONG_WORD_NICKNAMES, LONGEST_NICKNAME]);
    for (const nickname of LONG_WORD_NICKNAMES) {
      expect(nickname).toHaveLength(LIMITS.nicknameMaxGraphemes);
      expect(nickname).not.toMatch(/\s/);
    }
    expect(new Set(room.map((r) => r.nickname)).size).toBe(PLAYERS);
  });
});

describe('one game, one player total', () => {
  it('every host-live fixture has the same room, and its figures count exactly that room', () => {
    for (const [id, state] of Object.entries(HOST_LIVE_FIXTURES)) {
      // A refused connection (the forbidden screen) never joined the room.
      if (state.ended !== null) continue;
      expect(state.roster, id).toHaveLength(PLAYERS);
      for (const n of playersCounted(state)) expect(n, id).toBe(PLAYERS);
    }
  });

  it('every presenter fixture that counts players counts its own roster', () => {
    for (const [id, fx] of Object.entries(PRESENT_FIXTURES)) {
      const room = fx.state.roster.length;
      for (const n of playersCounted(fx.state)) expect(n, id).toBe(room);
    }
  });

  it('nobody answered who is not in the room', () => {
    for (const [id, state] of Object.entries(HOST_LIVE_FIXTURES)) {
      const data = state.snapshot?.result ?? state.live?.stats;
      if (data) expect(data.answered, id).toBeLessThanOrEqual(PLAYERS);
    }
    for (const [id, fx] of Object.entries(PRESENT_FIXTURES)) {
      const data = fx.state.snapshot?.result ?? fx.state.live?.stats;
      if (data) expect(data.answered, id).toBeLessThanOrEqual(data.totalPlayers);
    }
  });
});

describe('one quiz', () => {
  it('a question is found by identity, and one that is not in the quiz is an error', () => {
    QUIZ_QUESTIONS.forEach((q, i) => expect(quizIndexOf(q)).toBe(i));
    // Same type and content, but not the quiz's own question: it must not resolve to it.
    expect(() => quizIndexOf({ ...singleQ, id: 'question-elsewhere' })).toThrow(
      /not in the demo quiz/,
    );
  });

  it('the dashboard counts the questions the editor shows', () => {
    const quiz = DASHBOARD_QUIZZES.find((q) => q.id === QUIZ_ID);
    expect(quiz?.questionCount).toBe(EDIT_QUIZ.questions.length);
    expect(hostSnapshot().totalQuestions).toBe(EDIT_QUIZ.questions.length);
  });

  it('a live question is the same type as that question number is in the editor', () => {
    for (const [id, state] of Object.entries(HOST_LIVE_FIXTURES)) {
      const snap = state.snapshot;
      if (!snap?.question) continue;
      expect(snap.question.question.type, id).toBe(EDIT_QUIZ.questions[snap.questionIndex]?.type);
      expect(snap.totalQuestions, id).toBe(EDIT_QUIZ.questions.length);
    }
  });
});
