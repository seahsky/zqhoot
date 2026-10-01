import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, Phase, TIMING } from '@zqhoot/protocol';
import type { ClientMessage, ServerMessage } from '@zqhoot/protocol';
import { NOW } from '../src/dev/fixtures/common.ts';
import { PLAY_FIXTURES } from '../src/dev/fixtures/player.ts';
import {
  MERCURY_RESULT,
  hostSnapshot,
  questionSnapshot,
  revealSnapshot,
  singleQ,
} from '../src/dev/fixtures/hostSnapshots.ts';
import { Connection } from '../src/net/connection.ts';
import type { ConnectionOptions } from '../src/net/connection.ts';
import { hostReducer, initialHostState } from '../src/state/host.ts';
import { initialPlayerState, playerReducer } from '../src/state/player.ts';
import type { PlayerScreen } from '../src/state/player.ts';
import { hostMayReconnect, playerMayReconnect } from '../src/state/reconnect.ts';
import { FakeDocument, FakeTimers, FakeWebSocket } from './helpers/fakes.ts';

/**
 * ADR-0008: the planned reconnect happens between questions. What is asked of `Connection` is
 * a pure function of the screen (player) or phase (host and presenter); these tests pin it for
 * every one, then run it inside a real `Connection` and reducer, the way the pages do.
 */

/** Written out apart from the implementation. A new screen makes this a compile error. */
const PLAYER: Record<PlayerScreen, boolean> = {
  connecting: true,
  lobby: true,
  'get-ready': false,
  answering: false,
  submitted: false,
  'times-up': true,
  reveal: true,
  leaderboard: true,
  ended: true,
  kicked: true,
  'session-over': true,
  'out-of-date': true,
};

describe('playerMayReconnect', () => {
  for (const [screen, allowed] of Object.entries(PLAYER) as Array<[PlayerScreen, boolean]>) {
    it(`${screen}: ${allowed ? 'may reconnect' : 'holds the reconnect'}`, () => {
      expect(playerMayReconnect(screen)).toBe(allowed);
    });
  }

  it('agrees with the screens the reducer really reaches, for every gallery fixture', () => {
    const reached = new Set<PlayerScreen>(['connecting']);
    expect(playerMayReconnect(initialPlayerState().view.screen)).toBe(PLAYER.connecting);
    for (const state of Object.values(PLAY_FIXTURES)) {
      reached.add(state.view.screen);
      expect(playerMayReconnect(state.view.screen), state.view.screen).toBe(
        PLAYER[state.view.screen],
      );
    }
    expect([...reached].sort()).toEqual(Object.keys(PLAYER).sort());
  });

  it('holds from the count-in until the deadline, for every question type', () => {
    const open = ['play-get-ready', 'play-answer-single', 'play-answer-truefalse'] as const;
    for (const id of [
      ...open,
      'play-answer-poll-6',
      'play-answer-wordcloud',
      'play-answer-open',
      'play-answer-rating',
      'play-submitted',
    ] as const) {
      expect(playerMayReconnect(PLAY_FIXTURES[id].view.screen), id).toBe(false);
    }
    expect(playerMayReconnect(PLAY_FIXTURES['play-times-up'].view.screen)).toBe(true);
  });
});

const HOST: Record<Phase, boolean> = {
  lobby: true,
  question: false,
  revealing: false,
  reveal: true,
  leaderboard: true,
  ended: true,
};

describe('hostMayReconnect (control and presenter)', () => {
  for (const phase of Phase.options) {
    it(`${phase}: ${HOST[phase] ? 'may reconnect' : 'holds the reconnect'}`, () => {
      expect(hostMayReconnect(phase)).toBe(HOST[phase]);
    });
  }

  it('may reconnect before the first snapshot', () => {
    expect(hostMayReconnect(null)).toBe(true);
  });

  it('covers every phase the protocol has', () => {
    expect(Object.keys(HOST).sort()).toEqual([...Phase.options].sort());
  });
});

