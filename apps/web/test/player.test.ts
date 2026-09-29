import { describe, expect, it } from 'vitest';
import type {
  AnswerPayload,
  PlayerOutcome,
  PlayerSnapshot,
  PublicQuestion,
  QuestionResult,
  ServerMessage,
} from '@zqhoot/protocol';
import {
  NOTICE_COPY,
  initialPlayerState,
  playerReducer,
  revealVariant,
} from '../src/state/player.ts';
import type { PlayerAction, PlayerState } from '../src/state/player.ts';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const T0 = 1_800_000_000_000;
const ME = { playerId: 'player-riley-01', nickname: 'Riley', score: 1240, rank: 4, streak: 1 };

const single: Extract<PublicQuestion, { type: 'single' }> = {
  id: 'question-planet',
  type: 'single',
  prompt: 'Which planet is closest to the Sun?',
  timeLimitSec: 20,
  points: 1,
  options: [
    { id: 'option-mercury', text: 'Mercury' },
    { id: 'option-venus', text: 'Venus' },
    { id: 'option-earth', text: 'Earth' },
  ],
};
const trueFalse: PublicQuestion = {
  id: 'question-wall',
  type: 'truefalse',
  timeLimitSec: 10,
  points: 1,
};
const poll: PublicQuestion = {
  id: 'question-lunch',
  type: 'poll',
  timeLimitSec: 10,
  options: [
    { id: 'option-cafe', text: 'Cafe' },
    { id: 'option-park', text: 'Park' },
  ],
};
const cloud: PublicQuestion = {
  id: 'question-cloud',
  type: 'wordcloud',
  timeLimitSec: 30,
  maxEntries: 3,
};
const open: PublicQuestion = {
  id: 'question-open',
  type: 'open',
  timeLimitSec: null,
  maxEntries: 2,
};
const rating: PublicQuestion = {
  id: 'question-rate',
  type: 'rating',
  timeLimitSec: null,
  max: 5,
};

function snapshot(over: Partial<PlayerSnapshot> = {}): PlayerSnapshot {
  return {
    sv: 10,
    sessionId: 'session-demo-01',
    quizTitle: 'Friday night trivia',
    phase: 'lobby',
    questionIndex: -1,
    totalQuestions: 8,
    you: ME,
    ...over,
  };
}

/** A question snapshot where the options open `openInMs` from `ts` (negative: already open). */
function questionSnap(
  question: PublicQuestion,
  openInMs: number,
  over: Partial<PlayerSnapshot> = {},
): PlayerSnapshot {
  const openAt = T0 + openInMs;
  return snapshot({
    phase: 'question',
    questionIndex: 2,
    question: {
      question,
      openAt,
      deadline: question.timeLimitSec === null ? null : openAt + question.timeLimitSec * 1000,
    },
    ...over,
  });
}

const welcome = (snapshot: PlayerSnapshot, ts = T0): ServerMessage => ({
  type: 'welcome',
  ts,
  role: 'player',
  snapshot,
});

const questionMsg = (
  q: PublicQuestion,
  over: { sv?: number; ts?: number; openInMs?: number; index?: number } = {},
): ServerMessage => {
  const ts = over.ts ?? T0;
  const openAt = ts + (over.openInMs ?? 3_000);
  return {
    type: 'question',
    ts,
    sv: over.sv ?? 11,
    index: over.index ?? 2,
    total: 8,
    question: q,
    openAt,
    deadline: q.timeLimitSec === null ? null : openAt + q.timeLimitSec * 1000,
  };
};

const outcome = (over: Partial<PlayerOutcome> = {}): PlayerOutcome => ({
  answered: true,
  correct: true,
  points: 870,
  streakBonus: 0,
  score: 2340,
  rank: 2,
  streak: 3,
  ...over,
});

const singleResult: QuestionResult = {
  type: 'single',
  answered: 5,
  totalPlayers: 6,
  correctOptionId: 'option-venus',
  counts: { 'option-mercury': 1, 'option-venus': 4, 'option-earth': 0 },
};

const revealMsg = (you: PlayerOutcome, over: { sv?: number; ts?: number } = {}): ServerMessage => ({
  type: 'reveal',
  ts: over.ts ?? T0 + 25_000,
  sv: over.sv ?? 12,
  index: 2,
  result: singleResult,
  you,
});

const ack = (
  status: 'accepted' | 'duplicate' | 'rejected',
  entries = 1,
  reason?: 'not-open' | 'too-early' | 'too-late' | 'invalid' | 'limit',
  index = 2,
): ServerMessage => ({
  type: 'answer.ack',
  ts: T0,
  index,
  status,
  entries,
  ...(reason ? { reason } : {}),
});

function isAction(a: PlayerAction | ServerMessage): a is PlayerAction {
  return ['tick', 'connection', 'answer.sent', 'answer.unsent'].includes(a.type);
}

/** Applies a mix of local actions and server messages, starting from a fresh open connection. */
function run(...steps: Array<PlayerAction | ServerMessage>): PlayerState {
  return steps.reduce<PlayerState>(
    (s, step) => playerReducer(s, isAction(step) ? step : { type: 'message', msg: step }),
    initialPlayerState('open'),
  );
}

const tick = (now: number): PlayerAction => ({ type: 'tick', now });
const choice = (optionId: string): AnswerPayload => ({ kind: 'choice', optionId });
const sent = (payload: AnswerPayload, index = 2): PlayerAction => ({
  type: 'answer.sent',
  index,
  payload,
});

// ---------------------------------------------------------------------------

describe('initial state', () => {
  it('starts on a connecting screen with nothing known', () => {
    const s = initialPlayerState();
    expect(s.view).toEqual({ screen: 'connecting' });
    expect(s.sv).toBe(-1);
    expect(s.me).toBeNull();
    expect(s.connection).toBe('idle');
  });
});

