import { expect, it } from 'vitest';
import type { AnswerPayload } from '@zqhoot/protocol';
import { CLOCK_START, HOST_TOKENS, describeWithStores } from './harness.ts';
import { allTypesQuiz } from './fixtures.ts';

const NICKS = ['Ann', 'Bob', 'Cy', 'Dee', 'Eve', 'Fay', 'Gus', 'Hal', 'Ivy', 'Jon', 'Kai', 'Liv'];

const choice = (optionId: string): AnswerPayload => ({ kind: 'choice', optionId });
const bool = (value: boolean): AnswerPayload => ({ kind: 'boolean', value });
const text = (t: string): AnswerPayload => ({ kind: 'text', text: t });
const rating = (value: number): AnswerPayload => ({ kind: 'rating', value });

/** True when `key` appears anywhere in the JSON value, as an object key. */
function hasKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((v) => hasKey(v, key));
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(([k, v]) => k === key || hasKey(v, key));
}

describeWithStores('full game scenario', (make) => {
  it('plays every question type with reconnects, a kick, moderation and a CSV export', async () => {
    const h = await make({ scheduler: true });
    const hostToken = HOST_TOKENS.a;

    // ---- Host prepares the game over HTTP ------------------------------------------------
    const quiz = await h.createQuiz(allTypesQuiz());
    expect(quiz).toMatchObject({ ownerId: h.hostIds.a, version: 1 });
    const { sessionId, pin } = await h.startSession(quiz.id);
    const control = await h.hostHello('control', sessionId);
    const present = await h.hostHello('present', sessionId, 'a', 'present');
    const hostSnapshot = h.transport.last(control, 'welcome');
    expect(hostSnapshot).toMatchObject({
      role: 'host',
      snapshot: { phase: 'lobby', pin, totalQuestions: 6, hasScoredQuestions: true },
    });

    // ---- 12 players join: one invalid nickname, one collision ----------------------------
    const conn: Record<string, string> = {};
    const playerId: Record<string, string> = {};
    const token: Record<string, string> = {};
    const joinAs = async (name: string, ...attempts: string[]) => {
      const id = h.cid(name.toLowerCase());
      await h.service.onConnect(id, {});
      for (const nickname of attempts) await h.send(id, { type: 'join', v: 1, pin, nickname });
      const welcome = h.transport.last(id, 'welcome');
      if (welcome.role !== 'player' || welcome.credentials === undefined) throw new Error('join');
      conn[name] = id;
      playerId[name] = welcome.credentials.playerId;
      token[name] = welcome.credentials.token;
      return id;
    };
    for (const name of NICKS) {
      if (name === 'Dee') await joinAs(name, 'x', 'Dee');
      else if (name === 'Eve') await joinAs(name, 'ANN', 'Eve');
      else await joinAs(name, name);
    }
    expect(h.transport.ofType(conn.Dee!, 'error')).toMatchObject([
      { code: 'nickname-invalid', message: 'too-short', ref: 'join' },
    ]);
    expect(h.transport.ofType(conn.Eve!, 'error')).toMatchObject([{ code: 'nickname-taken' }]);
    const rosterUpserts = h.transport
      .ofType(control, 'roster')
      .flatMap((r) => r.upsert.map((e) => [e.nickname, e.connected]));
    expect(rosterUpserts).toEqual(NICKS.map((n) => [n, true]));
    expect(h.transport.ofType(present, 'roster')).toHaveLength(12);
    const welcomeAnn = h.transport.last(conn.Ann!, 'welcome');
    expect(welcomeAnn).toMatchObject({
      role: 'player',
      snapshot: { phase: 'lobby', questionIndex: -1, you: { nickname: 'Ann', score: 0 } },
    });

    const ans = (nick: string, index: number, payload: AnswerPayload, receivedAt: number) =>
      h.send(conn[nick]!, { type: 'answer', questionIndex: index, payload }, receivedAt);
    const ack = (nick: string) => h.transport.last(conn[nick]!, 'answer.ack');
    const next = (phase: string, questionIndex: number) =>
      h.send(control, { type: 'host.next', from: { phase, questionIndex } } as never);
    const hostState = () => h.transport.last(control, 'host.state').snapshot;

    // ---- Question 1: single choice, 20 s, 1x points --------------------------------------
    await next('lobby', -1);
    const q0 = h.transport.last(conn.Ann!, 'question');
    const openAt0 = q0.openAt;
    const deadline0 = openAt0 + 20_000;
    expect(q0).toMatchObject({ index: 0, total: 6, deadline: deadline0, sv: 2 });
    expect(openAt0).toBe(h.clock.now() + 3000);
    expect(h.scheduler.scheduled.at(-1)).toEqual({
      sessionId,
      questionIndex: 0,
      at: deadline0 + 750,
    });
    for (const name of NICKS) expect(h.transport.ofType(conn[name]!, 'question')).toHaveLength(1);
    expect(hostState()).toMatchObject({ phase: 'question', questionIndex: 0 });
    expect(h.transport.last(present, 'host.state').snapshot.question?.question).toMatchObject({
      correctOptionId: 'opt-paris',
    });

    // Elapsed times chosen so 1000 * (1 - 0.6 * (t - 250) / 19750) is round: 5187.5 ms would be
    // 0.25, so use 0.1 -> 2225 ms (940), 0.2 -> 4200 ms (880), 0.5 -> 10125 ms (700).
    await ans('Ann', 0, choice('opt-paris'), openAt0 + 100); // inside the 250 ms window: 1000
    await ans('Bob', 0, choice('opt-paris'), openAt0 + 10_125); // 700
    await ans('Cy', 0, choice('opt-paris'), openAt0 + 20_000); // exactly the deadline: 400
    await ans('Dee', 0, choice('opt-rome'), openAt0 + 500); // wrong: 0
    await ans('Fay', 0, choice('opt-paris'), openAt0 + 4200); // 880
    await ans('Gus', 0, choice('opt-paris'), openAt0 + 250); // window edge: 1000
    await ans('Hal', 0, choice('opt-paris'), openAt0 - 300);
    expect(ack('Hal')).toMatchObject({ status: 'rejected', reason: 'too-early', entries: 0 });
    await ans('Hal', 0, choice('opt-paris'), openAt0 + 2225); // 940
    expect(ack('Hal')).toMatchObject({ status: 'accepted', entries: 1 });
    await ans('Ivy', 0, choice('opt-paris'), deadline0 + 751);
    expect(ack('Ivy')).toMatchObject({ status: 'rejected', reason: 'too-late' });
    await ans('Jon', 0, choice('opt-paris'), openAt0 + 1000); // 977
    await ans('Jon', 0, choice('opt-paris'), openAt0 + 1500);
    expect(ack('Jon')).toMatchObject({ status: 'duplicate', entries: 1 });
    await ans('Jon', 0, choice('opt-rome'), openAt0 + 2000);
    expect(ack('Jon')).toMatchObject({ status: 'rejected', reason: 'limit', entries: 1 });
    await ans('Kai', 0, choice('opt-rome'), openAt0 + 3000); // wrong: 0
    for (const name of ['Ann', 'Bob', 'Cy', 'Dee', 'Fay', 'Gus', 'Kai']) {
      expect(ack(name)).toMatchObject({ status: 'accepted', entries: 1 });
    }

    await h.send(control, { type: 'host.stats', questionIndex: 0 });
    expect(h.transport.last(control, 'stats')).toMatchObject({
      questionIndex: 0,
      stats: {
        type: 'single',
        answered: 9,
        totalPlayers: 12,
        counts: { 'opt-paris': 7, 'opt-rome': 2, 'opt-oslo': 0 },
      },
    });

    // Kai's phone drops mid-question; hosts see it, then Kai resumes on a new connection.
    await h.service.onDisconnect(conn.Kai!);
    expect(h.transport.last(control, 'roster').upsert).toEqual([
      { playerId: playerId.Kai, nickname: 'Kai', connected: false },
    ]);
    conn.Kai = h.cid('kai-2');
    await h.send(conn.Kai, {
      type: 'resume',
      v: 1,
      sessionId,
      playerId: playerId.Kai!,
      token: token.Kai!,
    });
    const kaiWelcome = h.transport.last(conn.Kai, 'welcome');
    expect(kaiWelcome).toMatchObject({
      role: 'player',
      snapshot: {
        phase: 'question',
        questionIndex: 0,
        responses: [choice('opt-rome')],
        question: { openAt: openAt0, deadline: deadline0, question: { type: 'single' } },
        you: { nickname: 'Kai', score: 0 },
      },
    });
    expect(kaiWelcome).not.toHaveProperty('credentials');
    expect(h.transport.last(control, 'roster').upsert).toEqual([
      { playerId: playerId.Kai, nickname: 'Kai', connected: true },
    ]);

    // Close and reveal (the VM settles for 0 ms).
    h.clock.set(deadline0 + 200);
    await h.send(control, { type: 'host.close', questionIndex: 0, reason: 'manual' });
    expect(h.scheduler.cancelled).toContain(sessionId);
    const reveal0 = (nick: string) => h.transport.last(conn[nick]!, 'reveal');
    expect(reveal0('Ann')).toMatchObject({
      index: 0,
      sv: 4,
      result: {
        type: 'single',
        answered: 9,
        totalPlayers: 12,
        correctOptionId: 'opt-paris',
        counts: { 'opt-paris': 7, 'opt-rome': 2, 'opt-oslo': 0 },
      },
      you: { answered: true, correct: true, points: 1000, streakBonus: 0, score: 1000, rank: 1 },
    });
    // Points after Q1: Ann 1000, Gus 1000, Jon 977, Hal 940, Fay 880, Bob 700, Cy 400, rest 0.
    const expectedQ1: Record<string, [points: number, rank: number]> = {
      Ann: [1000, 1],
      Gus: [1000, 1],
      Jon: [977, 3],
      Hal: [940, 4],
      Fay: [880, 5],
      Bob: [700, 6],
      Cy: [400, 7],
      Dee: [0, 8],
      Eve: [0, 8],
      Ivy: [0, 8],
      Kai: [0, 8],
      Liv: [0, 8],
    };
    for (const [nick, [points, rank]] of Object.entries(expectedQ1)) {
      expect(reveal0(nick).you, nick).toMatchObject({ score: points, rank });
    }
    expect(reveal0('Ivy').you).toMatchObject({ answered: false, correct: false, points: 0 });
    expect(hostState()).toMatchObject({ phase: 'reveal', result: { type: 'single', answered: 9 } });

    // Cy reconnects mid-reveal while the old socket is still registered: the snapshot carries the
    // reveal, and the stale socket going away afterwards does not mark Cy disconnected.
    const cyOld = conn.Cy!;
    conn.Cy = h.cid('cy-2');
    await h.send(conn.Cy, {
      type: 'resume',
      v: 1,
      sessionId,
      playerId: playerId.Cy!,
      token: token.Cy!,
    });
    expect(h.transport.last(conn.Cy, 'welcome')).toMatchObject({
      role: 'player',
      snapshot: {
        phase: 'reveal',
        questionIndex: 0,
        responses: [choice('opt-paris')],
        reveal: {
          result: { type: 'single', correctOptionId: 'opt-paris', answered: 9 },
          you: { answered: true, correct: true, points: 400, score: 400, rank: 7 },
        },
      },
    });
    const rosterBefore = h.transport.ofType(control, 'roster').length;
    await h.service.onDisconnect(cyOld);
    expect(h.transport.ofType(control, 'roster')).toHaveLength(rosterBefore);

    // Leaderboard after question 1.
    await next('reveal', 0);
    const board0 = h.transport.last(conn.Bob!, 'leaderboard');
    expect(board0.entries.map((e) => [e.nickname, e.rank, e.score])).toEqual([
      ['Ann', 1, 1000],
      ['Gus', 1, 1000],
      ['Jon', 3, 977],
      ['Hal', 4, 940],
      ['Fay', 5, 880],
    ]);
    expect(board0.you).toEqual({ score: 700, rank: 6, behind: { nickname: 'Fay', points: 180 } });
    expect(hostState()).toMatchObject({ phase: 'leaderboard' });
    expect(hostState().leaderboard).toHaveLength(10);

    // ---- Question 2: true/false, 10 s, 2x points, streak bonus ---------------------------
    await next('leaderboard', 0);
    const q1 = h.transport.last(conn.Ann!, 'question');
    const openAt1 = q1.openAt;
    expect(q1).toMatchObject({ index: 1, deadline: openAt1 + 10_000 });
    expect(h.transport.ofType(conn.Cy!, 'question')).toMatchObject([{ index: 1 }]);
    expect(h.transport.ofType(cyOld, 'question')).toMatchObject([{ index: 0 }]); // gone by now
    // limit 10 s: r = (t - 250) / 9750. 5125 -> 0.5 (1400), 2200 -> 0.2 (1760), 10000 -> 1 (800).
    await ans('Ann', 1, bool(false), openAt1 + 250); // 2000 + streak bonus 200
    await ans('Bob', 1, bool(false), openAt1 + 5125); // 1400 + 200
    await ans('Cy', 1, bool(true), openAt1 + 100); // wrong
    await ans('Dee', 1, bool(false), openAt1 + 10_000); // 800, streak restarts at 1: no bonus
    await ans('Eve', 1, bool(false), openAt1 + 250); // 2000
    await ans('Fay', 1, bool(false), openAt1 + 2200); // 1760 + 200
    await ans('Hal', 1, bool(false), openAt1 + 250); // 2000 + 200
    await ans('Ivy', 1, bool(false), openAt1 + 250); // 2000
    await ans('Jon', 1, bool(false), openAt1 + 250); // 2000 + 200
    await ans('Kai', 1, bool(false), openAt1 + 250); // 2000
    await ans('Liv', 1, bool(false), openAt1 + 250); // 2000
    h.clock.set(openAt1 + 11_000);
    await h.send(control, { type: 'host.close', questionIndex: 1, reason: 'manual' });
    // Scores: Ann 3200, Jon 3177, Hal 3140, Fay 2840, Bob 2300, Eve/Ivy/Kai/Liv 2000, Gus 1000,
    // Dee 800, Cy 400.
    const expectedQ2: Record<string, [total: number, rank: number, points: number, bonus: number]> =
      {
        Ann: [3200, 1, 2000, 200],
        Jon: [3177, 2, 2000, 200],
        Hal: [3140, 3, 2000, 200],
        Fay: [2840, 4, 1760, 200],
        Bob: [2300, 5, 1400, 200],
        Eve: [2000, 6, 2000, 0],
        Ivy: [2000, 6, 2000, 0],
        Kai: [2000, 6, 2000, 0],
        Liv: [2000, 6, 2000, 0],
        Gus: [1000, 10, 0, 0],
        Dee: [800, 11, 800, 0],
        Cy: [400, 12, 0, 0],
      };
    for (const [nick, [total, rank, points, bonus]] of Object.entries(expectedQ2)) {
      expect(h.transport.last(conn[nick]!, 'reveal').you, nick).toMatchObject({
        score: total,
        rank,
        points,
        streakBonus: bonus,
      });
    }
    expect(h.transport.last(conn.Ann!, 'reveal').result).toEqual({
      type: 'truefalse',
      answered: 11,
      totalPlayers: 12,
      correct: false,
      counts: { true: 1, false: 10 },
    });
    expect(h.transport.last(conn.Cy!, 'reveal').you).toMatchObject({ correct: false, streak: 0 });
    const scoreboard = await h.store.getScoreboard(sessionId);
    expect(scoreboard).toMatchObject({ appliedThrough: 1, version: 2 });
    expect(
      Object.fromEntries(NICKS.map((n) => [n, scoreboard!.players[playerId[n]!]!.score])),
    ).toEqual({
      Ann: 3200,
      Bob: 2300,
      Cy: 400,
      Dee: 800,
      Eve: 2000,
      Fay: 2840,
      Gus: 1000,
      Hal: 3140,
      Ivy: 2000,
      Jon: 3177,
      Kai: 2000,
      Liv: 2000,
    });

    await next('reveal', 1);
    const board1 = h.transport.last(conn.Eve!, 'leaderboard');
    expect(board1.entries.map((e) => [e.nickname, e.rank, e.score, e.delta])).toEqual([
      ['Ann', 1, 3200, 2200],
      ['Jon', 2, 3177, 2200],
      ['Hal', 3, 3140, 2200],
      ['Fay', 4, 2840, 1960],
      ['Bob', 5, 2300, 1600],
    ]);
    expect(board1.you).toEqual({ score: 2000, rank: 6, behind: { nickname: 'Bob', points: 300 } });

    // ---- Question 3: untimed poll; Liv is kicked ------------------------------------------
    await next('leaderboard', 1);
    const q2 = h.transport.last(conn.Ann!, 'question');
    expect(q2).toMatchObject({ index: 2, deadline: null });
    expect(h.scheduler.scheduled.filter((s) => s.questionIndex === 2)).toEqual([]);
    await ans('Ann', 2, choice('opt-red'), q2.openAt + 10);
    await ans('Bob', 2, choice('opt-blue'), q2.openAt + 20);
    await ans('Cy', 2, choice('opt-red'), q2.openAt + 30);
    await ans('Dee', 2, choice('opt-blue'), q2.openAt + 40);
    await ans('Eve', 2, choice('opt-red'), q2.openAt + 50);
    await h.send(control, { type: 'host.kick', playerId: playerId.Liv! });
    expect(h.transport.ofType(conn.Liv!, 'kicked')).toHaveLength(1);
    expect(h.transport.closed(conn.Liv!)).toBe(true);
    expect(h.transport.last(control, 'roster')).toMatchObject({
      upsert: [],
      removed: [playerId.Liv],
    });
    expect(await h.store.getConnection(conn.Liv!)).toBeNull();
    await ans('Liv', 2, choice('opt-blue'), q2.openAt + 60);
    expect(h.transport.last(conn.Liv!, 'error')).toMatchObject({ code: 'unauthorized' });
    await h.send(h.cid('liv-2'), {
      type: 'resume',
      v: 1,
      sessionId,
      playerId: playerId.Liv!,
      token: token.Liv!,
    });
    expect(h.transport.last(h.cid('liv-2'), 'error')).toMatchObject({ code: 'kicked' });
    expect(h.transport.closed(h.cid('liv-2'))).toBe(true);
    // A wrong token is refused before anything about the player is revealed.
    await h.send(h.cid('liv-3'), {
      type: 'resume',
      v: 1,
      sessionId,
      playerId: playerId.Liv!,
      token: 'x'.repeat(43),
    });
    expect(h.transport.last(h.cid('liv-3'), 'error')).toMatchObject({ code: 'unauthorized' });

    await h.send(control, { type: 'host.close', questionIndex: 2, reason: 'manual' });
    expect(h.transport.last(conn.Ann!, 'reveal').result).toEqual({
      type: 'poll',
      answered: 5,
      totalPlayers: 11,
      counts: { 'opt-red': 3, 'opt-blue': 2 },
    });
    expect(h.transport.last(conn.Ann!, 'reveal').you).not.toHaveProperty('correct');
    // Liv saw the first two reveals and nothing after the kick.
    expect(h.transport.ofType(conn.Liv!, 'reveal').map((r) => r.index)).toEqual([0, 1]);

    // ---- Question 4: word cloud, 3 entries -----------------------------------------------
    await next('reveal', 2); // an unscored reveal goes straight to the next question
    const q3 = h.transport.last(conn.Ann!, 'question');
    expect(q3).toMatchObject({ index: 3, deadline: q3.openAt + 30_000 });
    const t3 = q3.openAt;
    await ans('Ann', 3, text('Sun'), t3 + 100);
    expect(ack('Ann')).toMatchObject({ status: 'accepted', entries: 1 });
    await ans('Ann', 3, text('sun '), t3 + 200); // same word once normalised
    expect(ack('Ann')).toMatchObject({ status: 'duplicate', entries: 1 });
    await ans('Ann', 3, text('Moon'), t3 + 300);
    expect(ack('Ann')).toMatchObject({ status: 'accepted', entries: 2 });
    await ans('Ann', 3, text('Star'), t3 + 400);
    expect(ack('Ann')).toMatchObject({ status: 'accepted', entries: 3 });
    await ans('Ann', 3, text('Comet'), t3 + 500);
    expect(ack('Ann')).toMatchObject({ status: 'rejected', reason: 'limit', entries: 3 });
    await ans('Bob', 3, text('sun'), t3 + 600);
    await ans('Cy', 3, text('MOON'), t3 + 700);
    await ans('Dee', 3, text('fuck'), t3 + 800); // stored hidden, never in the cloud
    await ans('Eve', 3, text('sun'), t3 + 900);
    expect(ack('Dee')).toMatchObject({ status: 'accepted' });
    await h.send(control, { type: 'host.stats', questionIndex: 3 });
    expect(h.transport.last(control, 'stats').stats).toEqual({
      type: 'wordcloud',
      answered: 5,
      totalPlayers: 11,
      words: [
        { text: 'sun', count: 3 },
        { text: 'moon', count: 2 },
        { text: 'star', count: 1 },
      ],
    });
    await h.send(control, { type: 'host.close', questionIndex: 3, reason: 'manual' });
    expect(h.transport.last(conn.Bob!, 'reveal').result).toEqual({
      type: 'wordcloud',
      answered: 5,
      totalPlayers: 11,
      words: [
        { text: 'sun', count: 3 },
        { text: 'moon', count: 2 },
        { text: 'star', count: 1 },
      ],
    });

    // ---- Question 5: open-ended with moderation ------------------------------------------
    await next('reveal', 3);
    const q4 = h.transport.last(conn.Ann!, 'question');
    const t4 = q4.openAt;
    expect(q4.question).toMatchObject({ type: 'open', maxEntries: 2 });
    expect(JSON.stringify(q4)).not.toContain('requireApproval');
    await ans('Ann', 4, text('Great quiz'), t4 + 1000);
    await ans('Bob', 4, text('Too fast'), t4 + 2000);
    await ans('Cy', 4, text('Loved it'), t4 + 3000);
    await ans('Ann', 4, text('More please'), t4 + 4000);
    expect(ack('Ann')).toMatchObject({ status: 'accepted', entries: 2 });
    await ans('Ann', 4, text('Third one'), t4 + 5000);
    expect(ack('Ann')).toMatchObject({ status: 'rejected', reason: 'limit', entries: 2 });
    await h.send(control, { type: 'host.stats', questionIndex: 4 });
    const openStats = h.transport.last(control, 'stats').stats;
    expect(openStats).toMatchObject({ type: 'open', answered: 3, cursor: null });
    expect(
      openStats.type === 'open' && openStats.responses.map((r) => [r.text, r.status, r.nickname]),
    ).toEqual([
      ['Great quiz', 'pending', 'Ann'],
      ['Too fast', 'pending', 'Bob'],
      ['Loved it', 'pending', 'Cy'],
      ['More please', 'pending', 'Ann'],
    ]);
    // While the question is open a moderation change is silent: hosts see it on the next poll.
    const stateCount = h.transport.ofType(control, 'host.state').length;
    await h.send(control, {
      type: 'host.moderate',
      questionIndex: 4,
      responseId: `${playerId.Ann}-0`,
      status: 'visible',
    });
    await h.send(control, {
      type: 'host.moderate',
      questionIndex: 4,
      responseId: `${playerId.Bob}-0`,
      status: 'hidden',
    });
    expect(h.transport.ofType(control, 'host.state')).toHaveLength(stateCount);
    await h.send(control, { type: 'host.close', questionIndex: 4, reason: 'manual' });
    const openResult = (nick: string) => h.transport.last(conn[nick]!, 'reveal').result;
    // Answers are anonymous and phones do not render them, so no player receives any response,
    // only how many were shown to the room. Their ids would name the author.
    expect(openResult('Dee')).toEqual({
      type: 'open',
      answered: 3,
      totalPlayers: 11,
      responses: [],
      omitted: 1,
    });
    // Every player still in the game, not the kicked one, whose last reveal is an earlier question.
    for (const nick of Object.keys(conn).filter((n) => n !== 'Liv')) {
      const shown = openResult(nick);
      expect(shown.type === 'open' && shown.responses, nick).toEqual([]);
      const json = JSON.stringify(h.transport.last(conn[nick]!, 'reveal'));
      for (const [other, id] of Object.entries(playerId)) {
        if (other !== nick) expect(json, `${nick} sees ${other}`).not.toContain(id);
      }
    }
    const hostOpen = hostState().result;
    expect(hostOpen?.type === 'open' && hostOpen.responses.map((r) => r.status)).toEqual([
      'visible',
      'hidden',
      'pending',
      'pending',
    ]);

    // Moderating during the reveal updates the stored result and both host screens.
    await h.send(control, {
      type: 'host.moderate',
      questionIndex: 4,
      responseId: `${playerId.Cy}-0`,
      status: 'visible',
    });
    for (const screen of [control, present]) {
      const shown = h.transport.last(screen, 'host.state').snapshot.result;
      expect(shown?.type === 'open' && shown.responses.map((r) => r.status)).toEqual([
        'visible',
        'hidden',
        'visible',
        'pending',
      ]);
    }
    const stored4 = await h.store.getQuestionResult(sessionId, 4);
    expect(
      stored4?.result.type === 'open' && stored4.result.responses.map((r) => r.status),
    ).toEqual(['visible', 'hidden', 'visible', 'pending']);
    // Eve reconnects (her old socket stays registered): the snapshot has the count of what the room
    // saw and the question, so the phone can show the reveal without an earlier `question` message.
    conn.EveOld = conn.Eve!;
    conn.Eve = h.cid('eve-2');
    await h.send(conn.Eve, {
      type: 'resume',
      v: 1,
      sessionId,
      playerId: playerId.Eve!,
      token: token.Eve!,
    });
    const eveWelcome = h.transport.last(conn.Eve, 'welcome');
    expect(eveWelcome.role === 'player' && eveWelcome.snapshot.reveal?.result).toMatchObject({
      type: 'open',
      responses: [],
      omitted: 2,
    });
    expect(eveWelcome.role === 'player' && eveWelcome.snapshot.reveal?.question).toMatchObject({
      type: 'open',
      maxEntries: 2,
    });
    expect(JSON.stringify(eveWelcome)).not.toContain('nickname":"Bob');
    expect(JSON.stringify(eveWelcome)).not.toContain('Great quiz');

    // ---- Question 6: rating, closed by the VM timer --------------------------------------
    await next('reveal', 4);
    const q5 = h.transport.last(conn.Ann!, 'question');
    const t5 = q5.openAt;
    // Both of Eve's sockets receive it.
    expect(h.transport.ofType(conn.Eve!, 'question').at(-1)).toMatchObject({ index: 5 });
    expect(h.transport.ofType(conn.EveOld!, 'question').at(-1)).toMatchObject({ index: 5 });
    await ans('Ann', 5, rating(5), t5 + 100);
    await ans('Bob', 5, rating(4), t5 + 200);
    await ans('Cy', 5, rating(4), t5 + 300);
    await ans('Dee', 5, rating(3), t5 + 400);
    await ans('Gus', 5, rating(6), t5 + 500);
    expect(ack('Gus')).toMatchObject({ status: 'rejected', reason: 'invalid' });
    const timer = h.scheduler.scheduled.at(-1)!;
    expect(timer).toEqual({ sessionId, questionIndex: 5, at: t5 + 15_000 + 750 });
    h.clock.set(timer.at);
    await h.service.onTimer(sessionId, 5);
    expect(h.transport.last(conn.Ann!, 'reveal').result).toEqual({
      type: 'rating',
      answered: 4,
      totalPlayers: 11,
      histogram: [0, 0, 1, 2, 1],
      average: 4,
    });

    // ---- The end ---------------------------------------------------------------------------
    await next('reveal', 5);
    expect(await h.store.getSessionIdByPin(pin)).toBeNull();
    expect(h.scheduler.cancelled.filter((s) => s === sessionId).length).toBeGreaterThanOrEqual(2);
    const ended = (nick: string) => h.transport.last(conn[nick]!, 'ended');
    expect(ended('Ann')).toMatchObject({
      totalPlayers: 11,
      podium: [
        { nickname: 'Ann', rank: 1, score: 3200 },
        { nickname: 'Jon', rank: 2, score: 3177 },
        { nickname: 'Hal', rank: 3, score: 3140 },
      ],
      you: { score: 3200, rank: 1, correct: 2, answeredScored: 2, scoredQuestions: 2 },
    });
    expect(ended('Cy').you).toEqual({
      score: 400,
      rank: 11,
      correct: 1,
      answeredScored: 2,
      scoredQuestions: 2,
    });
    expect(ended('Gus').you).toMatchObject({ rank: 9, correct: 1, answeredScored: 1 });
    expect(ended('Eve').you).toMatchObject({ rank: 6 });
    expect(h.transport.ofType(conn.Liv!, 'ended')).toHaveLength(0);
    expect(hostState()).toMatchObject({ phase: 'ended', podium: [{ nickname: 'Ann' }, {}, {}] });
    await h.send(h.cid('late'), { type: 'join', v: 1, pin, nickname: 'Late' });
    expect(h.transport.last(h.cid('late'), 'error')).toMatchObject({ code: 'not-found' });

    // ---- CSV export --------------------------------------------------------------------------
    const csv = await h.api('GET', `/api/sessions/${sessionId}/results.csv`, { token: hostToken });
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    // The session was created before the fake clock first moved.
    const day = new Date(CLOCK_START).toISOString().slice(0, 10);
    expect(csv.headers.get('content-disposition')).toBe(
      `attachment; filename="zqhoot-${pin}-${day}.csv"`,
    );
    const lines = csv.text.split('\r\n');
    expect(lines.at(-1)).toBe('');
    lines.pop();
    expect(lines[0]).toBe(
      '﻿question_no,question_type,question,nickname,player_id,answered,response,correct,points,streak_bonus,response_time_ms,moderation,final_score,final_rank',
    );
    expect(lines).toHaveLength(1 + 11 + 11 + 11 + 13 + 12 + 11);

    const final: Array<[nick: string, score: number, rank: number]> = [
      ['Ann', 3200, 1],
      ['Jon', 3177, 2],
      ['Hal', 3140, 3],
      ['Fay', 2840, 4],
      ['Bob', 2300, 5],
      ['Eve', 2000, 6],
      ['Ivy', 2000, 6],
      ['Kai', 2000, 6],
      ['Gus', 1000, 9],
      ['Dee', 800, 10],
      ['Cy', 400, 11],
    ];
    const row = (
      no: number,
      type: string,
      prompt: string,
      nick: string,
      cells: [
        answered: string,
        response: string,
        correct: string,
        points: number,
        bonus: number,
        ms: string,
        moderation: string,
      ],
    ) => {
      const [, score, rank] = final.find(([n]) => n === nick)!;
      const [answered, response, correct, points, bonus, ms, moderation] = cells;
      return [
        no,
        type,
        prompt,
        nick,
        playerId[nick],
        answered,
        response,
        correct,
        points,
        bonus,
        ms,
        moderation,
        score,
        rank,
      ].join(',');
    };
    // Question 1 (index 0): [response, correct, points, elapsed] per player, in final-rank order.
    const q1Rows: Record<string, [string, string, string, number, string]> = {
      Ann: ['yes', 'Paris', 'yes', 1000, '100'],
      Jon: ['yes', 'Paris', 'yes', 977, '1000'],
      Hal: ['yes', 'Paris', 'yes', 940, '2225'],
      Fay: ['yes', 'Paris', 'yes', 880, '4200'],
      Bob: ['yes', 'Paris', 'yes', 700, '10125'],
      Eve: ['no', '', 'no', 0, ''],
      Ivy: ['no', '', 'no', 0, ''],
      Kai: ['yes', 'Rome', 'no', 0, '3000'],
      Gus: ['yes', 'Paris', 'yes', 1000, '250'],
      Dee: ['yes', 'Rome', 'no', 0, '500'],
      Cy: ['yes', 'Paris', 'yes', 400, '20000'],
    };
    const q2Rows: Record<string, [string, string, string, number, number, string]> = {
      Ann: ['yes', 'False', 'yes', 2000, 200, '250'],
      Jon: ['yes', 'False', 'yes', 2000, 200, '250'],
      Hal: ['yes', 'False', 'yes', 2000, 200, '250'],
      Fay: ['yes', 'False', 'yes', 1760, 200, '2200'],
      Bob: ['yes', 'False', 'yes', 1400, 200, '5125'],
      Eve: ['yes', 'False', 'yes', 2000, 0, '250'],
      Ivy: ['yes', 'False', 'yes', 2000, 0, '250'],
      Kai: ['yes', 'False', 'yes', 2000, 0, '250'],
      Gus: ['no', '', 'no', 0, 0, ''],
      Dee: ['yes', 'False', 'yes', 800, 0, '10000'],
      Cy: ['yes', 'True', 'no', 0, 0, '100'],
    };
    const expected: string[] = [];
    for (const [nick] of final) {
      const [answered, response, correct, points, ms] = q1Rows[nick]!;
      expected.push(
        row(1, 'single', 'Capital of France?', nick, [
          answered,
          response,
          correct,
          points,
          0,
          ms,
          '',
        ]),
      );
    }
    for (const [nick] of final) {
      const [answered, response, correct, points, bonus, ms] = q2Rows[nick]!;
      expected.push(
        row(2, 'truefalse', 'The sky is green', nick, [
          answered,
          response,
          correct,
          points,
          bonus,
          ms,
          '',
        ]),
      );
    }
    expect(lines.slice(1, 23)).toEqual(expected);

    // Questions 3-6: the poll and the rating have one row per player, the word cloud and the
    // open question one row per response.
    const poll: Record<string, string> = {
      Ann: 'Red',
      Bob: 'Blue',
      Cy: 'Red',
      Dee: 'Blue',
      Eve: 'Red',
    };
    for (const [nick] of final) {
      expect(lines, nick).toContain(
        row(
          3,
          'poll',
          'Favourite colour?',
          nick,
          poll[nick] === undefined
            ? ['no', '', '', 0, 0, '', '']
            : ['yes', poll[nick]!, '', 0, 0, '', ''],
        ),
      );
    }
    for (const [nick, word, status] of [
      ['Ann', 'sun', 'visible'],
      ['Ann', 'moon', 'visible'],
      ['Ann', 'star', 'visible'],
      ['Bob', 'sun', 'visible'],
      ['Cy', 'moon', 'visible'],
      ['Dee', 'fuck', 'hidden'],
      ['Eve', 'sun', 'visible'],
    ] as const) {
      const at = lines.findIndex(
        (l) => l.startsWith(`4,wordcloud,One word,${nick},`) && l.includes(`,${word},`),
      );
      expect(at, `${nick} ${word}`).toBeGreaterThan(0);
      expect(lines[at]).toContain(`,${status},`);
    }
    expect(lines.filter((l) => l.startsWith('4,wordcloud,One word,Ann,'))).toHaveLength(3);
    expect(lines).toContain(row(4, 'wordcloud', 'One word', 'Fay', ['no', '', '', 0, 0, '', '']));
    const openRows = lines.filter((l) => l.startsWith('5,open,Tell us more,'));
    expect(openRows).toHaveLength(12);
    expect(openRows.filter((l) => l.includes(',Ann,'))).toHaveLength(2);
    expect(
      openRows.some(
        (l) => l.includes(',Bob,') && l.includes(',Too fast,') && l.includes(',hidden,'),
      ),
    ).toBe(true);
    expect(
      openRows.some(
        (l) => l.includes(',Ann,') && l.includes(',More please,') && l.includes(',pending,'),
      ),
    ).toBe(true);
    expect(lines).toContain(row(6, 'rating', 'Rate it', 'Ann', ['yes', '5', '', 0, 0, '100', '']));
    expect(lines).toContain(row(6, 'rating', 'Rate it', 'Eve', ['no', '', '', 0, 0, '', '']));
    // The kicked player appears nowhere.
    expect(csv.text).not.toContain('Liv');

    // ---- Answer secrecy across the whole game --------------------------------------------
    // Everything any non-host connection was sent, in log order, while a question is shown and not
    // yet revealed. Nothing but the three post-reveal types may carry the answer, and the types a
    // player connection receives are only the player ones (a host message misrouted to a player is
    // the likeliest leak).
    const hostConnections = new Set([control, present]);
    const playerTypes = new Set([
      'welcome',
      'question',
      'answer.ack',
      'reveal',
      'leaderboard',
      'ended',
      'kicked',
      'error',
      'pong',
    ]);
    const postReveal = new Set(['reveal', 'leaderboard', 'ended']);
    const scanLog = (log: typeof h.transport.log) => {
      const problems: string[] = [];
      let unrevealed: number | null = null;
      let scanned = 0;
      for (const { to, message } of log) {
        if (hostConnections.has(to)) continue;
        if (!playerTypes.has(message.type)) problems.push(`${message.type} sent to ${to}`);
        if (message.type === 'welcome' && message.role !== 'player') problems.push('host welcome');
        if (message.type === 'question') unrevealed = message.index;
        if (message.type === 'reveal' && message.index === unrevealed) unrevealed = null;
        if (message.type === 'ended') unrevealed = null;
        if (unrevealed === null || postReveal.has(message.type)) continue;
        scanned++;
        for (const key of ['correctOptionId', 'correct']) {
          if (hasKey(message, key)) problems.push(`${key} in ${JSON.stringify(message)}`);
        }
      }
      return { problems, scanned };
    };
    const secrecy = scanLog(h.transport.log);
    expect(secrecy.problems).toEqual([]);
    expect(secrecy.scanned).toBeGreaterThan(100);
    // The scan notices a leak: a host message routed to a player while a question is open, and the
    // answer inside a question message. Hosts themselves do get the answer while it is open.
    const firstQuestion = h.transport.log.findIndex((s) => s.message.type === 'question');
    const hostStateSent = h.transport.log.find(
      (s) => s.to === control && s.message.type === 'host.state',
    );
    const question = h.transport.log[firstQuestion]!;
    expect(scanLog([question, { ...hostStateSent!, to: question.to }]).problems).toEqual([
      expect.stringContaining('host.state sent to'),
      expect.stringContaining('correctOptionId'),
    ]);
    expect(
      scanLog([
        {
          ...question,
          message: { ...question.message, question: { correctOptionId: 'x' } } as never,
        },
      ]).problems,
    ).toEqual([expect.stringContaining('correctOptionId')]);
    expect(
      h.transport.ofType(control, 'host.state').some((m) => hasKey(m, 'correctOptionId')),
    ).toBe(true);

    expect(h.logger.entries.error).toEqual([]);
    expect(h.logger.entries.warn).toEqual([]);
  });
});
