import { describe, expect, it } from 'vitest';
import { HostSnapshot, LIMITS, LiveStats, PlayerSnapshot } from '@zqhoot/protocol';
import type { AnswerPayload, OpenResponseView, Question, QuizSettings } from '@zqhoot/protocol';
import {
  buildEnded,
  buildHostSnapshot,
  buildLeaderboard,
  buildPlayerSnapshot,
  buildQuestionMessage,
  buildRoster,
  computeLiveStats,
  computeReveal,
  toPublicQuestion,
} from '../src/index.ts';
import type {
  PlayerRecord,
  ResponseRecord,
  Scoreboard,
  SessionMeta,
  StoredQuestionResult,
} from '../src/index.ts';
import {
  NOW,
  Q,
  accept,
  board,
  metaIn,
  newSession,
  openAtIndex,
  pid,
  player,
  questions,
  response,
  revealingAt,
  validServerMessage,
} from './helpers.ts';

const s = newSession();
const NAMES = ['Alice', 'Bob', 'Cara', 'Dan', 'Eve', 'Zed'];
const roster = (): PlayerRecord[] =>
  NAMES.map((nickname, i) => player(i + 1, { nickname, kicked: nickname === 'Eve' }));

const choice = (optionId: string): AnswerPayload => ({ kind: 'choice', optionId });
const text = (t: string): AnswerPayload => ({ kind: 'text', text: t });

/** Alice 3000 (+2000), Bob and Cara 2000, Dan 500, kicked Eve 9999, Zed has no entry. */
const scores = (): Scoreboard =>
  board(
    {
      [pid(1)]: {
        score: 3000,
        streak: 2,
        correct: 2,
        answeredScored: 2,
        lastDelta: 2000,
        lastRank: 1,
      },
      [pid(2)]: {
        score: 2000,
        streak: 1,
        correct: 1,
        answeredScored: 2,
        lastDelta: 1000,
        lastRank: 2,
      },
      [pid(3)]: {
        score: 2000,
        streak: 0,
        correct: 1,
        answeredScored: 1,
        lastDelta: 500,
        lastRank: 2,
      },
      [pid(4)]: { score: 500, streak: 0, correct: 1, answeredScored: 1, lastDelta: 0, lastRank: 4 },
      [pid(5)]: {
        score: 9999,
        streak: 9,
        correct: 9,
        answeredScored: 9,
        lastDelta: 9,
        lastRank: 1,
      },
    },
    Q.truefalse,
    3,
  );

describe('buildQuestionMessage', () => {
  it('projects the current question with its timing', () => {
    const meta = openAtIndex(s, Q.single);
    const msg = buildQuestionMessage(meta, s.snapshot);
    expect(msg).toEqual({
      type: 'question',
      sv: meta.version,
      index: Q.single,
      total: 8,
      question: {
        id: 'q-single',
        type: 'single',
        prompt: 'Capital of France?',
        timeLimitSec: 20,
        options: [
          { id: 'opt-paris', text: 'Paris' },
          { id: 'opt-rome', text: 'Rome' },
          { id: 'opt-oslo', text: 'Oslo' },
        ],
        points: 1,
      },
      openAt: meta.openAt,
      deadline: meta.deadline,
    });
    expect(validServerMessage(msg)).toBe(true);
  });

  it('keeps an untimed question deadline null and hides prompts when configured', () => {
    const t = newSession(undefined, { showQuestionOnDevices: false });
    const meta = openAtIndex(t, Q.poll);
    const msg = buildQuestionMessage(meta, t.snapshot);
    expect(msg).toMatchObject({ deadline: null });
    expect(JSON.stringify(msg)).not.toContain('Favourite colour');
    expect(validServerMessage(msg)).toBe(true);
  });

  it('refuses a meta that is not an open question', () => {
    expect(() => buildQuestionMessage(s.meta, s.snapshot)).toThrow(/openAt/);
    expect(() =>
      buildQuestionMessage({ ...openAtIndex(s, 0), questionIndex: 50 }, s.snapshot),
    ).toThrow(/no question/);
  });
});

