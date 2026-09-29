import { describe, expect, it } from 'vitest';
import type { HostSnapshot, ServerMessage } from '@zqhoot/protocol';
import { NOW } from '../src/dev/fixtures/common.ts';
import {
  HOST_SV,
  LEADERBOARD,
  MERCURY_RESULT,
  PODIUM,
  hostSnapshot,
  openQ,
  openResponses,
  pollQ,
  questionSnapshot,
  revealSnapshot,
  roster,
  singleQ,
  wordCloudQ,
} from '../src/dev/fixtures/hostSnapshots.ts';
import { connectedCount, hostReducer, initialHostState, playerCount } from '../src/state/host.ts';
import type { HostAction, HostState } from '../src/state/host.ts';

const welcome = (snapshot: HostSnapshot, ts = NOW): ServerMessage => ({
  type: 'welcome',
  ts,
  role: 'host',
  snapshot,
});
const hostState = (snapshot: HostSnapshot, ts = NOW): ServerMessage => ({
  type: 'host.state',
  ts,
  snapshot,
});
const msg = (m: ServerMessage): HostAction => ({ type: 'message', msg: m });

const ACTIONS = ['message', 'connection', 'moderated', 'send.failed', 'notice.dismiss', 'reset'];

/** Folds a mix of local actions and server messages, starting from an open connection. */
function run(...steps: Array<HostAction | ServerMessage>): HostState {
  return steps.reduce<HostState>(
    (s, step) =>
      hostReducer(
        s,
        ACTIONS.includes(step.type) ? (step as HostAction) : msg(step as ServerMessage),
      ),
    initialHostState('open'),
  );
}

const apply = (s: HostState, m: ServerMessage) => hostReducer(s, msg(m));

describe('initial state', () => {
  it('knows nothing until the first snapshot', () => {
    const s = initialHostState();
    expect(s.snapshot).toBeNull();
    expect(s.sv).toBe(-1);
    expect(s.roster).toEqual([]);
    expect(s.live).toBeNull();
    expect(s.connection).toBe('idle');
  });
});

describe('welcome and host.state', () => {
  it('a host welcome installs the snapshot and its roster', () => {
    const s = apply(initialHostState('open'), welcome(hostSnapshot()));
    expect(s.snapshot?.phase).toBe('lobby');
    expect(s.sv).toBe(HOST_SV);
    expect(playerCount(s)).toBe(22);
  });

  it('ignores a player welcome', () => {
    const s = apply(initialHostState(), {
      type: 'welcome',
      ts: NOW,
      role: 'player',
      snapshot: {
        sv: 1,
        sessionId: 'session-demo-01',
        quizTitle: 'x',
        phase: 'lobby',
        questionIndex: -1,
        totalQuestions: 1,
        you: { playerId: 'player-0001', nickname: 'Ana', score: 0, rank: null, streak: 0 },
      },
    });
    expect(s.snapshot).toBeNull();
  });

  it('applies a newer or equal sv and drops an older one', () => {
    let s = apply(initialHostState(), welcome(hostSnapshot({ sv: 10, locked: false })));
    s = apply(s, hostState(hostSnapshot({ sv: 11, locked: true })));
    expect(s.snapshot?.locked).toBe(true);
    const older = apply(s, hostState(hostSnapshot({ sv: 9, locked: false })));
    expect(older).toBe(s);
    const same = apply(s, hostState(hostSnapshot({ sv: 11, locked: false })));
    expect(same.snapshot?.locked).toBe(false);
  });

  it('a second welcome on the same connection with a lower sv is ignored', () => {
    let s = apply(initialHostState(), welcome(hostSnapshot({ sv: 50 })));
    s = apply(s, welcome(hostSnapshot({ sv: 49, locked: true })));
    expect(s.sv).toBe(50);
    expect(s.snapshot?.locked).toBe(false);
  });

  it('a welcome older than a host.state from the same socket is ignored', () => {
    const s = run(
      welcome(hostSnapshot({ sv: 10 })),
      { type: 'connection', status: 'reconnecting' },
      { type: 'connection', status: 'open' },
      hostState(hostSnapshot({ sv: 11, locked: true })),
      welcome(hostSnapshot({ sv: 10, locked: false })),
    );
    expect(s.sv).toBe(11);
    expect(s.snapshot?.locked).toBe(true);
  });

  it('the first welcome of a new connection wins even with a lower sv (a restarted server may roll back)', () => {
    const s = run(
      welcome(hostSnapshot({ sv: 50 })),
      { type: 'connection', status: 'reconnecting' },
      { type: 'connection', status: 'open' },
      welcome(hostSnapshot({ sv: 49, locked: true })),
    );
    expect(s.sv).toBe(49);
    expect(s.snapshot?.locked).toBe(true);
    // ... and then it competes with what this connection delivers.
    expect(apply(s, welcome(hostSnapshot({ sv: 48 }))).sv).toBe(49);
  });

  it('a reset (new sign-in, new connection) starts a new race too', () => {
    const s = run(
      welcome(hostSnapshot({ sv: 50 })),
      { type: 'reset', connection: 'connecting' },
      welcome(hostSnapshot({ sv: 3 })),
    );
    expect(s.sv).toBe(3);
  });

  it('folds a mix of actions and messages', () => {
    const s = run(
      welcome(hostSnapshot()),
      { type: 'connection', status: 'reconnecting' },
      hostState(hostSnapshot({ sv: HOST_SV + 1, locked: true })),
    );
    expect(s.connection).toBe('reconnecting');
    expect(s.snapshot?.locked).toBe(true);
  });

  it('keeps the connection status apart from the snapshot', () => {
    let s = apply(initialHostState('connecting'), welcome(hostSnapshot()));
    expect(s.connection).toBe('connecting');
    s = hostReducer(s, { type: 'connection', status: 'reconnecting' });
    expect(s.connection).toBe('reconnecting');
    expect(s.snapshot).not.toBeNull();
    expect(hostReducer(s, { type: 'connection', status: 'reconnecting' })).toBe(s);
  });
});