describe('welcome snapshots decide the view (resume)', () => {
  it('lobby', () => {
    const s = run(welcome(snapshot()));
    expect(s.view).toEqual({ screen: 'lobby' });
    expect(s.me).toEqual(ME);
    expect(s.quizTitle).toBe('Friday night trivia');
    expect(s.totalQuestions).toBe(8);
    expect(s.sv).toBe(10);
  });

  it('question before openAt is get-ready with a count-in', () => {
    const s = run(welcome(questionSnap(single, 2_400)));
    expect(s.view).toMatchObject({ screen: 'get-ready', secondsUntilOpen: 3 });
    if (s.view.screen !== 'get-ready') throw new Error('unreachable');
    expect(s.view.q).toMatchObject({ index: 2, total: 8 });
  });

  it('question after openAt is answering, with the timer derived from server time', () => {
    const s = run(welcome(questionSnap(single, -6_500)));
    expect(s.view).toMatchObject({
      screen: 'answering',
      timer: { secondsLeft: 14 }, // 13.5 s left, rounded up
      notice: null,
    });
    if (s.view.screen !== 'answering') throw new Error('unreachable');
    expect(s.view.timer.fraction).toBeCloseTo(13_500 / 20_000);
  });

  it('a response already on file shows the locked-in screen, not the options', () => {
    const s = run(welcome(questionSnap(single, -6_500, { responses: [choice('option-venus')] })));
    expect(s.view).toMatchObject({
      screen: 'submitted',
      responses: [choice('option-venus')],
      remaining: 0,
      sending: false,
    });
  });

  it('word cloud entries so far come back, with the rest still allowed', () => {
    const responses: AnswerPayload[] = [
      { kind: 'text', text: 'sunny' },
      { kind: 'text', text: 'busy' },
    ];
    const s = run(welcome(questionSnap(cloud, -1_000, { responses })));
    expect(s.view).toMatchObject({ screen: 'submitted', remaining: 1, responses });
  });

  it('a snapshot past the deadline is times-up', () => {
    const s = run(welcome(questionSnap(single, -20_001)));
    expect(s.view.screen).toBe('times-up');
  });

  it('phase revealing is times-up even if the local clock thinks time remains', () => {
    const s = run(welcome(questionSnap(single, -1_000, { phase: 'revealing' })));
    expect(s.view.screen).toBe('times-up');
  });

  it('untimed questions stay open', () => {
    const s = run(welcome(questionSnap(rating, -600_000)), tick(T0 + 3_600_000));
    expect(s.view).toMatchObject({
      screen: 'answering',
      timer: { secondsLeft: null, fraction: null },
    });
  });

  it('reveal', () => {
    const s = run(
      welcome(
        snapshot({
          phase: 'reveal',
          questionIndex: 2,
          reveal: { result: singleResult, you: outcome() },
        }),
      ),
    );
    expect(s.view).toMatchObject({ screen: 'reveal', variant: 'correct', gained: 870, index: 2 });
  });

  it('leaderboard', () => {
    const standing = { score: 2100, rank: 4, behind: { nickname: 'Kim', points: 120 } };
    const s = run(
      welcome(
        snapshot({
          phase: 'leaderboard',
          questionIndex: 2,
          leaderboard: { entries: [], you: standing },
        }),
      ),
    );
    expect(s.view).toMatchObject({ screen: 'leaderboard', standing, index: 2, total: 8 });
  });

  it('ended, with the podium and the final standing', () => {
    const podium = [
      { playerId: 'player-ana-001', nickname: 'Ana', score: 5000, rank: 1, delta: 0 },
    ];
    const you = { score: 4000, rank: 2, correct: 5, answeredScored: 6, scoredQuestions: 8 };
    const s = run(welcome(snapshot({ phase: 'ended', ended: { podium, totalPlayers: 12, you } })));
    expect(s.view).toEqual({ screen: 'ended', podium, totalPlayers: 12, standing: you });
  });

  it('a snapshot missing the data for its phase falls back to the lobby rather than crashing', () => {
    for (const phase of ['question', 'reveal', 'leaderboard', 'ended'] as const) {
      expect(run(welcome(snapshot({ phase }))).view.screen).toBe('lobby');
    }
  });

  it('replaces whatever was showing, and discards local optimistic answers', () => {
    const s = run(
      welcome(questionSnap(single, -1_000)),
      sent(choice('option-venus')),
      welcome(questionSnap(single, -3_000)), // reconnect: the server has no answer from us
    );
    expect(s.view.screen).toBe('answering');
  });

  it('a second welcome on the same connection with a lower sv is ignored', () => {
    const s = run(
      welcome(questionSnap(single, 3_000, { sv: 50 })),
      welcome(snapshot({ sv: 40, phase: 'lobby' })),
    );
    expect(s.sv).toBe(50);
    expect(s.view.screen).toBe('get-ready');
  });

  it('a second welcome with an equal or higher sv applies', () => {
    let s = run(welcome(snapshot({ sv: 50 })), welcome(questionSnap(single, 3_000, { sv: 50 })));
    expect(s.view.screen).toBe('get-ready');
    s = playerReducer(s, { type: 'message', msg: welcome(snapshot({ sv: 51 })) });
    expect(s.view.screen).toBe('lobby');
    expect(s.sv).toBe(51);
  });

  it('ignores a host welcome', () => {
    const before = run(welcome(snapshot()));
    const after = playerReducer(before, {
      type: 'message',
      msg: {
        type: 'welcome',
        ts: T0 + 1,
        role: 'host',
        snapshot: {} as never,
      },
    });
    expect(after.view).toEqual(before.view);
    expect(after.sv).toBe(before.sv);
  });
});

describe('a resume racing a broadcast (per-connection sv rule)', () => {
  const reconnect: PlayerAction[] = [
    { type: 'connection', status: 'reconnecting' },
    { type: 'connection', status: 'open' },
  ];

  it('a welcome older than a question broadcast from the same socket is ignored', () => {
    // The host opens the question while the resume is still being answered: the broadcast
    // is delivered first, the snapshot it overtook (still the lobby) arrives after it.
    const s = run(
      welcome(snapshot({ sv: 10 })),
      ...reconnect,
      questionMsg(single, { sv: 11 }),
      welcome(snapshot({ sv: 10 })),
    );
    expect(s.view.screen).toBe('get-ready');
    expect(s.sv).toBe(11);
  });

  it('the player can still answer the question the stale welcome tried to hide', () => {
    const s = run(
      welcome(snapshot({ sv: 10 })),
      ...reconnect,
      questionMsg(single, { sv: 11 }),
      welcome(snapshot({ sv: 10 })),
      tick(T0 + 3_500),
      sent(choice('option-venus')),
    );
    expect(s.view).toMatchObject({ screen: 'submitted', responses: [choice('option-venus')] });
  });

  it('a stale welcome after a reveal or an ended broadcast does not throw the player back', () => {
    const revealed = run(
      welcome(questionSnap(single, -5_000, { sv: 11 })),
      ...reconnect,
      revealMsg(outcome(), { sv: 12 }),
      welcome(questionSnap(single, -5_000, { sv: 11 })),
    );
    expect(revealed.view.screen).toBe('reveal');
    expect(revealed.sv).toBe(12);

    const ended = run(
      welcome(snapshot({ sv: 20 })),
      ...reconnect,
      {
        type: 'ended',
        ts: T0 + 60_000,
        sv: 21,
        podium: [],
        totalPlayers: 6,
        you: { score: 10, rank: 1, correct: 1, answeredScored: 1, scoredQuestions: 1 },
      },
      welcome(snapshot({ sv: 20 })),
    );
    expect(ended.view.screen).toBe('ended');
  });

  it('the first welcome of a new connection applies even with a lower sv (VM restart rollback)', () => {
    const s = run(
      welcome(questionSnap(single, 3_000, { sv: 50 })),
      ...reconnect,
      welcome(snapshot({ sv: 40, phase: 'lobby' })),
    );
    expect(s.view.screen).toBe('lobby');
    expect(s.sv).toBe(40);
  });

  it('broadcasts of the rolled-back server then apply from the lowered sv', () => {
    const s = run(
      welcome(snapshot({ sv: 50 })),
      ...reconnect,
      welcome(snapshot({ sv: 40 })),
      questionMsg(single, { sv: 41 }),
    );
    expect(s.view.screen).toBe('get-ready');
  });

  it('every reconnect starts a new race, including one that never opened', () => {
    let s = run(welcome(snapshot({ sv: 30 })), questionMsg(single, { sv: 31 }));
    expect(s.fresh).toBe(false);
    for (const status of ['reconnecting', 'connecting'] as const) {
      s = playerReducer(s, { type: 'connection', status });
      expect(s.fresh).toBe(true);
      s = playerReducer(s, { type: 'connection', status: 'open' });
      s = playerReducer(s, { type: 'message', msg: welcome(snapshot({ sv: 5 })) });
      expect(s.sv).toBe(5);
      expect(s.fresh).toBe(false);
      s = playerReducer(s, { type: 'message', msg: welcome(snapshot({ sv: 4 })) });
      expect(s.sv).toBe(5);
    }
  });

  it('opening the socket alone does not re-arm the rule', () => {
    const s = run(welcome(snapshot({ sv: 30 })), { type: 'connection', status: 'open' });
    expect(s.fresh).toBe(false);
  });

  it('a broadcast that is itself stale does not count as delivered on this connection', () => {
    // sv 30 was applied on the old socket; the new socket's first word is an old broadcast.
    const s = run(
      welcome(snapshot({ sv: 30 })),
      ...reconnect,
      questionMsg(single, { sv: 12 }),
      welcome(snapshot({ sv: 29 })),
    );
    expect(s.sv).toBe(29);
  });
});