describe('buildLeaderboard', () => {
  const meta = metaIn(s.meta, 'leaderboard', Q.truefalse, { version: 9 });
  const out = buildLeaderboard({ meta, scoreboard: scores(), players: roster() });

  it('lists the top five non-kicked players with competition ranks and their last delta', () => {
    expect(out.entries).toEqual([
      { playerId: pid(1), nickname: 'Alice', score: 3000, rank: 1, delta: 2000 },
      { playerId: pid(2), nickname: 'Bob', score: 2000, rank: 2, delta: 1000 },
      { playerId: pid(3), nickname: 'Cara', score: 2000, rank: 2, delta: 500 },
      { playerId: pid(4), nickname: 'Dan', score: 500, rank: 4, delta: 0 },
      { playerId: pid(6), nickname: 'Zed', score: 0, rank: 5, delta: 0 },
    ]);
  });

  it('sends every non-kicked player their own standing and who is just ahead', () => {
    const you = Object.fromEntries(
      out.playerMessages.map((m) => [
        m.playerId,
        m.message.type === 'leaderboard' ? m.message.you : null,
      ]),
    );
    expect(Object.keys(you)).toEqual([pid(1), pid(2), pid(3), pid(4), pid(6)]);
    expect(you[pid(1)]).toEqual({ score: 3000, rank: 1 });
    expect(you[pid(2)]).toEqual({
      score: 2000,
      rank: 2,
      behind: { nickname: 'Alice', points: 1000 },
    });
    expect(you[pid(3)]).toEqual({
      score: 2000,
      rank: 2,
      behind: { nickname: 'Alice', points: 1000 },
    });
    expect(you[pid(4)]).toEqual({
      score: 500,
      rank: 4,
      behind: { nickname: 'Cara', points: 1500 },
    });
    expect(you[pid(6)]).toEqual({ score: 0, rank: 5, behind: { nickname: 'Dan', points: 500 } });
  });

  it('stamps sv and index and produces schema-valid messages', () => {
    for (const m of out.playerMessages) {
      expect(m.message).toMatchObject({
        type: 'leaderboard',
        sv: 9,
        index: Q.truefalse,
        entries: out.entries,
      });
      expect(validServerMessage(m.message)).toBe(true);
    }
  });

  it('shows a player outside the top five their true rank', () => {
    const many = Array.from({ length: 8 }, (_, i) => player(i + 1, { nickname: `P${i + 1}` }));
    const sb = board(
      Object.fromEntries(many.map((p, i) => [p.playerId, { score: 800 - i * 100 }])),
      0,
    );
    const r = buildLeaderboard({ meta, scoreboard: sb, players: many });
    expect(r.entries).toHaveLength(LIMITS.leaderboardSize);
    const last = r.playerMessages.at(-1)?.message;
    expect(last).toMatchObject({
      you: { score: 100, rank: 8, behind: { nickname: 'P7', points: 100 } },
    });
  });
});

describe('buildEnded', () => {
  const meta = metaIn(s.meta, 'ended', Q.lastScored, { version: 12, endedAt: NOW });
  const standing = (o: ReturnType<typeof buildEnded>, no: number) => {
    const m = o.playerMessages.find((x) => x.playerId === pid(no))?.message;
    return m?.type === 'ended' ? m.you : null;
  };

  it('builds a podium of the top three and each player final standing', () => {
    const sb = scores();
    sb.appliedThrough = Q.lastScored;
    const out = buildEnded({ meta, snapshot: s.snapshot, scoreboard: sb, players: roster() });
    expect(out.podium.map((e) => [e.nickname, e.rank])).toEqual([
      ['Alice', 1],
      ['Bob', 2],
      ['Cara', 2],
    ]);
    expect(standing(out, 1)).toEqual({
      score: 3000,
      rank: 1,
      correct: 2,
      answeredScored: 2,
      scoredQuestions: 3,
    });
    expect(standing(out, 4)).toEqual({
      score: 500,
      rank: 4,
      correct: 1,
      answeredScored: 1,
      scoredQuestions: 3,
    });
    expect(standing(out, 6)).toEqual({
      score: 0,
      rank: 5,
      correct: 0,
      answeredScored: 0,
      scoredQuestions: 3,
    });
    expect(standing(out, 5)).toBeNull();
    for (const m of out.playerMessages) {
      expect(m.message).toMatchObject({
        type: 'ended',
        sv: 12,
        podium: out.podium,
        totalPlayers: 5,
      });
      expect(validServerMessage(m.message)).toBe(true);
    }
  });

  it.each([
    ['ties for first fill the podium', [10, 10, 10, 10, 10], 3, [1, 1, 1]],
    ['ties for third are capped at three entries', [30, 20, 10, 10, 10], 3, [1, 2, 3]],
    ['two players', [5, 3], 2, [1, 2]],
    ['everyone on zero', [0, 0, 0, 0], 3, [1, 1, 1]],
  ])('podium: %s', (_name, pts, size, ranks) => {
    const ps = pts.map((_, i) => player(i + 1, { nickname: `N${i + 1}` }));
    const sb = board(
      Object.fromEntries(ps.map((p, i) => [p.playerId, { score: pts[i] as number }])),
      0,
    );
    const out = buildEnded({ meta, snapshot: s.snapshot, scoreboard: sb, players: ps });
    expect(out.podium).toHaveLength(size);
    expect(out.podium.map((e) => e.rank)).toEqual(ranks);
  });

  it('has no podium and no ranks when nothing was scored', () => {
    const t = newSession([questions()[Q.poll]!, questions()[Q.rating]!]);
    const m = metaIn(t.meta, 'ended', 1, { endedAt: NOW });
    const out = buildEnded({ meta: m, snapshot: t.snapshot, scoreboard: null, players: roster() });
    expect(out.podium).toEqual([]);
    expect(standing(out, 1)).toEqual({
      score: 0,
      rank: null,
      correct: 0,
      answeredScored: 0,
      scoredQuestions: 0,
    });
    expect(out.playerMessages.every((x) => validServerMessage(x.message))).toBe(true);
  });

  describe('scoredQuestions', () => {
    const count = (appliedThrough: number | null, skipped: number[] = []) => {
      const sb = appliedThrough === null ? null : board({ [pid(1)]: {} }, appliedThrough);
      const out = buildEnded({
        meta: { ...meta, skipped },
        snapshot: s.snapshot,
        scoreboard: sb,
        players: roster(),
      });
      return standing(out, 1)?.scoredQuestions;
    };
    it('counts revealed scoring questions only (indexes 0, 1 and 7 score in the fixture)', () => {
      expect(count(null)).toBe(0);
      expect(count(0)).toBe(1);
      expect(count(1)).toBe(2);
      expect(count(5)).toBe(2);
      expect(count(Q.lastScored)).toBe(3);
    });
    it('does not count skipped questions', () => {
      expect(count(Q.lastScored, [1])).toBe(2);
      expect(count(5, [0])).toBe(1);
      expect(count(Q.lastScored, [Q.poll])).toBe(3);
    });
  });
});