describe('the pages that own a connection hold the planned reconnect', () => {
  const source = (path: string) =>
    readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

  it('PlayPage asks playerMayReconnect with the current screen', () => {
    expect(source('../src/screens/play/PlayPage.tsx')).toMatch(
      /canReconnectNow:\s*\(\)\s*=>\s*playerMayReconnect\(screenRef\.current\)/,
    );
  });

  it('the host session, shared by the control page and the presenter, asks hostMayReconnect', () => {
    const src = source('../src/screens/host/useHostSession.ts');
    expect(src).toMatch(/canReconnectNow:\s*\(\)\s*=>\s*hostMayReconnect\(phaseRef\.current\)/);
    expect(src).toMatch(/phaseRef\.current\s*=\s*snapshot\?\.phase/);
    for (const page of [
      '../src/screens/host/LivePage.tsx',
      '../src/screens/present/PresentPage.tsx',
    ]) {
      expect(source(page), page).toContain('useHostSession(');
    }
  });

  it('only these three places open a Connection; a new one must decide about the reconnect too', () => {
    const root = fileURLToPath(new URL('../src', import.meta.url));
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (
          /\.tsx?$/.test(entry.name) &&
          readFileSync(path, 'utf8').includes('new Connection(')
        ) {
          found.push(relative(root, path));
        }
      }
    };
    walk(root);
    // JoinPage lives for the seconds of one join and never reaches 110 minutes.
    expect(found.sort()).toEqual([
      'screens/host/useHostSession.ts',
      'screens/join/JoinPage.tsx',
      'screens/play/PlayPage.tsx',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Inside a real Connection: no new socket while a question is open
// ---------------------------------------------------------------------------

const RESUME: ClientMessage = {
  type: 'resume',
  v: PROTOCOL_VERSION,
  sessionId: 'session-demo-01',
  playerId: 'player-riley-01',
  token: 'x'.repeat(43),
};

function connection(canReconnectNow: ConnectionOptions['canReconnectNow']) {
  FakeWebSocket.reset();
  const timers = new FakeTimers();
  const conn = new Connection({
    url: 'wss://example.test/ws',
    hello: () => RESUME,
    onMessage: () => undefined,
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    now: () => NOW + timers.now,
    random: () => 0.5,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    document: new FakeDocument() as unknown as ConnectionOptions['document'],
    window: new FakeDocument() as unknown as ConnectionOptions['window'],
    canReconnectNow,
  });
  conn.start();
  const ws = FakeWebSocket.last;
  ws.serverOpens();
  return { conn, timers, ws };
}

/** Traffic every 30 s, so only the planned reconnect can end the link. */
function advanceTo(h: ReturnType<typeof connection>, at: number): void {
  while (h.timers.now + 30_000 < at) {
    h.timers.advance(30_000);
    h.ws.serverSends({ type: 'pong', ts: NOW + h.timers.now, t: 0 });
  }
  h.timers.advance(at - h.timers.now);
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('a player connection past plannedReconnectMs', () => {
  it('stays on its socket while a question is open, and moves between questions', () => {
    let state = playerReducer(initialPlayerState('open'), {
      type: 'message',
      msg: { type: 'welcome', ts: NOW, role: 'player', snapshot: questionForPlayer() },
    });
    expect(state.view.screen).toBe('answering');
    const h = connection(() => playerMayReconnect(state.view.screen));

    advanceTo(h, TIMING.plannedReconnectMs + 60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(h.ws.closeCalls).toEqual([]);

    // The question closes and the reveal goes out: the next check may go ahead.
    const reveal: ServerMessage = {
      type: 'reveal',
      ts: NOW + 1,
      sv: 99,
      index: 2,
      result: {
        type: 'single',
        answered: 1,
        totalPlayers: 1,
        correctOptionId: 'option-mercury',
        counts: { 'option-mercury': 1 },
      },
      you: {
        answered: false,
        points: 0,
        streakBonus: 0,
        score: 0,
        rank: 1,
        streak: 0,
      },
    };
    state = playerReducer(state, { type: 'message', msg: reveal });
    expect(state.view.screen).toBe('reveal');
    h.ws.serverSends({ type: 'pong', ts: NOW + h.timers.now, t: 0 });
    h.timers.advance(5_000 + 250);
    expect(h.ws.closeCalls).toHaveLength(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});

describe('a host or presenter connection past plannedReconnectMs', () => {
  it('stays on its socket while a question is open, and moves once the results are out', () => {
    let state = hostReducer(initialHostState('open'), {
      type: 'message',
      msg: { type: 'welcome', ts: NOW, role: 'host', snapshot: questionSnapshot(singleQ, 6_000) },
    });
    expect(state.snapshot?.phase).toBe('question');
    const h = connection(() => hostMayReconnect(state.snapshot?.phase ?? null));

    advanceTo(h, TIMING.plannedReconnectMs + 60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);

    state = hostReducer(state, {
      type: 'message',
      msg: {
        type: 'host.state',
        ts: NOW + 1,
        snapshot: revealSnapshot(singleQ, MERCURY_RESULT, { sv: 99 }),
      },
    });
    expect(state.snapshot?.phase).toBe('reveal');
    h.ws.serverSends({ type: 'pong', ts: NOW + h.timers.now, t: 0 });
    h.timers.advance(5_000 + 250);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('a lobby host reconnects on schedule', () => {
    const state = hostReducer(initialHostState('open'), {
      type: 'message',
      msg: { type: 'welcome', ts: NOW, role: 'host', snapshot: hostSnapshot() },
    });
    const h = connection(() => hostMayReconnect(state.snapshot?.phase ?? null));
    advanceTo(h, TIMING.plannedReconnectMs);
    expect(h.ws.closeCalls).toHaveLength(1);
  });
});

/** An open question, as a resumed player's snapshot. */
function questionForPlayer() {
  return {
    sv: 10,
    sessionId: 'session-demo-01',
    quizTitle: 'Friday night trivia',
    phase: 'question' as const,
    questionIndex: 2,
    totalQuestions: 8,
    you: { playerId: 'player-riley-01', nickname: 'Riley', score: 0, rank: null, streak: 0 },
    question: {
      question: {
        id: 'question-planet',
        type: 'single' as const,
        prompt: 'Which planet is closest to the Sun?',
        timeLimitSec: null,
        points: 1 as const,
        options: [
          { id: 'option-mercury', text: 'Mercury' },
          { id: 'option-venus', text: 'Venus' },
        ],
      },
      openAt: NOW - 1_000,
      deadline: null,
    },
  };
}
