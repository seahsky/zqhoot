import { describe, expect, it } from 'vitest';
import { HostSnapshot, PlayerSnapshot } from '@zqhoot/protocol';
import type { OutboundMessage, Question } from '@zqhoot/protocol';
import {
  applyHostCommand,
  buildEnded,
  buildHostSnapshot,
  buildLeaderboard,
  buildPlayerSnapshot,
  buildQuestionMessage,
  buildResultsCsv,
  checkJoinable,
  computeReveal,
  createSession,
  evaluateAnswer,
  normalizeNickname,
  revealFromStored,
  timerClose,
} from '../src/index.ts';
import type {
  PlayerRecord,
  ResponseRecord,
  Scoreboard,
  SessionMeta,
  StoredQuestionResult,
} from '../src/index.ts';
import { CFG, NOW, opt, player, quizOf, validServerMessage } from './helpers.ts';
import type { Cmd } from './helpers.ts';

const QUESTIONS: Question[] = [
  {
    id: 'q-first',
    type: 'single',
    prompt: 'Pick the first',
    timeLimitSec: 10,
    options: [opt('opt-alpha', 'A'), opt('opt-beta', 'B')],
    correctOptionId: 'opt-alpha',
    points: 1,
  },
  {
    id: 'q-poll',
    type: 'poll',
    prompt: 'Vote',
    timeLimitSec: null,
    options: [opt('opt-xray', 'X'), opt('opt-yank', 'Y')],
  },
  { id: 'q-tf', type: 'truefalse', prompt: 'True?', timeLimitSec: 10, correct: true, points: 2 },
];

const FORBIDDEN = ['"correctOptionId"', '"correct"', '"requireApproval"'];

