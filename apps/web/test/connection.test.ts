import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { PROTOCOL_VERSION, TIMING } from '@zqhoot/protocol';
import type { ClientMessage, ServerMessage } from '@zqhoot/protocol';
import { Connection } from '../src/net/connection.ts';
import type { ConnectionOptions, ConnectionStatus } from '../src/net/connection.ts';
import { FakeDocument, FakeTimers, FakeWebSocket } from './helpers/fakes.ts';

const RESUME: ClientMessage = {
  type: 'resume',
  v: PROTOCOL_VERSION,
  sessionId: 'session-demo-01',
  playerId: 'player-riley-01',
  token: 'x'.repeat(43),
};

const pong = (ts: number, t = 0): ServerMessage => ({ type: 'pong', ts, t });

interface Harness {
  conn: Connection;
  timers: FakeTimers;
  doc: FakeDocument;
  win: FakeDocument;
  messages: ServerMessage[];
  statuses: ConnectionStatus[];
  hello: Mock<() => ClientMessage | null>;
}

function setup(over: Partial<ConnectionOptions> = {}, random = () => 0.5): Harness {
  FakeWebSocket.reset();
  const timers = new FakeTimers();
  const doc = new FakeDocument();
  const win = new FakeDocument();
  const messages: ServerMessage[] = [];
  const statuses: ConnectionStatus[] = [];
  const hello = vi.fn<() => ClientMessage | null>(() => RESUME);
  const conn = new Connection({
    url: 'wss://example.test/ws',
    hello,
    onMessage: (m) => messages.push(m),
    onStatus: (s) => statuses.push(s),
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    now: () => 1_000_000 + timers.now,
    random,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    document: doc as unknown as ConnectionOptions['document'],
    window: win as unknown as ConnectionOptions['window'],
    ...over,
  });
  return { conn, timers, doc, win, messages, statuses, hello };
}