describe('a welcome that a broadcast overtook still says who the player is', () => {
  const reconnect: PlayerAction[] = [
    { type: 'connection', status: 'reconnecting' },
    { type: 'connection', status: 'open' },
  ];
  const ann = { playerId: 'player-ann-01', nickname: 'Ann', score: 0, rank: null, streak: 0 };

  it('fills the header when the question overtakes the first welcome of a page load', () => {
    // The host presses Start as the resume is answered: sv 5 reaches the phone before sv 4.
    const s = run(
      questionMsg(single, { sv: 5 }),
      welcome(snapshot({ sv: 4, you: ann })),
      revealMsg(outcome({ score: 870, rank: 1 }), { sv: 6 }),
    );
    expect(s.me).toEqual({ ...ann, score: 870, rank: 1, streak: 3 });
    expect(s.quizTitle).toBe('Friday night trivia');
    expect(s.totalQuestions).toBe(8);
    expect(s.view.screen).toBe('reveal');
    expect(s.sv).toBe(6);
  });

  it('shows the nickname and the title straight away, on the stage the broadcast set', () => {
    const s = run(questionMsg(single, { sv: 5 }), welcome(snapshot({ sv: 4, you: ann })));
    expect(s.view.screen).toBe('get-ready');
    expect(s.sv).toBe(5);
    expect(s.me).toEqual(ann);
    expect(s.quizTitle).toBe('Friday night trivia');
  });

  it('applies the score and rank when nothing newer set them', () => {
    const s = run(
      welcome(snapshot({ sv: 10, you: { ...ME, score: 1000, rank: 3, streak: 0 } })),
      ...reconnect,
      questionMsg(single, { sv: 12 }),
      welcome(snapshot({ sv: 11, you: { ...ME, score: 1500, rank: 2, streak: 1 } })),
    );
    expect(s.me).toEqual({ ...ME, score: 1500, rank: 2, streak: 1 });
    expect(s.standing).toEqual({ sv: 11, score: 1500, rank: 2, streak: 1 });
    expect(s.view.screen).toBe('get-ready');
    expect(s.sv).toBe(12);
  });

  it('keeps the score and rank a newer reveal, leaderboard or ended message set', () => {
    const stale = (score: number) => welcome(snapshot({ sv: 11, you: { ...ME, score, rank: 9 } }));
    const held = { ...ME, score: 2340, rank: 2, streak: 3 };
    const start = [welcome(snapshot({ sv: 10 })), ...reconnect];

    const afterReveal = run(...start, revealMsg(outcome(), { sv: 12 }), stale(1240));
    expect(afterReveal.me).toEqual(held);
    expect(afterReveal.view.screen).toBe('reveal');

    const afterLeaderboard = run(
      ...start,
      {
        type: 'leaderboard',
        ts: T0 + 30_000,
        sv: 12,
        index: 2,
        entries: [],
        you: { score: 2340, rank: 2 },
      },
      stale(1240),
    );
    expect(afterLeaderboard.me).toMatchObject({ score: 2340, rank: 2, nickname: 'Riley' });

    const afterEnded = run(
      ...start,
      {
        type: 'ended',
        ts: T0 + 60_000,
        sv: 12,
        podium: [],
        totalPlayers: 6,
        you: { score: 2340, rank: 2, correct: 3, answeredScored: 3, scoredQuestions: 3 },
      },
      stale(1240),
    );
    expect(afterEnded.me).toMatchObject({ score: 2340, rank: 2, nickname: 'Riley' });
    expect(afterEnded.view.screen).toBe('ended');
  });

  it('keeps the score a reveal set while there was no me to patch (first welcome of a page load)', () => {
    // Open, question sv 5, reveal sv 7, and only then the welcome that was built at sv 6.
    const s = run(
      questionMsg(single, { sv: 5 }),
      revealMsg(outcome({ score: 870, rank: 1 }), { sv: 7 }),
      welcome(questionSnap(single, -20_000, { sv: 6, phase: 'revealing', you: ann })),
    );
    expect(s.view.screen).toBe('reveal');
    expect(s.sv).toBe(7);
    // The header and the reveal screen agree: neither shows the score from before the reveal.
    expect(s.me).toEqual({ ...ann, score: 870, rank: 1, streak: 3 });
    expect(s.view).toMatchObject({ screen: 'reveal', outcome: { score: 870, rank: 1 } });
    expect(s.standing).toEqual({ sv: 7, score: 870, rank: 1, streak: 3 });
    expect(s.quizTitle).toBe('Friday night trivia');
  });

  it('does the same for a leaderboard or ended message, taking the streak from the welcome', () => {
    const late = welcome(snapshot({ sv: 6, you: { ...ann, streak: 2 } }));
    const afterLeaderboard = run(
      {
        type: 'leaderboard',
        ts: T0 + 30_000,
        sv: 7,
        index: 2,
        entries: [],
        you: { score: 2340, rank: 2 },
      },
      late,
    );
    expect(afterLeaderboard.me).toEqual({ ...ann, score: 2340, rank: 2, streak: 2 });
    expect(afterLeaderboard.view.screen).toBe('leaderboard');

    const afterEnded = run(
      {
        type: 'ended',
        ts: T0 + 60_000,
        sv: 7,
        podium: [],
        totalPlayers: 6,
        you: { score: 2340, rank: 2, correct: 3, answeredScored: 3, scoredQuestions: 3 },
      },
      late,
    );
    expect(afterEnded.me).toEqual({ ...ann, score: 2340, rank: 2, streak: 2 });
    expect(afterEnded.view.screen).toBe('ended');
  });

  it('keeps the streak a reveal set when a leaderboard for the same player follows it', () => {
    const s = run(
      revealMsg(outcome({ score: 870, rank: 1 }), { sv: 7 }),
      {
        type: 'leaderboard',
        ts: T0 + 30_000,
        sv: 8,
        index: 2,
        entries: [],
        you: { score: 870, rank: 1 },
      },
      welcome(snapshot({ sv: 6, you: { ...ann, streak: 0 } })),
    );
    expect(s.me).toEqual({ ...ann, score: 870, rank: 1, streak: 3 });
  });

  it('uses the welcome figures when they are not older than what a broadcast set', () => {
    // A reveal at sv 6, a question at sv 8, and a welcome built at sv 7: the welcome is newer
    // than the score the reveal carried, so it wins for the score even though it lost the race.
    const s = run(
      revealMsg(outcome({ score: 870, rank: 1 }), { sv: 6 }),
      questionMsg(single, { sv: 8, index: 3 }),
      welcome(snapshot({ sv: 7, you: { ...ann, score: 900, rank: 1, streak: 4 } })),
    );
    expect(s.me).toEqual({ ...ann, score: 900, rank: 1, streak: 4 });
    expect(s.standing).toEqual({ sv: 7, score: 900, rank: 1, streak: 4 });
    expect(s.sv).toBe(8);
  });

  it('takes identity from the stale welcome even where it keeps newer figures', () => {
    const s = run(
      welcome(snapshot({ sv: 10 })),
      ...reconnect,
      revealMsg(outcome(), { sv: 12 }),
      welcome(snapshot({ sv: 11, quizTitle: 'Renamed', you: { ...ME, nickname: 'Riley B' } })),
    );
    expect(s.me).toMatchObject({ nickname: 'Riley B', score: 2340, rank: 2 });
    expect(s.quizTitle).toBe('Renamed');
  });

  it('still drops what the stale welcome says about the game', () => {
    const s = run(
      questionMsg(single, { sv: 5 }),
      tick(T0 + 3_500),
      sent(choice('option-venus')),
      welcome(questionSnap(cloud, -1_000, { sv: 4, questionIndex: 7, you: ann })),
    );
    expect(s.view).toMatchObject({ screen: 'submitted', responses: [choice('option-venus')] });
    expect(s.sv).toBe(5);
  });

  it('is not needed for the first welcome of a connection, which applies whole whatever its sv', () => {
    // Nothing applied yet since the connection started: the welcome is the first word and wins.
    const s = run(
      welcome(snapshot({ sv: 3, you: ann })),
      ...reconnect,
      welcome(snapshot({ sv: 2 })),
    );
    expect(s.me).toEqual(ME);
    expect(s.sv).toBe(2);
  });
});

