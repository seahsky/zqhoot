import { ServerMessage, TIMING } from '@zqhoot/protocol';
import type { ClientMessage } from '@zqhoot/protocol';
import { fullJitterDelay } from './backoff.ts';
import { ServerClock } from './clock.ts';

export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

/**
 * Looser than `typeof setTimeout` on purpose: Node's typings add `__promisify__` to
 * `setTimeout`, which no fake timer can reasonably provide. `setTimeout` itself is assignable.
 */
export type SetTimer = (handler: () => void, ms: number) => unknown;
export type ClearTimer = (handle: any) => void;

export interface ConnectionOptions {
  url: string;
  /** Called on every (re)connect before anything else is sent; return the join/resume/host.hello message or null. */
  hello: () => ClientMessage | null;
  onMessage: (msg: ServerMessage) => void;
  onStatus?: (s: ConnectionStatus) => void;
  /**
   * Asked when the planned reconnect comes due. Return false to hold it back, e.g. while a
   * question is open (ADR-0008: reconnect "between questions"). It is asked again every
   * few seconds, and the reconnect goes ahead regardless after about five minutes, so the
   * 2 h API Gateway cutoff is still beaten. Omitted means "always".
   */
  canReconnectNow?: () => boolean;
  WebSocketImpl?: typeof WebSocket;
  /** Local wall clock. */
  now?: () => number;
  random?: () => number;
  setTimer?: SetTimer;
  clearTimer?: ClearTimer;
  /** Pass null to opt out of visibility handling; omitted means the global `document`. */
  document?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'> | null;
  /** Pass null to opt out of `pageshow` handling; omitted means the global `window`. */
  window?: Pick<Window, 'addEventListener' | 'removeEventListener'> | null;
}

const WS_CONNECTING = 0;
const WS_OPEN = 1;
/** An open period this long means the link is healthy, so the next failure starts backoff afresh. */
const STABLE_OPEN_MS = 10_000;
/** Phones waking together must not stampede API Gateway's connection burst limit (ADR-0008). */
const WAKE_JITTER_MS = 500;
/** How often a postponed planned reconnect asks `canReconnectNow` again. */
const PLANNED_RETRY_MS = 5_000;
/** 60 x 5 s: plannedReconnectMs (110 min) plus this stays clear of the 2 h cutoff. */
const PLANNED_MAX_DEFERRALS = 60;

type TimerName = 'reconnect' | 'idle' | 'pong' | 'planned' | 'stable';

/**
 * After one of these the server closes the socket and retrying cannot help: the player is
 * gone, the game is over, or this page speaks a protocol version the server refuses (the
 * same `hello` would be refused every time; only a reload fixes it).
 */
function endsTheGame(msg: ServerMessage): boolean {
  return (
    msg.type === 'kicked' ||
    (msg.type === 'error' &&
      (msg.code === 'kicked' || msg.code === 'session-ended' || msg.code === 'protocol-version'))
  );
}

/**
 * A WebSocket that survives phones: full-jitter backoff, reconnect on wake, an idle
 * ping with a pong deadline, and a proactive reconnect before API Gateway's 2 h cutoff
 * (ADR-0008). Every frame is validated with the protocol schema; invalid frames are
 * dropped. Server timestamps feed `clock` (ADR-0005).
 *
 * Status: `connecting` until the first open; afterwards, and after any failure,
 * `reconnecting`; `closed` once `stop()` is called or the server ends the game.
 */
export class Connection {
  readonly clock = new ServerClock();

  private ws: WebSocket | null = null;
  private state: ConnectionStatus = 'idle';
  private attempt = 0;
  private started = false;
  private stopped = false;
  private connectCount = 0;
  private plannedDeferrals = 0;
  private readonly timers = new Map<TimerName, unknown>();

  private readonly WebSocketImpl: typeof WebSocket;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimer: SetTimer;
  private readonly clearTimer: ClearTimer;
  private readonly doc: ConnectionOptions['document'];
  private readonly win: ConnectionOptions['window'];

  constructor(private readonly opts: ConnectionOptions) {
    this.WebSocketImpl = opts.WebSocketImpl ?? globalThis.WebSocket;
    this.now = opts.now ?? (() => Date.now());
    this.random = opts.random ?? (() => Math.random());
    // Wrapped, not passed by reference: calling `window.setTimeout` with a foreign
    // `this` throws "Illegal invocation" in browsers.
    this.setTimer = opts.setTimer ?? ((handler, ms) => setTimeout(handler, ms));
    this.clearTimer = opts.clearTimer ?? ((handle) => clearTimeout(handle));
    this.doc =
      opts.document === undefined
        ? typeof document === 'undefined'
          ? null
          : document
        : opts.document;
    this.win =
      opts.window === undefined ? (typeof window === 'undefined' ? null : window) : opts.window;
  }

  get status(): ConnectionStatus {
    return this.state;
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.doc?.addEventListener('visibilitychange', this.onVisibilityChange);
    this.win?.addEventListener('pageshow', this.onWake);
    this.connect();
  }

  /** Returns false if not open (caller decides whether to queue). */
  send(msg: ClientMessage): boolean {
    const ws = this.ws;
    if (this.state !== 'open' || !ws || ws.readyState !== WS_OPEN) return false;
    return this.rawSend(ws, msg);
  }