describe('buildEnded before any scoring question was revealed', () => {
  // A scored quiz ended in the lobby, or with every scored question skipped: everyone is tied on
  // zero, so a podium or a rank would only reflect nickname order.
  const cases: Array<[string, Scoreboard | null, number[]]> = [
    ['ended in the lobby', null, []],
    ['every scoring question skipped', board({ [pid(1)]: {} }, 5), [0, 1, Q.lastScored]],
  ];

  it.each(cases)('%s', (_name, scoreboard, skipped) => {
    const meta = metaIn(s.meta, 'ended', -1, { version: 12, endedAt: NOW, skipped });
    const args = { meta, snapshot: s.snapshot, players: roster(), scoreboard };
    expect(meta.hasScoredQuestions).toBe(true);

    const ended = buildEnded(args);
    expect(ended.podium).toEqual([]);
    const mine = ended.playerMessages.find((m) => m.playerId === pid(1))?.message;
    expect(mine).toMatchObject({
      type: 'ended',
      totalPlayers: 5,
      you: { score: 0, rank: null, scoredQuestions: 0 },
    });
    expect(ended.playerMessages.every((m) => validServerMessage(m.message))).toBe(true);

    const host = buildHostSnapshot({ ...args, connectedPlayerIds: new Set(), result: null });
    expect(host.podium).toEqual([]);
    expect(HostSnapshot.safeParse(host).success).toBe(true);

    const player1 = buildPlayerSnapshot({
      ...args,
      player: roster()[0] as PlayerRecord,
      responses: [],
      result: null,
    });
    expect(player1.ended).toMatchObject({ podium: [], you: { rank: null } });
    expect(PlayerSnapshot.safeParse(player1).success).toBe(true);
  });
});