describe('sv ordering', () => {
  it('ignores a question with a lower sv than already applied', () => {
    const s = run(welcome(snapshot({ sv: 20 })), questionMsg(single, { sv: 19 }));
    expect(s.view.screen).toBe('lobby');
    expect(s.sv).toBe(20);
  });

  it('applies an equal sv, and a higher one', () => {
    let s = run(welcome(snapshot({ sv: 20 })), questionMsg(single, { sv: 20 }));
    expect(s.view.screen).toBe('get-ready');
    s = playerReducer(s, { type: 'message', msg: revealMsg(outcome(), { sv: 21 }) });
    expect(s.view.screen).toBe('reveal');
    expect(s.sv).toBe(21);
  });

  it('ignores stale reveal, leaderboard and ended messages', () => {
    const base = run(welcome(snapshot({ sv: 30 })), questionMsg(single, { sv: 31 }));
    const stale: ServerMessage[] = [
      revealMsg(outcome(), { sv: 5, ts: T0 }),
      {
        type: 'leaderboard',
        ts: T0,
        sv: 5,
        index: 2,
        entries: [],
        you: { score: 1, rank: 1 },
      },
      {
        type: 'ended',
        ts: T0,
        sv: 5,
        podium: [],
        totalPlayers: 1,
        you: { score: 1, rank: 1, correct: 0, answeredScored: 0, scoredQuestions: 0 },
      },
    ];
    for (const msg of stale) {
      const after = playerReducer(base, { type: 'message', msg });
      expect(after.view.screen).toBe(base.view.screen);
      expect(after.sv).toBe(31);
    }
  });

  it('walks the whole game in order', () => {
    const s = run(
      welcome(snapshot({ sv: 1 })),
      questionMsg(single, { sv: 2 }),
      revealMsg(outcome(), { sv: 3 }),
      {
        type: 'leaderboard',
        ts: T0 + 30_000,
        sv: 4,
        index: 2,
        entries: [],
        you: { score: 2340, rank: 2 },
      },
      {
        type: 'ended',
        ts: T0 + 60_000,
        sv: 5,
        podium: [],
        totalPlayers: 6,
        you: { score: 2340, rank: 2, correct: 3, answeredScored: 4, scoredQuestions: 4 },
      },
    );
    expect(s.view.screen).toBe('ended');
    expect(s.sv).toBe(5);
    expect(s.me).toMatchObject({ score: 2340, rank: 2 });
  });
});

describe('time-based screens (tick)', () => {
  const start = () =>
    run(welcome(snapshot({ sv: 1 })), questionMsg(single, { openInMs: 3_000, ts: T0 }));

  it('get-ready counts down, then opens at openAt', () => {
    let s = start();
    expect(s.view).toMatchObject({ screen: 'get-ready', secondsUntilOpen: 3 });
    s = playerReducer(s, tick(T0 + 1_001));
    expect(s.view).toMatchObject({ screen: 'get-ready', secondsUntilOpen: 2 });
    s = playerReducer(s, tick(T0 + 2_999));
    expect(s.view).toMatchObject({ screen: 'get-ready', secondsUntilOpen: 1 });
    s = playerReducer(s, tick(T0 + 3_000));
    expect(s.view.screen).toBe('answering');
  });

  it('answering ends at the deadline (not before)', () => {
    let s = playerReducer(start(), tick(T0 + 3_000 + 19_999));
    expect(s.view).toMatchObject({ screen: 'answering', timer: { secondsLeft: 1 } });
    s = playerReducer(s, tick(T0 + 3_000 + 20_000));
    expect(s.view).toMatchObject({ screen: 'answering', timer: { secondsLeft: 0 } });
    s = playerReducer(s, tick(T0 + 3_000 + 20_001));
    expect(s.view.screen).toBe('times-up');
  });

  it('a locked-in answer also gives way to times-up at the deadline', () => {
    let s = playerReducer(start(), tick(T0 + 4_000));
    s = playerReducer(s, sent(choice('option-venus')));
    expect(s.view.screen).toBe('submitted');
    s = playerReducer(s, tick(T0 + 30_000));
    expect(s.view).toMatchObject({ screen: 'times-up', responses: [choice('option-venus')] });
  });

  it('never moves time backwards, and ignores non-finite ticks', () => {
    let s = playerReducer(start(), tick(T0 + 10_000));
    const now = s.now;
    s = playerReducer(s, tick(T0 + 5_000));
    expect(s.now).toBe(now);
    s = playerReducer(s, tick(Number.NaN));
    expect(s.now).toBe(now);
  });

  it('message timestamps also move the clock forward', () => {
    let s = start();
    s = playerReducer(s, {
      type: 'message',
      msg: { type: 'pong', ts: T0 + 3_500, t: 0 },
    });
    expect(s.view.screen).toBe('answering');
  });

  it('screens that are not time-based do not change on tick', () => {
    const s = run(welcome(snapshot()));
    expect(playerReducer(s, tick(T0 + 999_999)).view).toEqual({ screen: 'lobby' });
  });
});