  /** Permanent stop (ended/kicked/leave): no reconnect. Idempotent. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.cancelAll();
    this.doc?.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.win?.removeEventListener('pageshow', this.onWake);
    const ws = this.ws;
    if (ws) this.dropSocket(ws, 1000);
    this.setStatus('closed');
  }

  private connect(): void {
    if (this.stopped) return;
    this.cancel('reconnect');
    this.setStatus(this.connectCount === 0 ? 'connecting' : 'reconnecting');
    this.connectCount += 1;
    if (this.stopped) return;

    let ws: WebSocket;
    try {
      ws = new this.WebSocketImpl(this.opts.url);
    } catch (err) {
      console.warn('zqhoot: could not create WebSocket', err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    // Handlers check identity so a socket we already abandoned cannot act on the new state.
    ws.onopen = () => {
      if (this.ws === ws) this.handleOpen(ws);
    };
    ws.onmessage = (ev) => {
      if (this.ws === ws) this.handleFrame(ev.data);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.cancel('idle');
      this.cancel('pong');
      this.cancel('planned');
      this.cancel('stable');
      this.scheduleReconnect();
    };
  }

  private handleOpen(ws: WebSocket): void {
    this.clock.reset();
    let hello: ClientMessage | null = null;
    try {
      hello = this.opts.hello();
    } catch (err) {
      console.warn('zqhoot: hello() threw', err);
    }
    if (hello) this.rawSend(ws, hello);
    this.setStatus('open');
    // A status listener may have called stop().
    if (this.stopped) return;
    this.plannedDeferrals = 0;
    this.after('stable', STABLE_OPEN_MS, () => {
      this.attempt = 0;
    });
    this.after('planned', TIMING.plannedReconnectMs, this.plannedReconnect);
    this.armIdle();
  }

  private handleFrame(data: unknown): void {
    // Anything inbound proves the peer is alive, even a frame we then reject.
    this.cancel('pong');
    this.armIdle();

    if (typeof data !== 'string') {
      console.warn('zqhoot: dropped a non-text frame');
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      console.warn('zqhoot: dropped a frame that is not JSON');
      return;
    }
    const parsed = ServerMessage.safeParse(json);
    if (!parsed.success) {
      console.warn('zqhoot: dropped an invalid server message', parsed.error.message);
      return;
    }
    const msg = parsed.data;
    this.clock.observe(msg.ts, this.now());
    try {
      this.opts.onMessage(msg);
    } finally {
      if (endsTheGame(msg)) this.stop();
    }
  }

  private armIdle(): void {
    this.after('idle', TIMING.heartbeatIdleMs, () => {
      if (!this.send({ type: 'ping', t: this.now() })) {
        // We think the socket is open but it cannot carry a ping: CLOSING or CLOSED with the
        // close event still missing (WebKit). The link is dead; do not wait for a wake event.
        this.abandonAndReconnect();
        return;
      }
      this.after('pong', TIMING.pongTimeoutMs, this.abandonAndReconnect);
    });
  }

  /** Heartbeat lost: browsers can take minutes to notice a dead socket on their own. */
  private abandonAndReconnect = (): void => {
    const ws = this.ws;
    if (!ws || this.stopped) return;
    this.dropSocket(ws);
    this.scheduleReconnect();
  };

  private plannedReconnect = (): void => {
    const ws = this.ws;
    if (!ws || this.stopped) return;
    if (this.plannedDeferrals < PLANNED_MAX_DEFERRALS && !this.mayReconnectNow()) {
      this.plannedDeferrals += 1;
      this.after('planned', PLANNED_RETRY_MS, this.plannedReconnect);
      return;
    }
    this.plannedDeferrals = 0;
    this.dropSocket(ws);
    this.attempt = 0;
    this.scheduleReconnect();
  };

  private mayReconnectNow(): boolean {
    try {
      return this.opts.canReconnectNow?.() ?? true;
    } catch (err) {
      console.warn('zqhoot: canReconnectNow() threw', err);
      return true;
    }
  }

  private onVisibilityChange = (): void => {
    if (this.doc?.visibilityState === 'visible') this.onWake();
  };

  private onWake = (): void => {
    if (this.stopped || !this.started) return;
    const ws = this.ws;
    if (ws && (ws.readyState === WS_OPEN || ws.readyState === WS_CONNECTING)) return;
    // WebKit can leave a socket CLOSED without a close event reaching us after the
    // back/forward cache, so a stale reference counts as "not open" here.
    if (ws) this.dropSocket(ws);
    this.setStatus('reconnecting');
    if (this.stopped) return;
    this.after('reconnect', Math.floor(this.random() * WAKE_JITTER_MS), () => this.connect());
  };

  private scheduleReconnect(): void {
    this.setStatus('reconnecting');
    if (this.stopped) return;
    const delay = fullJitterDelay(
      this.attempt,
      { baseMs: TIMING.reconnectBaseMs, capMs: TIMING.reconnectCapMs },
      this.random,
    );
    this.attempt += 1;
    this.after('reconnect', delay, () => this.connect());
  }

  /** Detach first: a closing socket must not be able to trigger another reconnect. */
  private dropSocket(ws: WebSocket, code?: number): void {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      ws.close(code);
    } catch {
      // Already closed.
    }
    if (this.ws === ws) this.ws = null;
    this.cancel('idle');
    this.cancel('pong');
    this.cancel('planned');
    this.cancel('stable');
  }

  private rawSend(ws: WebSocket, msg: ClientMessage): boolean {
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch (err) {
      console.warn('zqhoot: send failed', err);
      return false;
    }
  }

  private setStatus(next: ConnectionStatus): void {
    if (this.state === next) return;
    this.state = next;
    this.opts.onStatus?.(next);
  }

  private after(name: TimerName, ms: number, fn: () => void): void {
    this.cancel(name);
    this.timers.set(
      name,
      this.setTimer(() => {
        this.timers.delete(name);
        fn();
      }, ms),
    );
  }

  private cancel(name: TimerName): void {
    if (!this.timers.has(name)) return;
    this.clearTimer(this.timers.get(name));
    this.timers.delete(name);
  }

  private cancelAll(): void {
    for (const name of [...this.timers.keys()]) this.cancel(name);
  }
}