describe('a snapshot in every phase', () => {
  const phases: Array<[string, HostSnapshot]> = [
    ['lobby', hostSnapshot()],
    ['question', questionSnapshot(singleQ, 5_000)],
    ['revealing', questionSnapshot(singleQ, 25_000, { phase: 'revealing' })],
    ['reveal', revealSnapshot(singleQ, MERCURY_RESULT)],
    [
      'leaderboard',
      hostSnapshot({ phase: 'leaderboard', questionIndex: 2, leaderboard: LEADERBOARD }),
    ],
    ['ended', hostSnapshot({ phase: 'ended', questionIndex: 9, podium: PODIUM })],
  ];

  for (const [phase, snap] of phases) {
    it(`installs ${phase}`, () => {
      const s = apply(initialHostState(), welcome(snap));
      expect(s.snapshot).toEqual(snap);
      // Live figures exist only while a question is open.
      expect(s.live !== null).toBe(phase === 'question');
    });
  }
});

describe('roster deltas', () => {
  const base = () => apply(initialHostState(), welcome(hostSnapshot({ roster: roster(3) })));

  it('adds new players at the end and updates known ones in place', () => {
    let s = base();
    s = apply(s, {
      type: 'roster',
      ts: NOW,
      upsert: [
        { playerId: 'player-0001', nickname: 'Ana', connected: false },
        { playerId: 'player-0099', nickname: 'Newcomer', connected: true },
      ],
      removed: [],
    });
    expect(s.roster.map((r) => r.playerId)).toEqual([
      'player-0001',
      'player-0002',
      'player-0003',
      'player-0099',
    ]);
    expect(s.roster[0]?.connected).toBe(false);
    expect(connectedCount(s)).toBe(3);
  });

  it('removes players', () => {
    const s = apply(base(), { type: 'roster', ts: NOW, upsert: [], removed: ['player-0002'] });
    expect(s.roster.map((r) => r.playerId)).toEqual(['player-0001', 'player-0003']);
  });

  it('a snapshot replaces the roster', () => {
    let s = base();
    s = apply(s, hostState(hostSnapshot({ sv: HOST_SV + 1, roster: roster(1) })));
    expect(s.roster).toHaveLength(1);
  });

  it('is ignored before the first snapshot', () => {
    const s = apply(initialHostState(), {
      type: 'roster',
      ts: NOW,
      upsert: [{ playerId: 'player-0001', nickname: 'Ana', connected: true }],
      removed: [],
    });
    expect(s.roster).toEqual([]);
  });
});