describe('answers and acks', () => {
  const answering = () => run(welcome(questionSnap(single, -2_000)));

  it('locks the screen as soon as an answer is sent', () => {
    const s = playerReducer(answering(), sent(choice('option-venus')));
    expect(s.view).toMatchObject({
      screen: 'submitted',
      responses: [choice('option-venus')],
      sending: true,
    });
  });

  it('accepted confirms the answer', () => {
    const s = run(
      welcome(questionSnap(single, -2_000)),
      sent(choice('option-venus')),
      ack('accepted'),
    );
    expect(s.view).toMatchObject({ screen: 'submitted', sending: false, notice: null });
  });

  it('duplicate counts as success', () => {
    const s = run(
      welcome(questionSnap(single, -2_000)),
      sent(choice('option-venus')),
      ack('duplicate'),
    );
    expect(s.view).toMatchObject({ screen: 'submitted', sending: false, notice: null });
  });

  it('rejected shows the reason from the copy table and unlocks the options', () => {
    const s = run(
      welcome(questionSnap(single, -2_000)),
      sent(choice('option-venus')),
      ack('rejected', 0, 'invalid'),
    );
    expect(s.view).toMatchObject({ screen: 'answering', notice: NOTICE_COPY.invalid });
  });

  it('too-late and not-open end the round for this player', () => {
    for (const reason of ['too-late', 'not-open'] as const) {
      const s = run(
        welcome(questionSnap(single, -2_000)),
        sent(choice('option-venus')),
        ack('rejected', 0, reason),
      );
      expect(s.view).toMatchObject({ screen: 'times-up', notice: NOTICE_COPY[reason] });
    }
  });

  it('too-early keeps the options and explains', () => {
    const s = run(
      welcome(questionSnap(single, -2_000)),
      sent(choice('option-venus')),
      ack('rejected', 0, 'too-early'),
    );
    expect(s.view).toMatchObject({ screen: 'answering', notice: NOTICE_COPY['too-early'] });
  });

  it('every reject reason has a message', () => {
    for (const reason of [
      'not-open',
      'too-early',
      'too-late',
      'invalid',
      'limit',
      'offline',
      'busy',
    ] as const) {
      expect(NOTICE_COPY[reason].length).toBeGreaterThan(10);
    }
  });

  it('a rejection without a reason falls back to "invalid"', () => {
    const s = run(
      welcome(questionSnap(single, -2_000)),
      sent(choice('option-venus')),
      ack('rejected'),
    );
    expect(s.view).toMatchObject({ notice: NOTICE_COPY.invalid });
  });

  it('an ack for another question is ignored', () => {
    const before = playerReducer(answering(), sent(choice('option-venus')));
    const after = playerReducer(before, { type: 'message', msg: ack('rejected', 0, 'invalid', 7) });
    expect(after.view).toEqual(before.view);
  });

  it('a send while the socket is closed leaves the options up and says so', () => {
    const s = playerReducer(answering(), { type: 'answer.unsent', index: 2 });
    expect(s.view).toMatchObject({ screen: 'answering', notice: NOTICE_COPY.offline });
  });

  it('a new attempt clears the old notice', () => {
    let s = playerReducer(answering(), { type: 'answer.unsent', index: 2 });
    s = playerReducer(s, sent(choice('option-venus')));
    expect(s.view).toMatchObject({ screen: 'submitted', notice: null });
  });

  it('cannot answer during get-ready, after the deadline, or for another question', () => {
    let s = run(welcome(questionSnap(single, 2_000)));
    expect(playerReducer(s, sent(choice('option-venus'))).view.screen).toBe('get-ready');
    s = run(welcome(questionSnap(single, -30_000)));
    expect(playerReducer(s, sent(choice('option-venus'))).view.screen).toBe('times-up');
    s = answering();
    expect(playerReducer(s, sent(choice('option-venus'), 9)).view.screen).toBe('answering');
  });

  it('a rate-limit error for an answer releases the optimistic lock', () => {
    const s = run(welcome(questionSnap(single, -2_000)), sent(choice('option-venus')), {
      type: 'error',
      ts: T0,
      code: 'rate-limited',
      message: 'slow down',
      ref: 'answer',
    });
    expect(s.view).toMatchObject({ screen: 'answering', notice: NOTICE_COPY.busy });
  });

  it('a second locked-in answer is not possible for single-response types', () => {
    const s = run(
      welcome(questionSnap(single, -2_000)),
      sent(choice('option-venus')),
      sent(choice('option-earth')),
    );
    expect(s.view).toMatchObject({ screen: 'submitted', responses: [choice('option-venus')] });
  });

  it('handles true/false, poll and rating payloads the same way', () => {
    const cases: Array<[PublicQuestion, AnswerPayload]> = [
      [trueFalse, { kind: 'boolean', value: true }],
      [poll, choice('option-cafe')],
      [rating, { kind: 'rating', value: 4 }],
    ];
    for (const [q, payload] of cases) {
      const s = run(welcome(questionSnap(q, -1_000)), sent(payload));
      expect(s.view).toMatchObject({ screen: 'submitted', responses: [payload], remaining: 0 });
    }
  });
});

describe('word cloud and open-ended entries', () => {
  const text = (t: string): AnswerPayload => ({ kind: 'text', text: t });

  it('lets a player add entries until the limit', () => {
    let s = run(welcome(questionSnap(cloud, -1_000)));
    expect(s.view.screen).toBe('answering');
    s = playerReducer(s, sent(text('sunny')));
    s = playerReducer(s, { type: 'message', msg: ack('accepted', 1) });
    expect(s.view).toMatchObject({ screen: 'submitted', remaining: 2, sending: false });
    s = playerReducer(s, sent(text('busy')));
    s = playerReducer(s, { type: 'message', msg: ack('accepted', 2) });
    expect(s.view).toMatchObject({ screen: 'submitted', remaining: 1 });
    s = playerReducer(s, sent(text('loud')));
    s = playerReducer(s, { type: 'message', msg: ack('accepted', 3) });
    expect(s.view).toMatchObject({
      screen: 'submitted',
      remaining: 0,
      responses: [text('sunny'), text('busy'), text('loud')],
    });
    // The limit is reached: a fourth is refused locally.
    const again = playerReducer(s, sent(text('extra')));
    expect(again.view).toMatchObject({ responses: [text('sunny'), text('busy'), text('loud')] });
  });

  it('a limit rejection removes only the refused entry and closes the form', () => {
    let s = run(welcome(questionSnap(open, -1_000, { responses: [text('one')] })));
    s = playerReducer(s, sent(text('two')));
    s = playerReducer(s, { type: 'message', msg: ack('rejected', 1, 'limit') });
    expect(s.view).toMatchObject({
      screen: 'submitted',
      responses: [text('one')],
      remaining: 0,
      notice: NOTICE_COPY.limit,
    });
  });

  it('the oldest pending entry is the one a rejection removes', () => {
    let s = run(welcome(questionSnap(cloud, -1_000)));
    s = playerReducer(s, sent(text('first')));
    s = playerReducer(s, sent(text('second')));
    s = playerReducer(s, { type: 'message', msg: ack('rejected', 0, 'invalid') });
    expect(s.view).toMatchObject({ responses: [text('second')], sending: true });
  });

  it('reconciles with the server count when an ack says fewer entries were kept', () => {
    let s = run(welcome(questionSnap(cloud, -1_000, { responses: [text('a')] })));
    s = playerReducer(s, sent(text('A')));
    s = playerReducer(s, sent(text('a ')));
    s = playerReducer(s, { type: 'message', msg: ack('duplicate', 1) });
    s = playerReducer(s, { type: 'message', msg: ack('duplicate', 1) });
    expect(s.view).toMatchObject({ responses: [text('a')], sending: false });
  });
});