/** Starts, opens the first socket, and returns it. */
function connected(h: Harness): FakeWebSocket {
  h.conn.start();
  const ws = FakeWebSocket.last;
  ws.serverOpens();
  return ws;
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('Connection lifecycle', () => {
  it('connects, sends hello first on open, and reports statuses', () => {
    const h = setup();
    expect(h.conn.status).toBe('idle');
    h.conn.start();
    expect(h.conn.status).toBe('connecting');
    expect(FakeWebSocket.last.url).toBe('wss://example.test/ws');
    expect(FakeWebSocket.last.sent).toEqual([]);

    FakeWebSocket.last.serverOpens();
    expect(h.conn.status).toBe('open');
    expect(FakeWebSocket.last.sentMessages).toEqual([RESUME]);
    expect(h.statuses).toEqual(['connecting', 'open']);
  });

  it('sends nothing when hello returns null', () => {
    const h = setup();
    h.hello.mockReturnValue(null);
    const ws = connected(h);
    expect(ws.sent).toEqual([]);
    expect(h.conn.status).toBe('open');
  });

  it('start() is idempotent', () => {
    const h = setup();
    h.conn.start();
    h.conn.start();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('send() returns false unless open, and true once it is', () => {
    const h = setup();
    expect(h.conn.send({ type: 'ping', t: 1 })).toBe(false);
    h.conn.start();
    expect(h.conn.send({ type: 'ping', t: 1 })).toBe(false);
    FakeWebSocket.last.serverOpens();
    expect(h.conn.send({ type: 'ping', t: 2 })).toBe(true);
    expect(FakeWebSocket.last.sentMessages.at(-1)).toEqual({ type: 'ping', t: 2 });
  });

  it('delivers valid messages and feeds the clock before onMessage', () => {
    const seen: Array<{ msg: ServerMessage; offset: number | null }> = [];
    let conn: Connection | undefined;
    const h = setup({
      onMessage: (msg) => seen.push({ msg, offset: conn?.clock.offsetMs ?? null }),
    });
    conn = h.conn;
    const ws = connected(h);
    ws.serverSends(pong(1_000_000 - 30)); // local receive is 1_000_000, so offset 30
    expect(seen).toEqual([{ msg: pong(1_000_000 - 30), offset: 30 }]);
    ws.serverSends(pong(1_000_000 - 10));
    expect(conn.clock.offsetMs).toBe(10);
  });
});

describe('reconnect and backoff', () => {
  it('calls hello again on every reconnect', () => {
    const h = setup();
    connected(h);
    for (let i = 0; i < 3; i++) {
      FakeWebSocket.last.serverCloses();
      h.timers.advance(TIMING.reconnectCapMs);
      FakeWebSocket.last.serverOpens();
    }
    expect(FakeWebSocket.instances).toHaveLength(4);
    expect(h.hello).toHaveBeenCalledTimes(4);
    for (const ws of FakeWebSocket.instances) expect(ws.sentMessages).toEqual([RESUME]);
  });

  it('reports reconnecting while waiting, and after any failure before the first open', () => {
    const h = setup();
    h.conn.start();
    FakeWebSocket.last.serverCloses(); // never opened
    expect(h.conn.status).toBe('reconnecting');
    h.timers.advance(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(h.conn.status).toBe('reconnecting');
    FakeWebSocket.last.serverOpens();
    expect(h.conn.status).toBe('open');
  });

  it('schedules full-jitter delays that grow with each quick failure', () => {
    const h = setup({}, () => 0.5);
    h.conn.start();
    const expected = [250, 500, 1_000, 2_000, 4_000, 5_000, 5_000]; // cap 10 s, random 0.5
    for (const delay of expected) {
      const before = FakeWebSocket.instances.length;
      FakeWebSocket.last.serverCloses();
      h.timers.advance(delay - 1);
      expect(FakeWebSocket.instances).toHaveLength(before);
      h.timers.advance(1);
      expect(FakeWebSocket.instances).toHaveLength(before + 1);
    }
  });

  it('never gives up', () => {
    const h = setup({}, () => 0.99);
    h.conn.start();
    for (let i = 0; i < 200; i++) {
      FakeWebSocket.last.serverCloses();
      h.timers.advance(TIMING.reconnectCapMs);
    }
    expect(FakeWebSocket.instances).toHaveLength(201);
    expect(h.conn.status).toBe('reconnecting');
  });

  it('resets the attempt counter only after 10 s open', () => {
    const h = setup({}, () => 0.5);
    connected(h);
    // Two quick failures push the counter up: delays 250 then 500.
    FakeWebSocket.last.serverCloses();
    h.timers.advance(250);
    FakeWebSocket.last.serverOpens();
    h.timers.advance(9_999); // not stable yet
    FakeWebSocket.last.serverCloses();
    let n = FakeWebSocket.instances.length;
    h.timers.advance(499);
    expect(FakeWebSocket.instances).toHaveLength(n);
    h.timers.advance(1);
    expect(FakeWebSocket.instances).toHaveLength(n + 1);

    // Now stay open for 10 s: the next failure starts from the beginning again.
    FakeWebSocket.last.serverOpens();
    h.timers.advance(10_000);
    FakeWebSocket.last.serverCloses();
    n = FakeWebSocket.instances.length;
    h.timers.advance(249);
    expect(FakeWebSocket.instances).toHaveLength(n);
    h.timers.advance(1);
    expect(FakeWebSocket.instances).toHaveLength(n + 1);
  });

  it('resets the server clock on every (re)connect', () => {
    const h = setup();
    const ws = connected(h);
    ws.serverSends(pong(1_000_000 - 50));
    expect(h.conn.clock.offsetMs).toBe(50);
    ws.serverCloses();
    h.timers.advance(1_000);
    FakeWebSocket.last.serverOpens();
    expect(h.conn.clock.offsetMs).toBeNull();
  });

  it('ignores events from a socket it has already abandoned', () => {
    const h = setup();
    const first = connected(h);
    first.serverCloses();
    h.timers.advance(1_000);
    const second = FakeWebSocket.last;
    second.serverOpens();
    first.serverSends(pong(1_000_000));
    first.serverCloses();
    expect(h.messages).toEqual([]);
    expect(h.conn.status).toBe('open');
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});

describe('heartbeat', () => {
  it('pings after heartbeatIdleMs without inbound traffic, and a pong keeps the link', () => {
    const h = setup();
    const ws = connected(h);
    h.timers.advance(TIMING.heartbeatIdleMs - 1);
    expect(ws.sentMessages).toEqual([RESUME]);
    h.timers.advance(1);
    const ping = ws.sentMessages.at(-1)!;
    expect(ping.type).toBe('ping');
    expect(ping.t).toBe(1_000_000 + TIMING.heartbeatIdleMs);

    ws.serverSends(pong(1_000_000 + TIMING.heartbeatIdleMs, ping.t as number));
    h.timers.advance(TIMING.pongTimeoutMs + 5_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(h.conn.status).toBe('open');
  });

  it('any inbound message postpones the ping', () => {
    const h = setup();
    const ws = connected(h);
    h.timers.advance(TIMING.heartbeatIdleMs - 1_000);
    ws.serverSends(pong(1_000_000));
    h.timers.advance(TIMING.heartbeatIdleMs - 1);
    expect(ws.sentMessages.filter((m) => m.type === 'ping')).toHaveLength(0);
    h.timers.advance(1);
    expect(ws.sentMessages.filter((m) => m.type === 'ping')).toHaveLength(1);
  });

  it('closes and reconnects when no pong arrives within pongTimeoutMs', () => {
    const h = setup({}, () => 0.5);
    const ws = connected(h);
    h.timers.advance(TIMING.heartbeatIdleMs); // ping goes out
    h.timers.advance(TIMING.pongTimeoutMs - 1);
    expect(ws.closeCalls).toEqual([]);
    h.timers.advance(1);
    expect(ws.closeCalls).toHaveLength(1);
    expect(h.conn.status).toBe('reconnecting');

    // The dead socket's late close event must not schedule a second reconnect.
    ws.serverCloses();
    h.timers.advance(250);
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.last.serverOpens();
    expect(FakeWebSocket.last.sentMessages).toEqual([RESUME]);
    h.timers.advance(10_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});

describe('heartbeat on a socket that is already dead', () => {
  it('reconnects when the idle ping cannot be sent (CLOSED, no close event)', () => {
    const h = setup({}, () => 0.5);
    const ws = connected(h);
    ws.readyState = 3; // WebKit: dead, and the close event never arrives
    h.timers.advance(TIMING.heartbeatIdleMs - 1);
    expect(FakeWebSocket.instances).toHaveLength(1);
    h.timers.advance(1);
    expect(ws.sentMessages.filter((m) => m.type === 'ping')).toHaveLength(0);
    expect(ws.closeCalls).toHaveLength(1);
    expect(h.conn.status).toBe('reconnecting');

    h.timers.advance(250); // full jitter at attempt 0 with random 0.5
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.last.serverOpens();
    expect(FakeWebSocket.last.sentMessages).toEqual([RESUME]);
    expect(h.conn.status).toBe('open');
  });

  it('reconnects when the ping send throws on a socket that claims to be open', () => {
    const h = setup({}, () => 0.5);
    const ws = connected(h);
    ws.send = () => {
      throw new Error('InvalidStateError');
    };
    h.timers.advance(TIMING.heartbeatIdleMs);
    expect(h.conn.status).toBe('reconnecting');
    h.timers.advance(250);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('does not reconnect after stop()', () => {
    const h = setup({}, () => 0.5);
    const ws = connected(h);
    ws.readyState = 3;
    h.conn.stop();
    h.timers.advance(TIMING.heartbeatIdleMs + TIMING.reconnectCapMs);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

describe('visibility and pageshow', () => {
  it('reconnects within 0-500 ms of becoming visible when not open', () => {
    const h = setup({}, () => 0.2); // backoff would be 100 ms; use a larger one to prove replacement
    connected(h);
    // Push the backoff up so the wake path is visibly the faster one.
    for (let i = 0; i < 6; i++) {
      FakeWebSocket.last.serverCloses();
      h.timers.advance(TIMING.reconnectCapMs);
    }
    FakeWebSocket.last.serverCloses();
    const before = FakeWebSocket.instances.length;

    h.doc.visibilityState = 'visible';
    h.doc.dispatch('visibilitychange');
    h.timers.advance(99);
    expect(FakeWebSocket.instances).toHaveLength(before);
    h.timers.advance(1); // random 0.2 * 500 = 100 ms
    expect(FakeWebSocket.instances).toHaveLength(before + 1);
  });

  it('does nothing while hidden, or when the socket is open or still connecting', () => {
    const h = setup();
    h.conn.start();
    h.doc.dispatch('visibilitychange'); // connecting
    h.timers.advance(1_000);
    expect(FakeWebSocket.instances).toHaveLength(1);

    FakeWebSocket.last.serverOpens();
    h.doc.dispatch('visibilitychange'); // open
    h.timers.advance(1_000);
    expect(FakeWebSocket.instances).toHaveLength(1);

    FakeWebSocket.last.serverCloses();
    h.doc.visibilityState = 'hidden';
    h.doc.dispatch('visibilitychange');
    h.timers.advance(TIMING.reconnectCapMs);
    expect(FakeWebSocket.instances).toHaveLength(2); // only the ordinary backoff fired
  });

  it('treats pageshow like becoming visible', () => {
    const h = setup({}, () => 0.4);
    connected(h);
    for (let i = 0; i < 3; i++) {
      FakeWebSocket.last.serverCloses();
      h.timers.advance(TIMING.reconnectCapMs);
    }
    FakeWebSocket.last.serverCloses(); // backoff is now 1,600 ms; a wake takes 200 ms
    const before = FakeWebSocket.instances.length;
    h.win.dispatch('pageshow');
    h.timers.advance(199);
    expect(FakeWebSocket.instances).toHaveLength(before);
    h.timers.advance(1);
    expect(FakeWebSocket.instances).toHaveLength(before + 1);
  });

  it('replaces a socket that is CLOSED without a close event (bfcache)', () => {
    const h = setup({}, () => 0);
    const ws = connected(h);
    ws.readyState = 3; // the browser killed it silently
    h.win.dispatch('pageshow');
    h.timers.advance(0);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(ws.closeCalls).toHaveLength(1);
  });

  it('removes its listeners on stop()', () => {
    const h = setup();
    h.conn.start();
    expect(h.doc.listenerCount('visibilitychange')).toBe(1);
    expect(h.win.listenerCount('pageshow')).toBe(1);
    h.conn.stop();
    expect(h.doc.listenerCount('visibilitychange')).toBe(0);
    expect(h.win.listenerCount('pageshow')).toBe(0);
  });
});

describe('planned reconnect', () => {
  it('reconnects proactively after plannedReconnectMs and resumes again', () => {
    const h = setup({}, () => 0.5);
    const ws = connected(h);
    // Keep the link alive with traffic so the heartbeat does not interfere.
    const step = 30_000;
    for (let t = 0; t + step < TIMING.plannedReconnectMs; t += step) {
      h.timers.advance(step);
      ws.serverSends(pong(1_000_000 + h.timers.now));
    }
    expect(ws.closeCalls).toEqual([]);
    h.timers.advance(TIMING.plannedReconnectMs - h.timers.now);
    expect(ws.closeCalls).toHaveLength(1);
    expect(h.conn.status).toBe('reconnecting');
    h.timers.advance(250);
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.last.serverOpens();
    expect(FakeWebSocket.last.sentMessages).toEqual([RESUME]);
  });
});

describe('planned reconnect held back by canReconnectNow', () => {
  /** Traffic every 30 s, so only the planned reconnect can end the link. */
  function keepAliveUntil(h: Harness, ws: FakeWebSocket, at: number): void {
    while (h.timers.now + 30_000 < at) {
      h.timers.advance(30_000);
      ws.serverSends(pong(1_000_000 + h.timers.now));
    }
    h.timers.advance(at - h.timers.now);
  }

  it('waits while it answers false, then reconnects as soon as it answers true', () => {
    let free = false;
    const canReconnectNow = vi.fn(() => free);
    const h = setup({ canReconnectNow }, () => 0.5);
    const ws = connected(h);
    keepAliveUntil(h, ws, TIMING.plannedReconnectMs);
    expect(canReconnectNow).toHaveBeenCalledTimes(1);
    expect(ws.closeCalls).toEqual([]);
    expect(h.conn.status).toBe('open');

    ws.serverSends(pong(1_000_000 + h.timers.now));
    h.timers.advance(4_999);
    expect(canReconnectNow).toHaveBeenCalledTimes(1);
    free = true;
    h.timers.advance(1);
    expect(canReconnectNow).toHaveBeenCalledTimes(2);
    expect(ws.closeCalls).toHaveLength(1);
    expect(h.conn.status).toBe('reconnecting');
    h.timers.advance(250);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('gives up waiting after five minutes, well inside the 2 h cutoff', () => {
    const h = setup({ canReconnectNow: () => false }, () => 0.5);
    const ws = connected(h);
    const limit = TIMING.plannedReconnectMs + 60 * 5_000;
    keepAliveUntil(h, ws, limit - 1_000);
    expect(ws.closeCalls).toEqual([]);
    keepAliveUntil(h, ws, limit);
    expect(ws.closeCalls).toHaveLength(1);
    expect(limit).toBeLessThan(2 * 60 * 60_000);
  });

  it('goes ahead when the callback throws, and starts the wait afresh on the next socket', () => {
    let ask = 0;
    const h = setup(
      {
        canReconnectNow: () => {
          ask += 1;
          if (ask === 1) throw new Error('boom');
          return false;
        },
      },
      () => 0.5,
    );
    const ws = connected(h);
    keepAliveUntil(h, ws, TIMING.plannedReconnectMs);
    expect(ws.closeCalls).toHaveLength(1);
    h.timers.advance(250);
    FakeWebSocket.last.serverOpens();
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});

describe('frame validation', () => {
  it('drops invalid frames with a warning and keeps going', () => {
    const h = setup();
    const ws = connected(h);
    ws.serverSends('not json at all');
    ws.serverSends('{"type":"pong"}'); // valid JSON, missing fields
    ws.serverSends({ type: 'mystery', ts: 1 });
    ws.serverSends('[1,2,3]');
    ws.serverSends({ type: 'kicked', ts: 'yesterday' });
    expect(h.messages).toEqual([]);
    expect(console.warn).toHaveBeenCalledTimes(5);
    expect(h.conn.clock.offsetMs).toBeNull();

    ws.serverSends(pong(1_000_000 - 5));
    expect(h.messages).toHaveLength(1);
    expect(h.conn.status).toBe('open');
  });

  it('still counts an invalid frame as proof of life for the heartbeat', () => {
    const h = setup();
    const ws = connected(h);
    h.timers.advance(TIMING.heartbeatIdleMs - 1);
    ws.serverSends('garbage');
    h.timers.advance(TIMING.heartbeatIdleMs - 1);
    expect(ws.sentMessages.filter((m) => m.type === 'ping')).toHaveLength(0);
  });

  it('drops binary frames', () => {
    const h = setup();
    const ws = connected(h);
    (ws.onmessage as unknown as (ev: unknown) => void)({ data: new ArrayBuffer(8) });
    expect(h.messages).toEqual([]);
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('stop()', () => {
  it('closes the socket with 1000, reports closed and never reconnects', () => {
    const h = setup();
    const ws = connected(h);
    h.conn.stop();
    expect(ws.closeCalls).toEqual([1000]);
    expect(h.conn.status).toBe('closed');
    ws.serverCloses(); // the late close event
    h.timers.advance(TIMING.plannedReconnectMs * 2);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(h.timers.pendingCount).toBe(0);
  });

  it('cancels a pending reconnect', () => {
    const h = setup();
    connected(h);
    FakeWebSocket.last.serverCloses();
    expect(h.timers.pendingCount).toBeGreaterThan(0);
    h.conn.stop();
    h.timers.advance(TIMING.reconnectCapMs * 2);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('is idempotent, and start() after stop() does nothing', () => {
    const h = setup();
    h.conn.stop();
    h.conn.stop();
    h.conn.start();
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(h.statuses).toEqual(['closed']);
  });

  it('may be called from a status listener without leaving timers behind', () => {
    const statuses: ConnectionStatus[] = [];
    let conn: Connection | undefined;
    const h = setup({
      onStatus: (s) => {
        statuses.push(s);
        if (s === 'reconnecting') conn?.stop();
      },
    });
    conn = h.conn;
    conn.start();
    FakeWebSocket.last.serverCloses();
    h.timers.advance(TIMING.reconnectCapMs);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(statuses).toEqual(['connecting', 'reconnecting', 'closed']);
  });
});

describe('server-ended messages', () => {
  const ended: Array<[string, ServerMessage]> = [
    ['kicked message', { type: 'kicked', ts: 1_000_000 }],
    ['error kicked', { type: 'error', ts: 1_000_000, code: 'kicked', message: 'removed' }],
    [
      'error session-ended',
      { type: 'error', ts: 1_000_000, code: 'session-ended', message: 'over' },
    ],
    [
      // A stale bundle would send the same refused hello on every attempt.
      'error protocol-version',
      { type: 'error', ts: 1_000_000, code: 'protocol-version', message: 'v2 required' },
    ],
  ];

  for (const [name, msg] of ended) {
    it(`delivers a ${name}, then stops for good`, () => {
      const h = setup();
      const ws = connected(h);
      ws.serverSends(msg);
      expect(h.messages).toEqual([msg]);
      expect(h.conn.status).toBe('closed');
      ws.serverCloses();
      h.timers.advance(TIMING.plannedReconnectMs);
      expect(FakeWebSocket.instances).toHaveLength(1);
    });
  }

  it('keeps reconnecting after ordinary errors', () => {
    const h = setup();
    const ws = connected(h);
    ws.serverSends({ type: 'error', ts: 1_000_000, code: 'rate-limited', message: 'slow down' });
    expect(h.messages).toHaveLength(1);
    expect(h.conn.status).toBe('open');
    ws.serverCloses();
    h.timers.advance(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