describe('stats', () => {
  const stats = (
    index: number,
    s: Extract<ServerMessage, { type: 'stats' }>['stats'],
  ): ServerMessage => ({
    type: 'stats',
    ts: NOW,
    questionIndex: index,
    stats: s,
  });

  it('is kept for the open question', () => {
    let s = apply(initialHostState(), welcome(questionSnapshot(pollQ, 5_000)));
    s = apply(
      s,
      stats(2, {
        type: 'poll',
        answered: 5,
        totalPlayers: 22,
        counts: { 'option-cafe': 3, 'option-park': 2, 'option-deli': 0 },
      }),
    );
    expect(s.live?.stats).toMatchObject({ type: 'poll', answered: 5 });
  });

  it('ignores stats for another question, or when none is open', () => {
    const open = apply(initialHostState(), welcome(questionSnapshot(pollQ, 5_000)));
    const wrong = apply(
      open,
      stats(7, { type: 'poll', answered: 5, totalPlayers: 22, counts: {} }),
    );
    expect(wrong).toBe(open);
    const lobby = apply(initialHostState(), welcome(hostSnapshot()));
    expect(apply(lobby, stats(2, { type: 'poll', answered: 1, totalPlayers: 2, counts: {} }))).toBe(
      lobby,
    );
  });

  it('merges open-ended pages by id, oldest first, and lets the server status win', () => {
    let s = apply(initialHostState(), welcome(questionSnapshot(openQ, 5_000)));
    const all = openResponses();
    s = apply(
      s,
      stats(2, {
        type: 'open',
        answered: 4,
        totalPlayers: 22,
        responses: all.slice(2, 5),
        cursor: 'c1',
      }),
    );
    s = apply(
      s,
      stats(2, {
        type: 'open',
        answered: 6,
        totalPlayers: 22,
        // The next poll resumes from the last cursor, so the last page comes back too, with
        // the status the server holds now.
        responses: [{ ...(all[4] as (typeof all)[number]), status: 'visible' }, ...all.slice(0, 2)],
        cursor: null,
      }),
    );
    expect(s.live?.responses.map((r) => r.id)).toEqual(all.slice(0, 5).map((r) => r.id));
    expect(s.live?.responses.find((r) => r.id === all[4]?.id)?.status).toBe('visible');
  });

  it('a new question starts its figures afresh; the same question keeps them', () => {
    let s = apply(initialHostState(), welcome(questionSnapshot(wordCloudQ, 5_000)));
    s = apply(
      s,
      stats(2, {
        type: 'wordcloud',
        answered: 3,
        totalPlayers: 22,
        words: [{ text: 'sunny', count: 3 }],
      }),
    );
    const sameQuestion = apply(
      s,
      hostState(questionSnapshot(wordCloudQ, 6_000, { sv: HOST_SV + 1 })),
    );
    expect(sameQuestion.live?.stats).not.toBeNull();
    const next = apply(s, hostState(questionSnapshot(pollQ, 1_000, { sv: HOST_SV + 2 }, 3)));
    expect(next.live?.stats).toBeNull();
    expect(next.live?.questionIndex).toBe(3);
    const reveal = apply(
      s,
      hostState(revealSnapshot(singleQ, MERCURY_RESULT, { sv: HOST_SV + 3 })),
    );
    expect(reveal.live).toBeNull();
  });

  it('a reconnect keeps the responses already collected', () => {
    let s = apply(initialHostState(), welcome(questionSnapshot(openQ, 5_000)));
    s = apply(
      s,
      stats(2, {
        type: 'open',
        answered: 2,
        totalPlayers: 22,
        responses: openResponses().slice(0, 2),
        cursor: null,
      }),
    );
    s = apply(s, welcome(questionSnapshot(openQ, 9_000), NOW + 4_000));
    expect(s.live?.responses).toHaveLength(2);
  });
});