describe('duplicate acks drop the oldest pending entry', () => {
  const text = (t: string): AnswerPayload => ({ kind: 'text', text: t });
  const acks = (...list: Array<[status: 'accepted' | 'duplicate', entries: number]>) =>
    list.map(([status, entries]) => ack(status, entries));
  const list = (s: PlayerState) => (s.view.screen === 'submitted' ? s.view.responses : null);

  it('[accepted, duplicate, accepted]: the new word stays, the repeated one goes', () => {
    const s = run(
      welcome(questionSnap(cloud, -1_000)),
      sent(text('cat')),
      sent(text('cat')),
      sent(text('dog')),
      ...acks(['accepted', 1], ['duplicate', 1], ['accepted', 2]),
    );
    expect(list(s)).toEqual([text('cat'), text('dog')]);
    expect(s.view).toMatchObject({ sending: false, remaining: 1 });
  });

  it('[accepted, accepted] with entries 1 then 2 keeps both', () => {
    const s = run(
      welcome(questionSnap(cloud, -1_000)),
      sent(text('cat')),
      sent(text('dog')),
      ...acks(['accepted', 1], ['accepted', 2]),
    );
    expect(list(s)).toEqual([text('cat'), text('dog')]);
  });

  it('a duplicate in the middle of three pending sends leaves the other two, in order', () => {
    let s = run(
      welcome(questionSnap(cloud, -1_000)),
      sent(text('cat')),
      sent(text('Cat')),
      sent(text('dog')),
    );
    s = playerReducer(s, { type: 'message', msg: ack('accepted', 1) });
    expect(list(s)).toEqual([text('cat'), text('Cat'), text('dog')]);
    s = playerReducer(s, { type: 'message', msg: ack('duplicate', 1) });
    expect(list(s)).toEqual([text('cat'), text('dog')]);
    expect(s.view).toMatchObject({ sending: true });
    s = playerReducer(s, { type: 'message', msg: ack('accepted', 2) });
    expect(list(s)).toEqual([text('cat'), text('dog')]);
    expect(s.view).toMatchObject({ sending: false });
  });

  it('a duplicate first in line drops the oldest pending entry, not the newest', () => {
    let s = run(
      welcome(questionSnap(cloud, -1_000, { responses: [text('cat')] })),
      sent(text('Cat')),
      sent(text('dog')),
    );
    s = playerReducer(s, { type: 'message', msg: ack('duplicate', 1) });
    expect(list(s)).toEqual([text('cat'), text('dog')]);
    s = playerReducer(s, { type: 'message', msg: ack('accepted', 2) });
    expect(list(s)).toEqual([text('cat'), text('dog')]);
  });

  it('is no refusal: no notice, and nothing is handed back to the field', () => {
    let s = run(
      welcome(questionSnap(cloud, -1_000, { responses: [text('cat')] })),
      sent(text('Cat')),
    );
    s = playerReducer(s, { type: 'message', msg: ack('duplicate', 1) });
    expect(s.view).toMatchObject({ screen: 'submitted', notice: null, sending: false });
    expect((s.view as { restore?: unknown }).restore).toBeUndefined();
  });

  it('keeps the entry when the server holds one this page never confirmed', () => {
    // A second tab, or an ack lost with the socket: the duplicate is what the server has.
    const s = run(welcome(questionSnap(cloud, -1_000)), sent(text('cat')), ack('duplicate', 1));
    expect(list(s)).toEqual([text('cat')]);
    expect(s.view).toMatchObject({ sending: false });
  });
});

describe('a refused text entry is handed back', () => {
  const text = (t: string): AnswerPayload => ({ kind: 'text', text: t });
  const restoreOf = (s: PlayerState) => (s.view as { restore?: unknown }).restore;
  const refuse = (reason: 'invalid' | 'too-early' | 'limit' = 'invalid'): ServerMessage =>
    ack('rejected', 0, reason);

  it('offers the refused text again, on the screen that shows the field', () => {
    let s = run(welcome(questionSnap(cloud, -1_000)), sent(text('sunny')));
    expect(s.view).toMatchObject({ screen: 'submitted', responses: [text('sunny')] });
    expect(restoreOf(s)).toBeUndefined();
    s = playerReducer(s, { type: 'message', msg: refuse() });
    expect(s.view).toMatchObject({
      screen: 'answering',
      notice: NOTICE_COPY.invalid,
      restore: { text: 'sunny', seq: 1 },
    });
  });

  it('a one-entry open question returns from "locked in" to the field with its text', () => {
    const one: PublicQuestion = { ...open, maxEntries: 1 };
    let s = run(welcome(questionSnap(one, -1_000)), sent(text('a long considered answer')));
    expect(s.view).toMatchObject({ screen: 'submitted', remaining: 0 });
    s = playerReducer(s, { type: 'message', msg: refuse('too-early') });
    expect(s.view).toMatchObject({
      screen: 'answering',
      restore: { text: 'a long considered answer' },
    });
  });

  it('gives back the oldest refused entry, and a new seq for every refusal', () => {
    let s = run(welcome(questionSnap(cloud, -1_000)), sent(text('first')), sent(text('second')));
    s = playerReducer(s, { type: 'message', msg: refuse() });
    expect(s.view).toMatchObject({ restore: { text: 'first', seq: 1 } });
    s = playerReducer(s, { type: 'message', msg: refuse() });
    expect(s.view).toMatchObject({ restore: { text: 'second', seq: 2 } });
  });

  it('sending again forgets the offer, and seq keeps counting afterwards', () => {
    let s = run(welcome(questionSnap(cloud, -1_000)), sent(text('one')));
    s = playerReducer(s, { type: 'message', msg: refuse() });
    s = playerReducer(s, sent(text('one')));
    expect(restoreOf(s)).toBeUndefined();
    s = playerReducer(s, { type: 'message', msg: refuse() });
    expect(s.view).toMatchObject({ restore: { text: 'one', seq: 2 } });
  });

  it('an entry that never left the phone changes nothing: the field still holds it', () => {
    const s = playerReducer(run(welcome(questionSnap(open, -1_000))), {
      type: 'answer.unsent',
      index: 2,
    });
    expect(s.view).toMatchObject({ screen: 'answering', notice: NOTICE_COPY.offline });
    expect(restoreOf(s)).toBeUndefined();
  });

  it('nothing is handed back for answers that are not text, or after a resume', () => {
    let s = run(welcome(questionSnap(single, -1_000)), sent(choice('option-venus')));
    s = playerReducer(s, { type: 'message', msg: refuse() });
    expect(s.view).toMatchObject({ screen: 'answering' });
    expect(restoreOf(s)).toBeUndefined();

    s = run(welcome(questionSnap(cloud, -1_000)), sent(text('sunny')), refuse());
    s = playerReducer(s, { type: 'message', msg: welcome(questionSnap(cloud, -1_000), T0 + 1) });
    expect(restoreOf(s)).toBeUndefined();
  });
});