describe('buildRoster', () => {
  it('lists non-kicked players in join order with their connection state', () => {
    const ps = [
      player(3, { joinedAt: 5 }),
      player(1, { joinedAt: 9 }),
      player(2, { joinedAt: 5, playerId: 'player-00' }),
      player(4, { kicked: true }),
    ];
    expect(buildRoster(ps, new Set([pid(1)]))).toEqual([
      { playerId: 'player-00', nickname: 'Player2', connected: false },
      { playerId: pid(3), nickname: 'Player3', connected: false },
      { playerId: pid(1), nickname: 'Player1', connected: true },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Snapshots: every phase, validated against the protocol.
// ---------------------------------------------------------------------------

interface PhaseFixture {
  name: string;
  meta: SessionMeta;
  result: StoredQuestionResult | null;
  responses: ResponseRecord[];
}

function fixtures(): PhaseFixture[] {
  const open = openAtIndex(s, Q.single);
  const mine = accept(s, open, pid(1), choice('opt-paris'), (open.openAt as number) + 100);
  const revealingMeta = revealingAt(s, Q.single);
  const revealOut = computeReveal({
    meta: revealingMeta,
    snapshot: s.snapshot,
    responses: [mine, accept(s, open, pid(2), choice('opt-rome'), (open.openAt as number) + 100)],
    players: roster(),
    scoreboard: null,
    now: NOW + 50_000,
  });
  return [
    {
      name: 'lobby',
      meta: metaIn(s.meta, 'lobby', -1, { version: 1 }),
      result: null,
      responses: [],
    },
    { name: 'question', meta: open, result: null, responses: [mine] },
    { name: 'revealing', meta: revealingMeta, result: null, responses: [mine] },
    { name: 'reveal', meta: revealOut.meta, result: revealOut.stored, responses: [mine] },
    {
      name: 'leaderboard',
      meta: metaIn(s.meta, 'leaderboard', Q.single),
      result: null,
      responses: [],
    },
    {
      name: 'ended',
      meta: metaIn(s.meta, 'ended', Q.lastScored, { endedAt: NOW }),
      result: null,
      responses: [],
    },
  ];
}

const PLAYER_KEYS: Record<string, string[]> = {
  lobby: [],
  question: ['question', 'responses'],
  revealing: ['question', 'responses'],
  reveal: ['reveal', 'responses'],
  leaderboard: ['leaderboard'],
  ended: ['ended'],
};
const BASE_PLAYER_KEYS = [
  'phase',
  'questionIndex',
  'quizTitle',
  'sessionId',
  'sv',
  'totalQuestions',
  'you',
];

const HOST_KEYS: Record<string, string[]> = {
  lobby: [],
  question: ['question'],
  revealing: ['question'],
  reveal: ['question', 'result'],
  leaderboard: ['leaderboard'],
  ended: ['podium'],
};
const BASE_HOST_KEYS = [
  'hasScoredQuestions',
  'locked',
  'phase',
  'pin',
  'questionIndex',
  'quizId',
  'quizTitle',
  'roster',
  'settings',
  'sessionId',
  'sv',
  'totalQuestions',
];

describe.each(fixtures())('snapshots in phase $name', ({ name, meta, result, responses }) => {
  const sb = name === 'lobby' || name === 'question' || name === 'revealing' ? null : scores();
  const me = roster()[0] as PlayerRecord;

  it('player snapshot validates and carries exactly the phase fields', () => {
    const snap = buildPlayerSnapshot({
      meta,
      snapshot: s.snapshot,
      player: me,
      players: roster(),
      scoreboard: sb,
      responses,
      result,
    });
    expect(PlayerSnapshot.safeParse(snap).success).toBe(true);
    expect(Object.keys(snap).sort()).toEqual(
      [...BASE_PLAYER_KEYS, ...(PLAYER_KEYS[name] as string[])].sort(),
    );
    expect(snap).toMatchObject({
      sv: meta.version,
      sessionId: 'sess-0001',
      quizTitle: 'Fixture quiz',
      phase: meta.phase,
      questionIndex: meta.questionIndex,
      totalQuestions: 8,
    });
  });

  it('host snapshot validates and carries exactly the phase fields', () => {
    const snap = buildHostSnapshot({
      meta,
      snapshot: s.snapshot,
      players: roster(),
      connectedPlayerIds: new Set([pid(1), pid(2)]),
      scoreboard: sb,
      result,
    });
    expect(HostSnapshot.safeParse(snap).success).toBe(true);
    expect(Object.keys(snap).sort()).toEqual(
      [...BASE_HOST_KEYS, ...(HOST_KEYS[name] as string[])].sort(),
    );
    expect(snap.roster.map((r) => [r.nickname, r.connected])).toEqual([
      ['Alice', true],
      ['Bob', true],
      ['Cara', false],
      ['Dan', false],
      ['Zed', false],
    ]);
    expect(snap).toMatchObject({
      pin: '123456',
      quizId: 'quiz-0001',
      locked: false,
      hasScoredQuestions: true,
    });
  });
});

describe('player snapshot details', () => {
  const fx = Object.fromEntries(fixtures().map((f) => [f.name, f]));
  const build = (
    name: string,
    over: { player?: PlayerRecord; scoreboard?: Scoreboard | null } = {},
  ) => {
    const f = fx[name] as PhaseFixture;
    return buildPlayerSnapshot({
      meta: f.meta,
      snapshot: s.snapshot,
      player: over.player ?? (roster()[0] as PlayerRecord),
      players: roster(),
      scoreboard: over.scoreboard === undefined ? scores() : over.scoreboard,
      responses: f.responses,
      result: f.result,
    });
  };

  it('shows the public question and timing, plus what the player already answered', () => {
    const snap = build('question');
    expect(snap.question).toEqual({
      question: expect.objectContaining({ id: 'q-single', type: 'single' }),
      openAt: (fx.question as PhaseFixture).meta.openAt,
      deadline: (fx.question as PhaseFixture).meta.deadline,
    });
    expect(JSON.stringify(snap.question)).not.toContain('correctOptionId');
    expect(snap.responses).toEqual([choice('opt-paris')]);
  });

  it('orders several responses by slot', () => {
    const f = fx.question as PhaseFixture;
    const meta = openAtIndex(s, Q.wordcloud);
    const w = (slot: number, t: string) =>
      response(meta, pid(1), text(t), { slot, responseId: `${pid(1)}-${slot}` });
    const snap = buildPlayerSnapshot({
      meta,
      snapshot: s.snapshot,
      player: roster()[0] as PlayerRecord,
      players: roster(),
      scoreboard: null,
      responses: [w(2, 'c1'), w(0, 'a1'), w(1, 'b1')],
      result: null,
    });
    expect(snap.responses).toEqual([text('a1'), text('b1'), text('c1')]);
    void f;
  });

  it("reports the player's own score, rank and streak", () => {
    expect(build('lobby').you).toEqual({
      playerId: pid(1),
      nickname: 'Alice',
      score: 3000,
      rank: 1,
      streak: 2,
    });
    expect(build('lobby', { scoreboard: null }).you).toEqual({
      playerId: pid(1),
      nickname: 'Alice',
      score: 0,
      rank: null,
      streak: 0,
    });
  });

  it('reveal: player view of the result and their own stored outcome', () => {
    const snap = build('reveal', {
      scoreboard: (fx.reveal as PhaseFixture).result ? scores() : null,
    });
    expect(snap.reveal?.you).toMatchObject({
      answered: true,
      correct: true,
      points: expect.any(Number),
    });
    expect(snap.reveal?.result).toMatchObject({ type: 'single', correctOptionId: 'opt-paris' });
  });

  it('reveal: a player without a stored outcome (late joiner) gets an empty one', () => {
    const late = player(9, { nickname: 'Late' });
    const snap = build('reveal', { player: late });
    expect(snap.reveal?.you).toEqual({
      answered: false,
      correct: false,
      points: 0,
      streakBonus: 0,
      score: 0,
      rank: null,
      streak: 0,
    });
    expect(PlayerSnapshot.safeParse(snap).success).toBe(true);
  });

  it('reveal: an unscored question has no `correct` in the fallback outcome', () => {
    const meta = { ...revealingAt(s, Q.poll), phase: 'reveal' as const };
    const stored: StoredQuestionResult = {
      sessionId: 'sess-0001',
      questionIndex: Q.poll,
      closedAt: 1,
      computedAt: 2,
      result: {
        type: 'poll',
        answered: 0,
        totalPlayers: 4,
        counts: { 'opt-red': 0, 'opt-blue': 0 },
      },
      outcomes: {},
    };
    const snap = buildPlayerSnapshot({
      meta,
      snapshot: s.snapshot,
      player: roster()[0] as PlayerRecord,
      players: roster(),
      scoreboard: scores(),
      responses: [],
      result: stored,
    });
    expect(snap.reveal?.you).not.toHaveProperty('correct');
  });

  it('leaderboard: top entries and own standing', () => {
    const snap = build('leaderboard');
    expect(snap.leaderboard?.entries.map((e) => e.nickname)).toEqual([
      'Alice',
      'Bob',
      'Cara',
      'Dan',
      'Zed',
    ]);
    expect(snap.leaderboard?.you).toEqual({ score: 3000, rank: 1 });
    expect(build('leaderboard', { player: roster()[3] as PlayerRecord }).leaderboard?.you).toEqual({
      score: 500,
      rank: 4,
      behind: { nickname: 'Cara', points: 1500 },
    });
  });

  it('ended: podium and final standing', () => {
    const snap = build('ended');
    expect(snap.ended).toEqual({
      podium: expect.arrayContaining([expect.objectContaining({ nickname: 'Alice', rank: 1 })]),
      totalPlayers: 5,
      you: { score: 3000, rank: 1, correct: 2, answeredScored: 2, scoredQuestions: 2 },
    });
  });

  it('omits leaderboard/ended when the player is not ranked (kicked)', () => {
    const kicked = roster()[4] as PlayerRecord;
    expect(build('leaderboard', { player: kicked }).leaderboard).toBeUndefined();
    expect(build('ended', { player: kicked }).ended).toBeUndefined();
  });

  it('omits scoreboard-derived sections when there is no scoreboard yet', () => {
    expect(build('leaderboard', { scoreboard: null }).leaderboard).toBeUndefined();
  });
});

describe('host snapshot details', () => {
  const fx = Object.fromEntries(fixtures().map((f) => [f.name, f]));
  const build = (name: string, scoreboard: Scoreboard | null = scores()) => {
    const f = fx[name] as PhaseFixture;
    return buildHostSnapshot({
      meta: f.meta,
      snapshot: s.snapshot,
      players: roster(),
      connectedPlayerIds: new Set(),
      scoreboard,
      result: f.result,
    });
  };

  it('includes the full question with its answer and the close time', () => {
    const snap = build('revealing');
    expect(snap.question).toMatchObject({
      question: { id: 'q-single', correctOptionId: 'opt-paris', points: 1 },
      openAt: (fx.revealing as PhaseFixture).meta.openAt,
      closedAt: (fx.revealing as PhaseFixture).meta.closedAt,
    });
    expect(build('question').question?.closedAt).toBeNull();
  });

  it('includes the host-view result in reveal', () => {
    expect(build('reveal').result).toMatchObject({ type: 'single', answered: 2, totalPlayers: 5 });
  });

  it('includes the top ten in the leaderboard phase', () => {
    const many = Array.from({ length: 14 }, (_, i) =>
      player(i + 1, { nickname: `P${String(i).padStart(2, '0')}` }),
    );
    const sb = board(
      Object.fromEntries(many.map((p, i) => [p.playerId, { score: 1400 - i * 100 }])),
      0,
    );
    const snap = buildHostSnapshot({
      meta: (fx.leaderboard as PhaseFixture).meta,
      snapshot: s.snapshot,
      players: many,
      connectedPlayerIds: new Set(),
      scoreboard: sb,
      result: null,
    });
    expect(snap.leaderboard).toHaveLength(10);
    expect(snap.leaderboard?.[9]).toMatchObject({ nickname: 'P09', rank: 10 });
    expect(HostSnapshot.safeParse(snap).success).toBe(true);
  });

  it('reports the lock and the ended podium', () => {
    const locked = buildHostSnapshot({
      meta: { ...(fx.ended as PhaseFixture).meta, locked: true },
      snapshot: s.snapshot,
      players: roster(),
      connectedPlayerIds: new Set(),
      scoreboard: scores(),
      result: null,
    });
    expect(locked.locked).toBe(true);
    expect(locked.podium?.map((e) => e.nickname)).toEqual(['Alice', 'Bob', 'Cara']);
  });

  it('omits sections whose data is missing rather than inventing them', () => {
    expect(build('reveal', null).result).toBeDefined();
    const noResult = buildHostSnapshot({
      meta: (fx.reveal as PhaseFixture).meta,
      snapshot: s.snapshot,
      players: roster(),
      connectedPlayerIds: new Set(),
      scoreboard: null,
      result: null,
    });
    expect(noResult.result).toBeUndefined();
    expect(build('leaderboard', null).leaderboard).toBeUndefined();
    expect(build('lobby', null).podium).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Live stats
// ---------------------------------------------------------------------------

describe('computeLiveStats', () => {
  const ps = roster();
  const stats = (qIndex: number, responses: ResponseRecord[], after?: string) => {
    const result = computeLiveStats({
      question: questions()[qIndex]!,
      responses,
      players: ps,
      ...(after === undefined ? {} : { after }),
    });
    expect(LiveStats.safeParse(result).success).toBe(true);
    return result;
  };

  it('counts choices without revealing the correct answer', () => {
    const meta = openAtIndex(s, Q.single);
    const r = (no: number, id: string) => response(meta, pid(no), choice(id));
    const out = stats(Q.single, [
      r(1, 'opt-paris'),
      r(2, 'opt-rome'),
      r(3, 'opt-paris'),
      r(5, 'opt-oslo'),
    ]);
    expect(out).toEqual({
      type: 'single',
      answered: 3,
      totalPlayers: 5,
      counts: { 'opt-paris': 2, 'opt-rome': 1, 'opt-oslo': 0 },
    });
    expect(JSON.stringify(out)).not.toContain('correct');
  });

  describe('expected, with the connected players given (ADR-0006, all-answered)', () => {
    const meta = openAtIndex(s, Q.single);
    const withConnected = (connected: string[], responses: ResponseRecord[]) => {
      const out = computeLiveStats({
        question: questions()[Q.single]!,
        responses,
        players: ps,
        connectedPlayerIds: new Set(connected),
      });
      expect(LiveStats.safeParse(out).success).toBe(true);
      return { answered: out.answered, totalPlayers: out.totalPlayers, expected: out.expected };
    };
    const r = (no: number) => response(meta, pid(no), choice('opt-paris'));

    it('counts the connected players, so answered reaches it when they all have answered', () => {
      expect(withConnected([pid(1), pid(2), pid(3), pid(4), pid(6)], [])).toEqual({
        answered: 0,
        totalPlayers: 5,
        expected: 5,
      });
      // Cara, Dan and Zed dropped out without answering: nobody is left to wait for but two.
      expect(withConnected([pid(1), pid(2)], [r(1)])).toEqual({
        answered: 1,
        totalPlayers: 5,
        expected: 2,
      });
      expect(withConnected([pid(1), pid(2)], [r(1), r(2)])).toEqual({
        answered: 2,
        totalPlayers: 5,
        expected: 2,
      });
    });

    it('still counts a player who answered and then disconnected', () => {
      expect(withConnected([pid(1)], [r(1), r(2)])).toEqual({
        answered: 2,
        totalPlayers: 5,
        expected: 2,
      });
      expect(withConnected([pid(1), pid(3)], [r(2)])).toEqual({
        answered: 1,
        totalPlayers: 5,
        expected: 3,
      });
    });

    it('never counts a kicked player, connected or not, and ignores ids nobody holds', () => {
      expect(withConnected([pid(1), pid(5), 'stranger'], [r(5)])).toEqual({
        answered: 0,
        totalPlayers: 5,
        expected: 1,
      });
    });

    it('is 0 when nobody is connected and nobody answered', () => {
      expect(withConnected([], [])).toEqual({ answered: 0, totalPlayers: 5, expected: 0 });
    });

    it('leaves totalPlayers what a result reports: every non-kicked player', () => {
      expect(withConnected([pid(1)], [r(1)]).totalPlayers).toBe(5);
      expect(stats(Q.single, [r(1)])).toMatchObject({ answered: 1, totalPlayers: 5 });
    });

    it('is left out when the connected players are not given', () => {
      const out = stats(Q.single, [r(1)]);
      expect(out).not.toHaveProperty('expected');
      expect(out).toMatchObject({ answered: 1, totalPlayers: 5 });
    });
  });

  it('counts true/false, poll and rating', () => {
    const tf = openAtIndex(s, Q.truefalse);
    expect(
      stats(Q.truefalse, [
        response(tf, pid(1), { kind: 'boolean', value: true }),
        response(tf, pid(2), { kind: 'boolean', value: false }),
        response(tf, pid(3), { kind: 'boolean', value: false }),
      ]),
    ).toEqual({ type: 'truefalse', answered: 3, totalPlayers: 5, counts: { true: 1, false: 2 } });
    const poll = openAtIndex(s, Q.poll);
    expect(stats(Q.poll, [response(poll, pid(1), choice('opt-blue'))])).toEqual({
      type: 'poll',
      answered: 1,
      totalPlayers: 5,
      counts: { 'opt-red': 0, 'opt-blue': 1 },
    });
    const rt = openAtIndex(s, Q.rating);
    expect(
      stats(Q.rating, [
        response(rt, pid(1), { kind: 'rating', value: 5 }),
        response(rt, pid(2), { kind: 'rating', value: 4 }),
      ]),
    ).toEqual({
      type: 'rating',
      answered: 2,
      totalPlayers: 5,
      histogram: [0, 0, 0, 1, 1],
      average: 4.5,
    });
    expect(stats(Q.rating, [])).toMatchObject({ histogram: [0, 0, 0, 0, 0], average: null });
  });

  it('shows word frequencies from visible words only', () => {
    const meta = openAtIndex(s, Q.wordcloud);
    const w = (no: number, t: string, status: ResponseRecord['status'] = 'visible') =>
      response(meta, pid(no), text(t), { normalizedText: t, status });
    expect(
      stats(Q.wordcloud, [w(1, 'sun'), w(2, 'sun'), w(3, 'moon'), w(4, 'bad', 'hidden')]),
    ).toEqual({
      type: 'wordcloud',
      answered: 4,
      totalPlayers: 5,
      words: [
        { text: 'sun', count: 2 },
        { text: 'moon', count: 1 },
      ],
    });
  });

  describe('open-ended paging', () => {
    const meta = openAtIndex(s, Q.open);
    const many = Array.from({ length: 250 }, (_, i) => player(i + 1, { nickname: `Nick${i + 1}` }));
    const open = (no: number, receivedAt = NOW + no * 10) =>
      response(meta, pid(no), text(`answer ${no}`), {
        normalizedText: `answer ${no}`,
        status: no % 3 === 0 ? 'pending' : 'visible',
        receivedAt,
      });
    const all = many.map((p, i) => open(i + 1));
    const page = (responses: ResponseRecord[], after?: string, players = many) => {
      const out = computeLiveStats({
        question: questions()[Q.open]!,
        responses,
        players,
        ...(after === undefined ? {} : { after }),
      });
      expect(LiveStats.safeParse(out).success).toBe(true);
      if (out.type !== 'open') throw new Error('type');
      return out;
    };

    it('serves 100 per page, oldest first, until the cursor runs out', () => {
      const shuffled = [...all].reverse();
      const first = page(shuffled);
      expect(first.responses).toHaveLength(LIMITS.statsResponsesPage);
      expect(first.responses[0]).toMatchObject({ id: 'player-01-0', nickname: 'Nick1' });
      expect(first.responses[99]?.id).toBe('player-100-0');
      expect(first).toMatchObject({ answered: 250, totalPlayers: 250 });
      expect(first.cursor).not.toBeNull();

      const second = page(shuffled, first.cursor as string);
      expect(second.responses.map((r) => r.id)).toEqual(
        Array.from({ length: 100 }, (_, i) => `player-${i + 101}-0`),
      );
      expect(second.cursor).not.toBeNull();

      const third = page(shuffled, second.cursor as string);
      expect(third.responses).toHaveLength(50);
      expect(third.responses.at(-1)?.id).toBe('player-250-0');
      expect(third.cursor).toBeNull();
    });

    it('uses an opaque base64url cursor of receivedAt and response id', () => {
      const first = page(all);
      const decoded = Buffer.from(first.cursor as string, 'base64url').toString('utf8');
      expect(decoded).toBe(`${NOW + 1000}:player-100-0`);
      expect(first.cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('returns everything with a null cursor when it fits one page, exactly 100 included', () => {
      expect(page(all.slice(0, 5)).cursor).toBeNull();
      const hundred = page(all.slice(0, 100));
      expect(hundred.responses).toHaveLength(100);
      expect(hundred.cursor).toBeNull();
      const more = page(all.slice(0, 101));
      expect(more.cursor).not.toBeNull();
      expect(page(all.slice(0, 101), more.cursor as string).responses.map((r) => r.id)).toEqual([
        'player-101-0',
      ]);
    });

    it('breaks receivedAt ties by response id and pages across a tie', () => {
      const tied = many.slice(0, 150).map((p, i) => open(i + 1, NOW));
      const first = page([...tied].reverse());
      expect(first.responses.map((r) => r.id)).toEqual(
        [...first.responses.map((r) => r.id)].sort(),
      );
      const second = page(tied, first.cursor as string);
      expect(second.responses).toHaveLength(50);
      const ids = [...first.responses, ...second.responses].map((r) => r.id);
      expect(new Set(ids).size).toBe(150);
    });

    it('returns nothing new when the cursor is at the end, and starts over on a bad cursor', () => {
      const first = page(all.slice(0, 101));
      const lastSeen = page(all.slice(0, 101), first.cursor as string);
      const atEnd = page(all.slice(0, 101), first.cursor as string);
      expect(atEnd.responses).toHaveLength(1);
      expect(lastSeen.cursor).toBeNull();
      for (const bad of [
        '???',
        'AAAA',
        Buffer.from('no colon').toString('base64url'),
        Buffer.from('x:y').toString('base64url'),
      ]) {
        expect(page(all.slice(0, 5), bad).responses).toHaveLength(5);
      }
    });

    it('gives the host every moderation status and excludes kicked players', () => {
      const out = page([open(1), open(3), open(5)], undefined, [
        player(1, { nickname: 'Alice' }),
        player(3, { nickname: 'Cara' }),
        player(5, { nickname: 'Eve', kicked: true }),
      ]);
      expect(out.responses.map((r) => [r.nickname, r.status])).toEqual([
        ['Alice', 'visible'],
        ['Cara', 'pending'],
      ]);
      expect(out).toMatchObject({ answered: 2, totalPlayers: 2 });
    });
  });
});

describe('player snapshot in reveal carries the public question', () => {
  const me = roster()[0] as PlayerRecord;
  const everyQuestion = questions().map((q, index) => ({ type: q.type, index, q }));

  const resumeInReveal = (index: number, settings?: Partial<QuizSettings>) => {
    const session = settings === undefined ? s : newSession(undefined, settings);
    const out = computeReveal({
      meta: revealingAt(session, index),
      snapshot: session.snapshot,
      responses: [],
      players: roster(),
      scoreboard: null,
      now: NOW + 50_000,
    });
    const snap = buildPlayerSnapshot({
      meta: out.meta,
      snapshot: session.snapshot,
      player: me,
      players: roster(),
      scoreboard: out.scoreboard,
      responses: [],
      result: out.stored,
    });
    return { snap, session };
  };

  it.each(everyQuestion)('for a $type question (#$index)', ({ index, q }) => {
    const { snap, session } = resumeInReveal(index);
    expect(PlayerSnapshot.safeParse(snap).success).toBe(true);
    expect(snap.reveal?.question).toEqual(
      toPublicQuestion(q as Question, session.snapshot.settings),
    );
    const json = JSON.stringify(snap.reveal?.question);
    for (const key of ['"correctOptionId"', '"correct"', '"requireApproval"']) {
      expect(json).not.toContain(key);
    }
  });

  it('lets a phone show the correct single-choice option after a resume', () => {
    const { snap } = resumeInReveal(Q.single);
    const result = snap.reveal?.result;
    const question = snap.reveal?.question;
    if (result?.type !== 'single' || question?.type !== 'single') throw new Error('type');
    expect(question.options.find((o) => o.id === result.correctOptionId)?.text).toBe('Paris');
  });

  it('follows the quiz setting that hides question text on devices', () => {
    const { snap } = resumeInReveal(Q.single, { showQuestionOnDevices: false });
    expect(snap.reveal?.question).not.toHaveProperty('prompt');
    expect(JSON.stringify(snap)).not.toContain('Capital of France');
  });

  it('is absent outside the reveal phase', () => {
    const { snap } = resumeInReveal(Q.single);
    expect(snap.question).toBeUndefined();
    const open = buildPlayerSnapshot({
      meta: openAtIndex(s, Q.single),
      snapshot: s.snapshot,
      player: me,
      players: roster(),
      scoreboard: null,
      responses: [],
      result: null,
    });
    expect(open.reveal).toBeUndefined();
  });
});

describe('host snapshot in reveal fits one WebSocket message', () => {
  const revealMeta = { ...revealingAt(s, Q.open), phase: 'reveal' as const };
  const stored = (responses: OpenResponseView[], omitted?: number): StoredQuestionResult => ({
    sessionId: 'sess-0001',
    questionIndex: Q.open,
    closedAt: 1,
    computedAt: 2,
    result: {
      type: 'open',
      answered: responses.length,
      totalPlayers: 4,
      responses,
      ...(omitted === undefined ? {} : { omitted }),
    },
    outcomes: {},
  });
  const views = (n: number, chars: number): OpenResponseView[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `player-${String(i).padStart(3, '0')}-0`,
      text: 'x'.repeat(chars),
      status: 'visible' as const,
      nickname: 'Nick',
      receivedAt: NOW + i,
    }));
  const build = (result: StoredQuestionResult, players: PlayerRecord[] = roster()) =>
    buildHostSnapshot({
      meta: revealMeta,
      snapshot: s.snapshot,
      players,
      connectedPlayerIds: new Set(),
      scoreboard: null,
      result,
    });
  const shown = (snap: ReturnType<typeof build>) => {
    if (snap.result?.type !== 'open') throw new Error('type');
    return snap.result;
  };

  it('passes a result that fits through untouched', () => {
    const result = stored(views(100, 200));
    expect(build(result).result).toBe(result.result);
  });

  it('drops the oldest responses of an oversize result and counts them as omitted', () => {
    const result = stored(views(150, 1000), 7);
    const snap = build(result);
    const out = shown(snap);
    expect(out.responses.length).toBeGreaterThan(0);
    expect(out.responses.length).toBeLessThan(150);
    expect(out.responses.length + (out.omitted ?? 0)).toBe(157);
    expect(out.responses.at(-1)?.id).toBe('player-149-0');
    expect(Buffer.byteLength(JSON.stringify({ type: 'host.state', snapshot: snap }))).toBeLessThan(
      128 * 1024,
    );
    expect(HostSnapshot.safeParse(snap).success).toBe(true);
  });

  it('counts omitted from zero when the stored result has no count', () => {
    const out = shown(build(stored(views(150, 1000))));
    expect(out.responses.length + (out.omitted ?? 0)).toBe(150);
  });

  it('shows nothing when the roster alone takes the whole message', () => {
    // Longer than any accepted nickname, so the roster is over budget by itself.
    const crowd = Array.from({ length: 500 }, (_, i) =>
      player(i + 1, { nickname: 'x'.repeat(300) }),
    );
    const out = shown(build(stored(views(5, 100)), crowd));
    expect(out.responses).toEqual([]);
    expect(out.omitted).toBe(5);
  });
});