describe('moderation', () => {
  it('updates the local status at once, since the server sends no ack', () => {
    let s = apply(initialHostState(), welcome(questionSnapshot(openQ, 5_000)));
    const all = openResponses();
    s = apply(s, {
      type: 'stats',
      ts: NOW,
      questionIndex: 2,
      stats: {
        type: 'open',
        answered: 5,
        totalPlayers: 22,
        responses: all.slice(0, 5),
        cursor: null,
      },
    });
    const pending = all[4];
    expect(pending?.status).toBe('pending');
    s = hostReducer(s, { type: 'moderated', responseId: pending?.id as string, status: 'visible' });
    expect(s.live?.responses.find((r) => r.id === pending?.id)?.status).toBe('visible');
  });

  it('a refused moderation raises a notice and asks the poller to re-read', () => {
    let s = apply(initialHostState(), welcome(questionSnapshot(openQ, 5_000)));
    s = apply(s, {
      type: 'error',
      ts: NOW,
      code: 'conflict',
      message: 'closed',
      ref: 'host.moderate',
    });
    expect(s.notice).toMatchObject({ code: 'conflict', ref: 'host.moderate' });
    expect(s.moderationFailures).toBe(1);
  });

  it('does nothing outside a question', () => {
    const s = apply(initialHostState(), welcome(hostSnapshot()));
    expect(hostReducer(s, { type: 'moderated', responseId: 'x-0', status: 'hidden' })).toBe(s);
  });
});

describe('errors', () => {
  const error = (
    code: Extract<ServerMessage, { type: 'error' }>['code'],
    ref?: string,
  ): ServerMessage => ({
    type: 'error',
    ts: NOW,
    code,
    message: `server says ${code}`,
    ...(ref ? { ref } : {}),
  });
  const open = () => apply(initialHostState('open'), welcome(hostSnapshot()));

  it('ends the screen for the final errors and then ignores everything', () => {
    for (const [code, ended] of [
      ['unauthorized', 'unauthorized'],
      ['forbidden', 'unauthorized'],
      ['session-ended', 'session-ended'],
      ['not-found', 'not-found'],
      ['protocol-version', 'out-of-date'],
    ] as const) {
      const s = apply(open(), error(code));
      expect(s.ended, code).toBe(ended);
      expect(apply(s, hostState(hostSnapshot({ sv: 99, locked: true })))).toBe(s);
    }
  });

  it('keeps the screen for a refused command and says why', () => {
    const s = apply(open(), error('rate-limited', 'host.next'));
    expect(s.ended).toBeNull();
    expect(s.notice).toMatchObject({ code: 'rate-limited', ref: 'host.next' });
    expect(s.notice?.message).toMatch(/slow down/i);
    expect(s.snapshot).not.toBeNull();
  });

  it('counts a refused close that may pass, so the driver can send it again', () => {
    let s = apply(open(), error('rate-limited', 'host.close'));
    expect(s.closeRefusals).toBe(1);
    s = apply(s, error('internal', 'host.close'));
    s = apply(s, error('conflict', 'host.close'));
    expect(s.closeRefusals).toBe(3);
    expect(s.notice).toMatchObject({ code: 'conflict', ref: 'host.close' });
    // A malformed close would fail the same way again, and other commands are not closes.
    expect(apply(s, error('bad-request', 'host.close')).closeRefusals).toBe(3);
    expect(apply(s, error('rate-limited', 'host.next')).closeRefusals).toBe(3);
  });

  it('every notice gets a new seq, so the same text twice is announced again', () => {
    let s = apply(open(), error('internal'));
    const first = s.notice?.seq;
    s = apply(s, error('internal'));
    expect(s.notice?.seq).toBe((first ?? 0) + 1);
  });

  it('an unsent command becomes an offline notice, which can be dismissed', () => {
    let s = hostReducer(open(), { type: 'send.failed', what: 'Next' });
    expect(s.notice?.code).toBe('offline');
    expect(s.notice?.message).toContain('Next');
    s = hostReducer(s, { type: 'notice.dismiss' });
    expect(s.notice).toBeNull();
  });

  it('a reset after a refreshed sign-in forgets the final state', () => {
    let s = apply(open(), error('unauthorized'));
    expect(s.ended).toBe('unauthorized');
    s = hostReducer(s, { type: 'reset', connection: 'connecting' });
    expect(s).toEqual(initialHostState('connecting'));
  });

  it('pong and player messages change nothing', () => {
    const s = open();
    expect(apply(s, { type: 'pong', ts: NOW, t: 1 })).toBe(s);
    expect(apply(s, { type: 'kicked', ts: NOW })).toBe(s);
  });
});