describe('a text entry lost with the socket is handed back after the resume', () => {
  const text = (t: string): AnswerPayload => ({ kind: 'text', text: t });
  const resume = (s: PlayerState, responses: AnswerPayload[] = [], ts = T0 + 5_000) =>
    playerReducer(s, {
      type: 'message',
      msg: welcome(questionSnap(cloud, -1_000, { responses }), ts),
    });

  it('offers back an entry that was sent but never acknowledged', () => {
    let s = run(welcome(questionSnap(cloud, -1_000)), sent(text('sunny')));
    expect(s.view).toMatchObject({ screen: 'submitted', sending: true });
    s = resume(s);
    expect(s.view).toMatchObject({
      screen: 'answering',
      restore: { text: 'sunny', seq: 1 },
    });
  });

  it('offers the oldest lost entry first and keeps the ones the server holds', () => {
    let s = run(
      welcome(questionSnap(cloud, -1_000)),
      sent(text('first')),
      ack('accepted', 1),
      sent(text('second')),
      sent(text('third')),
    );
    s = resume(s, [text('first'), text('third')]);
    expect(s.view).toMatchObject({
      screen: 'submitted',
      responses: [text('first'), text('third')],
      restore: { text: 'second', seq: 1 },
    });
  });

  it('does nothing when the server did receive it', () => {
    let s = run(welcome(questionSnap(cloud, -1_000)), sent(text('sunny')));
    s = resume(s, [text('sunny')]);
    expect(s.view).toMatchObject({ screen: 'submitted', responses: [text('sunny')] });
    expect((s.view as { restore?: unknown }).restore).toBeUndefined();
  });

  it('counts a repeated word once per copy the server holds', () => {
    let s = run(
      welcome(questionSnap(cloud, -1_000)),
      sent(text('sunny')),
      ack('accepted', 1),
      sent(text('sunny')),
    );
    s = resume(s, [text('sunny')]);
    expect(s.view).toMatchObject({ restore: { text: 'sunny', seq: 1 } });
  });

  it('keeps counting from the refusals before the resume, so the field refills again', () => {
    let s = run(
      welcome(questionSnap(cloud, -1_000)),
      sent(text('one')),
      ack('rejected', 0, 'invalid'),
    );
    expect(s.view).toMatchObject({ restore: { seq: 1 } });
    s = playerReducer(s, sent(text('two')));
    s = resume(s);
    expect(s.view).toMatchObject({ restore: { text: 'two', seq: 2 } });
  });

  it('a different question, or an answer that is not text, restores nothing', () => {
    let s = run(welcome(questionSnap(cloud, -1_000)), sent(text('sunny')));
    s = playerReducer(s, {
      type: 'message',
      msg: welcome(questionSnap({ ...cloud, id: 'question-other' }, -1_000), T0 + 5_000),
    });
    expect((s.view as { restore?: unknown }).restore).toBeUndefined();

    s = run(welcome(questionSnap(single, -1_000)), sent(choice('option-venus')));
    s = playerReducer(s, {
      type: 'message',
      msg: welcome(questionSnap(single, -1_000), T0 + 5_000),
    });
    expect(s.view).toMatchObject({ screen: 'answering' });
    expect((s.view as { restore?: unknown }).restore).toBeUndefined();
  });
});

describe('a question message', () => {
  it('replaces the screen and resets answers for a new question', () => {
    const s = run(
      welcome(snapshot({ sv: 1 })),
      questionMsg(single, { sv: 2 }),
      sent(choice('option-venus')), // still get-ready: refused
      tick(T0 + 5_000),
      sent(choice('option-venus')),
      questionMsg(trueFalse, { sv: 3, index: 3, ts: T0 + 5_000 }),
    );
    expect(s.view).toMatchObject({ screen: 'get-ready', q: { index: 3 } });
  });

  it('the same question sent twice keeps what we answered', () => {
    const s = run(
      welcome(snapshot({ sv: 1 })),
      questionMsg(single, { sv: 2, openInMs: 0 }),
      sent(choice('option-venus')),
      questionMsg(single, { sv: 2, openInMs: 0 }),
    );
    expect(s.view).toMatchObject({ screen: 'submitted', responses: [choice('option-venus')] });
  });

  it('updates the total number of questions', () => {
    const s = run(welcome(snapshot()), questionMsg(single));
    expect(s.totalQuestions).toBe(8);
  });
});

describe('reveal', () => {
  const revealed = (you: PlayerOutcome) =>
    run(welcome(snapshot({ sv: 1 })), questionMsg(single, { sv: 2 }), revealMsg(you, { sv: 3 }));

  it('correct: shows points gained (base plus streak bonus) and updates score and rank', () => {
    const s = revealed(outcome({ points: 870, streakBonus: 100 }));
    expect(s.view).toMatchObject({ screen: 'reveal', variant: 'correct', gained: 970 });
    expect(s.me).toMatchObject({ score: 2340, rank: 2, streak: 3 });
  });

  it('incorrect', () => {
    const s = revealed(outcome({ correct: false, points: 0, streak: 0, score: 1240, rank: 5 }));
    expect(s.view).toMatchObject({ screen: 'reveal', variant: 'incorrect', gained: 0 });
    expect(s.me).toMatchObject({ score: 1240, rank: 5, streak: 0 });
  });

  it('no-answer, for scored and unscored questions', () => {
    expect(revealed(outcome({ answered: false, correct: false, points: 0 })).view).toMatchObject({
      variant: 'no-answer',
    });
    expect(
      revealed(outcome({ answered: false, correct: undefined, points: 0 })).view,
    ).toMatchObject({
      variant: 'no-answer',
    });
  });

  it('unscored: answered, but the question carries no points', () => {
    const s = revealed(outcome({ correct: undefined, points: 0, streak: 0 }));
    expect(s.view).toMatchObject({ screen: 'reveal', variant: 'unscored' });
  });

  it('revealVariant covers all four outcomes', () => {
    expect(revealVariant(outcome())).toBe('correct');
    expect(revealVariant(outcome({ correct: false }))).toBe('incorrect');
    expect(revealVariant(outcome({ correct: undefined }))).toBe('unscored');
    expect(revealVariant(outcome({ answered: false }))).toBe('no-answer');
  });

  it('names the correct answer when the question was on screen', () => {
    const s = revealed(outcome({ correct: false }));
    expect(s.view).toMatchObject({ correctAnswer: { slot: 1, text: 'Venus' } });
  });

  it('true/false results carry their own answer, and a resumed reveal has no answer text for choices', () => {
    const tf = run(welcome(snapshot({ sv: 1 })), {
      type: 'reveal',
      ts: T0,
      sv: 2,
      index: 2,
      result: {
        type: 'truefalse',
        answered: 3,
        totalPlayers: 4,
        correct: false,
        counts: { true: 1, false: 2 },
      },
      you: outcome({ correct: false }),
    });
    expect(tf.view).toMatchObject({ correctAnswer: { slot: 1, text: 'False' } });

    const resumed = run(
      welcome(
        snapshot({
          phase: 'reveal',
          questionIndex: 2,
          reveal: { result: singleResult, you: outcome({ correct: false }) },
        }),
      ),
    );
    // An older server does not send the question, and this page holds none.
    expect(resumed.view).toMatchObject({ correctAnswer: null });
  });
});