/** A whole session driven through the public API only, the way the service layer will. */
describe('a complete game', () => {
  const { meta: created, snapshot } = createSession({
    sessionId: 'sess-flow1',
    pin: '424242',
    hostId: 'host-0001',
    quiz: quizOf(QUESTIONS, { streakBonus: true }),
    now: NOW,
    cfg: CFG,
  });
  let meta: SessionMeta = created;
  let now = NOW;
  let scoreboard: Scoreboard | null = null;
  const players: PlayerRecord[] = [];
  const responses: ResponseRecord[][] = [[], [], []];
  const results: StoredQuestionResult[] = [];
  const preRevealMessages: OutboundMessage[] = [];

  const host = (cmd: Cmd) => {
    const r = applyHostCommand(meta, snapshot, cmd, now, CFG);
    if (!r.ok) throw new Error(r.message);
    meta = r.meta;
    return r.effect;
  };
  const from = (): Cmd => ({
    type: 'host.next',
    from: { phase: meta.phase, questionIndex: meta.questionIndex },
  });

  const join = (nickname: string) => {
    expect(checkJoinable(meta, players.length, now)).toEqual({ ok: true });
    const n = normalizeNickname(nickname);
    if (!n.ok) throw new Error(n.reason);
    const p = player(players.length + 1, {
      nickname: n.nickname,
      nicknameKey: n.key,
      joinedAt: now,
    });
    players.push(p);
    return p;
  };

  const answer = (
    who: PlayerRecord,
    payload: Parameters<typeof evaluateAnswer>[0]['payload'],
    at: number,
  ) => {
    const existing = responses[meta.questionIndex]!.filter((r) => r.playerId === who.playerId);
    const d = evaluateAnswer({
      meta,
      snapshot,
      playerId: who.playerId,
      questionIndex: meta.questionIndex,
      payload,
      receivedAt: at,
      existing,
      cfg: CFG,
    });
    if (d.kind === 'accept') responses[meta.questionIndex]!.push(d.response);
    return d;
  };

  const closeAndReveal = () => {
    const closing = host(from());
    expect(closing).toMatchObject({ kind: 'closing', questionIndex: meta.questionIndex });
    now += 1000;
    const out = computeReveal({
      meta,
      snapshot,
      responses: responses[meta.questionIndex]!,
      players,
      scoreboard,
      now,
    });
    meta = out.meta;
    scoreboard = out.scoreboard;
    results.push(out.stored);
    for (const m of out.playerMessages) expect(validServerMessage(m.message)).toBe(true);
    return out;
  };

  it('plays through lobby, three questions, a leaderboard and the podium', () => {
    // Lobby: players join, one is refused for a bad nickname.
    const ann = join('Ann');
    const bob = join('Bob');
    const cy = join('Cy');
    expect(normalizeNickname('fuck')).toEqual({ ok: false, reason: 'inappropriate' });

    // Question 0 (single, scored).
    now += 5000;
    expect(host(from())).toEqual({ kind: 'question-opened', questionIndex: 0 });
    const q0 = buildQuestionMessage(meta, snapshot);
    preRevealMessages.push(q0);
    expect(validServerMessage(q0)).toBe(true);
    const openAt = meta.openAt as number;
    expect(openAt).toBe(now + 3000);

    expect(answer(ann, { kind: 'choice', optionId: 'opt-alpha' }, openAt - 251).kind).toBe(
      'reject',
    );
    expect(answer(ann, { kind: 'choice', optionId: 'opt-alpha' }, openAt + 200)).toMatchObject({
      kind: 'accept',
    });
    expect(answer(ann, { kind: 'choice', optionId: 'opt-alpha' }, openAt + 300).kind).toBe(
      'duplicate',
    );
    expect(answer(ann, { kind: 'choice', optionId: 'opt-beta' }, openAt + 400)).toMatchObject({
      kind: 'reject',
      reason: 'limit',
    });
    expect(answer(bob, { kind: 'choice', optionId: 'opt-beta' }, openAt + 2000).kind).toBe(
      'accept',
    );
    // Cy answers after the deadline plus grace.
    expect(
      answer(cy, { kind: 'choice', optionId: 'opt-alpha' }, (meta.deadline as number) + 751),
    ).toMatchObject({
      kind: 'reject',
      reason: 'too-late',
    });

    // Every player-facing snapshot before the reveal is free of answer fields.
    for (const p of players) {
      const snap = buildPlayerSnapshot({
        meta,
        snapshot,
        player: p,
        players,
        scoreboard,
        responses: responses[0]!.filter((r) => r.playerId === p.playerId),
        result: null,
      });
      expect(PlayerSnapshot.safeParse(snap).success).toBe(true);
      for (const key of FORBIDDEN) expect(JSON.stringify(snap)).not.toContain(key);
    }

    // The timer fires (VM) and the reveal runs; the host then presses next twice by mistake.
    now = meta.deadline as number;
    const timer = timerClose(meta, 0, now);
    if (!timer.ok) throw new Error('timer');
    meta = timer.meta;
    expect(meta.phase).toBe('revealing');
    expect(host({ type: 'host.close', questionIndex: 0, reason: 'manual' })).toEqual({
      kind: 'none',
    });
    expect(host(from())).toEqual({ kind: 'retry-reveal', questionIndex: 0 });

    now += 1000;
    const out = computeReveal({
      meta,
      snapshot,
      responses: responses[0]!,
      players,
      scoreboard,
      now,
    });
    // A crash after the result was stored: the retry rebuilds the same messages.
    const rebuilt = revealFromStored({ meta, stored: out.stored, players });
    expect(rebuilt.playerMessages).toEqual(out.playerMessages);
    expect(rebuilt.meta).toEqual(out.meta);
    meta = out.meta;
    scoreboard = out.scoreboard;
    results.push(out.stored);
    expect(out.hostResult).toMatchObject({
      answered: 2,
      totalPlayers: 3,
      counts: { 'opt-alpha': 1, 'opt-beta': 1 },
    });
    expect(scoreboard.players[ann.playerId]?.score).toBeGreaterThan(900);
    expect(scoreboard.players[bob.playerId]?.score).toBe(0);
    // Refuses to score the same question twice.
    expect(() =>
      computeReveal({
        meta: { ...meta, phase: 'revealing' },
        snapshot,
        responses: responses[0]!,
        players,
        scoreboard,
        now,
      }),
    ).toThrow(/already applied/);

    // Reveal -> leaderboard.
    now += 4000;
    expect(host(from())).toEqual({ kind: 'leaderboard', questionIndex: 0 });
    const board1 = buildLeaderboard({ meta, scoreboard, players });
    expect(board1.entries.map((e) => [e.nickname, e.rank])).toEqual([
      ['Ann', 1],
      ['Bob', 2],
      ['Cy', 2],
    ]);
    for (const m of board1.playerMessages) expect(validServerMessage(m.message)).toBe(true);

    // Question 1 (untimed poll) opens after the leaderboard; a late joiner arrives mid-question.
    now += 2000;
    expect(host(from())).toEqual({ kind: 'question-opened', questionIndex: 1 });
    expect(meta.deadline).toBeNull();
    const dee = join('Dee');
    now = (meta.openAt as number) + 10_000;
    expect(answer(dee, { kind: 'choice', optionId: 'opt-yank' }, now).kind).toBe('accept');
    expect(answer(ann, { kind: 'choice', optionId: 'opt-xray' }, now + 60_000).kind).toBe('accept');
    host({ type: 'host.next', from: { phase: 'question', questionIndex: 1 } });
    now += 1000;
    const pollOut = computeReveal({
      meta,
      snapshot,
      responses: responses[1]!,
      players,
      scoreboard,
      now,
    });
    meta = pollOut.meta;
    scoreboard = pollOut.scoreboard;
    results.push(pollOut.stored);
    expect(pollOut.hostResult).toMatchObject({
      counts: { 'opt-xray': 1, 'opt-yank': 1 },
      answered: 2,
      totalPlayers: 4,
    });
    expect(scoreboard.appliedThrough).toBe(1);

    // Unscored reveal goes straight to the last question.
    expect(host(from())).toEqual({ kind: 'question-opened', questionIndex: 2 });
    const start = meta.openAt as number;
    now = start + 100;
    answer(ann, { kind: 'boolean', value: true }, now);
    answer(bob, { kind: 'boolean', value: true }, now + 5000);
    answer(dee, { kind: 'boolean', value: false }, now);
    const last = closeAndReveal();
    // Ann: streak 1 -> 2 across scored questions (the poll left it alone), so the bonus applies.
    expect(last.stored.outcomes[ann.playerId]).toMatchObject({
      correct: true,
      streak: 2,
      streakBonus: 200,
    });
    expect(last.stored.outcomes[bob.playerId]).toMatchObject({
      correct: true,
      streak: 1,
      streakBonus: 0,
    });
    expect(last.stored.outcomes[dee.playerId]).toMatchObject({ correct: false, streak: 0 });

    // Leaderboard, then the end.
    expect(host(from())).toEqual({ kind: 'leaderboard', questionIndex: 2 });
    expect(host(from())).toEqual({ kind: 'ended' });
    expect(meta).toMatchObject({
      phase: 'ended',
      endedAt: now,
      openAt: null,
      deadline: null,
      closedAt: null,
    });
    expect(host(from())).toEqual({ kind: 'none' });
    expect(checkJoinable(meta, players.length, now)).toEqual({ ok: false, code: 'session-ended' });

    const ended = buildEnded({ meta, snapshot, scoreboard, players });
    expect(ended.podium.map((e) => e.nickname)).toEqual(['Ann', 'Bob', 'Cy']);
    expect(ended.playerMessages).toHaveLength(4);
    for (const m of ended.playerMessages) expect(validServerMessage(m.message)).toBe(true);
    const annEnd = ended.playerMessages.find((m) => m.playerId === ann.playerId)?.message;
    expect(annEnd).toMatchObject({
      type: 'ended',
      you: { rank: 1, correct: 2, answeredScored: 2, scoredQuestions: 2 },
    });

    const hostSnap = buildHostSnapshot({
      meta,
      snapshot,
      players,
      connectedPlayerIds: new Set([ann.playerId]),
      scoreboard,
      result: null,
    });
    expect(HostSnapshot.safeParse(hostSnap).success).toBe(true);
    expect(hostSnap.podium).toHaveLength(3);

    const csv = buildResultsCsv({
      meta,
      snapshot,
      players,
      scoreboard,
      results,
      responsesByQuestion: responses,
    });
    // 3 questions x 4 players, plus the header.
    expect(csv.trimEnd().split('\r\n')).toHaveLength(1 + 12);
    expect(csv.startsWith('﻿')).toBe(true);

    // Everything the players were sent while questions were open had no answer fields.
    for (const m of preRevealMessages)
      for (const key of FORBIDDEN) expect(JSON.stringify(m)).not.toContain(key);
  });
});