describe('a resume during the reveal (reveal.question)', () => {
  const counts = { answered: 5, totalPlayers: 6 };
  const CASES: Array<[string, PublicQuestion, QuestionResult, unknown]> = [
    ['single', single, singleResult, { slot: 1, text: 'Venus' }],
    [
      'truefalse',
      trueFalse,
      { type: 'truefalse', ...counts, correct: true, counts: { true: 4, false: 1 } },
      { slot: 0, text: 'True' },
    ],
    [
      'poll',
      poll,
      { type: 'poll', ...counts, counts: { 'option-cafe': 3, 'option-park': 2 } },
      null,
    ],
    [
      'wordcloud',
      cloud,
      { type: 'wordcloud', ...counts, words: [{ text: 'sunny', count: 3 }] },
      null,
    ],
    ['open', open, { type: 'open', ...counts, responses: [], omitted: 4 }, null],
    [
      'rating',
      rating,
      { type: 'rating', ...counts, histogram: [0, 1, 1, 2, 1], average: 3.6 },
      null,
    ],
  ];

  const resume = (question: PublicQuestion, result: QuestionResult) =>
    run(
      welcome(
        snapshot({
          phase: 'reveal',
          questionIndex: 2,
          reveal: { result, you: outcome({ correct: false }), question },
        }),
      ),
    );

  for (const [type, question, result, expected] of CASES) {
    it(`${type}: the resumed reveal shows what the connected one does`, () => {
      const resumed = resume(question, result);
      expect(resumed.view).toMatchObject({ screen: 'reveal', index: 2, correctAnswer: expected });
      // The same reveal delivered live, on a phone that had the question open.
      const reveal: ServerMessage = {
        type: 'reveal',
        ts: T0 + 25_000,
        sv: 3,
        index: 2,
        result,
        you: outcome({ correct: false }),
      };
      const live = run(welcome(snapshot({ sv: 1 })), questionMsg(question, { sv: 2 }), reveal);
      expect(live.view).toMatchObject({ correctAnswer: expected });
    });
  }

  it('single: a player who answered wrongly is told the right answer after a resume', () => {
    const s = resume(single, singleResult);
    expect(s.view).toMatchObject({
      variant: 'incorrect',
      correctAnswer: { slot: 1, text: 'Venus' },
    });
  });

  it('a question that does not match the result gives no answer text instead of a wrong one', () => {
    expect(resume(poll, singleResult).view).toMatchObject({ correctAnswer: null });
  });

  it('keeps what the page already held when the snapshot leaves the question out', () => {
    const s = run(
      welcome(questionSnap(single, -25_000, { sv: 11 })),
      { type: 'connection', status: 'reconnecting' },
      { type: 'connection', status: 'open' },
      welcome(
        snapshot({
          sv: 12,
          phase: 'reveal',
          questionIndex: 2,
          reveal: { result: singleResult, you: outcome({ correct: false }) },
        }),
      ),
    );
    expect(s.view).toMatchObject({ correctAnswer: { slot: 1, text: 'Venus' } });
  });

  it('the same reveal delivered twice keeps the answer card', () => {
    const s = run(
      welcome(snapshot({ sv: 1 })),
      questionMsg(single, { sv: 2 }),
      revealMsg(outcome({ correct: false }), { sv: 3 }),
      revealMsg(outcome({ correct: false }), { sv: 3 }),
    );
    expect(s.view).toMatchObject({ correctAnswer: { slot: 1, text: 'Venus' } });
  });
});

describe('leaderboard and ended', () => {
  it("leaderboard shows the player's own standing and updates score and rank", () => {
    const standing = { score: 2100, rank: 4, behind: { nickname: 'Kim', points: 120 } };
    const s = run(welcome(snapshot({ sv: 1 })), {
      type: 'leaderboard',
      ts: T0,
      sv: 2,
      index: 2,
      entries: [],
      you: standing,
    });
    expect(s.view).toMatchObject({ screen: 'leaderboard', standing });
    expect(s.me).toMatchObject({ score: 2100, rank: 4 });
  });
});

describe('the ways a game ends for this player', () => {
  const inGame = () => run(welcome(snapshot({ sv: 1 })), questionMsg(single, { sv: 2 }));

  it('kicked message', () => {
    expect(
      playerReducer(inGame(), { type: 'message', msg: { type: 'kicked', ts: T0 } }).view,
    ).toEqual({
      screen: 'kicked',
    });
  });

  it('error kicked', () => {
    const s = playerReducer(inGame(), {
      type: 'message',
      msg: { type: 'error', ts: T0, code: 'kicked', message: 'removed' },
    });
    expect(s.view.screen).toBe('kicked');
  });

  it('errors session-ended and not-found show session-over with the reason', () => {
    for (const code of ['session-ended', 'not-found'] as const) {
      const s = playerReducer(inGame(), {
        type: 'message',
        msg: { type: 'error', ts: T0, code, message: 'gone' },
      });
      expect(s.view).toEqual({ screen: 'session-over', reason: code });
    }
  });

  it('protocol-version shows out-of-date, keeps the player in the game, and is final', () => {
    const s = playerReducer(inGame(), {
      type: 'message',
      msg: { type: 'error', ts: T0, code: 'protocol-version', message: 'need v2' },
    });
    expect(s.view).toEqual({ screen: 'out-of-date' });
    // Still the same player in the same game: only a reload is needed, not a new join.
    expect(s.me).toMatchObject({ playerId: ME.playerId });
    for (const msg of [welcome(snapshot({ sv: 99 })), questionMsg(single, { sv: 100 })]) {
      expect(playerReducer(s, { type: 'message', msg }).view.screen).toBe('out-of-date');
    }
  });

  it('other errors do not change the screen', () => {
    for (const code of ['rate-limited', 'internal', 'bad-request', 'conflict'] as const) {
      const before = inGame();
      const after = playerReducer(before, {
        type: 'message',
        msg: { type: 'error', ts: T0, code, message: 'oops' },
      });
      expect(after.view).toEqual(before.view);
    }
  });

  it('kicked and session-over are final', () => {
    const kicked = playerReducer(inGame(), { type: 'message', msg: { type: 'kicked', ts: T0 } });
    for (const msg of [welcome(snapshot({ sv: 99 })), questionMsg(single, { sv: 100 })]) {
      expect(playerReducer(kicked, { type: 'message', msg }).view.screen).toBe('kicked');
    }
    const over = playerReducer(inGame(), {
      type: 'message',
      msg: { type: 'error', ts: T0, code: 'session-ended', message: 'done' },
    });
    expect(
      playerReducer(over, { type: 'message', msg: welcome(snapshot({ sv: 99 })) }).view.screen,
    ).toBe('session-over');
  });

  it('host-only messages and pongs change nothing visible', () => {
    const before = inGame();
    const after = playerReducer(before, {
      type: 'message',
      msg: { type: 'pong', ts: T0, t: 1 },
    });
    expect(after.view).toEqual(before.view);
  });
});

describe('connection status', () => {
  it('is tracked without touching the screen', () => {
    const before = run(welcome(questionSnap(single, -2_000)));
    const after = playerReducer(before, { type: 'connection', status: 'reconnecting' });
    expect(after.connection).toBe('reconnecting');
    expect(after.view).toEqual(before.view);
  });

  it('returns the same state object when nothing changed', () => {
    const s = initialPlayerState('open');
    expect(playerReducer(s, { type: 'connection', status: 'open' })).toBe(s);
  });
});
