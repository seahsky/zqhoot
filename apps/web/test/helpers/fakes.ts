/** Test doubles for the browser APIs Connection touches. Nothing here is used by src/. */

type Handler = ((ev: never) => void) | null;

export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static reset(): void {
    FakeWebSocket.instances = [];
  }
  static get last(): FakeWebSocket {
    const ws = FakeWebSocket.instances.at(-1);
    if (!ws) throw new Error('no WebSocket has been created');
    return ws;
  }

  readyState = 0;
  readonly sent: string[] = [];
  closeCalls: Array<number | undefined> = [];
  onopen: Handler = null;
  onmessage: Handler = null;
  onclose: Handler = null;
  onerror: Handler = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('InvalidStateError');
    this.sent.push(data);
  }

  /** Like a browser, close() is not instant: the close event comes later (or never, on a dead link). */
  close(code?: number): void {
    this.closeCalls.push(code);
    if (this.readyState < 2) this.readyState = 2;
  }

  get sentMessages(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }

  // --- driven by tests ---

  serverOpens(): void {
    this.readyState = 1;
    (this.onopen as ((ev: unknown) => void) | null)?.({});
  }

  serverSends(payload: unknown): void {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    (this.onmessage as ((ev: unknown) => void) | null)?.({ data });
  }

  /** The link dies or the server closes it. */
  serverCloses(): void {
    this.readyState = 3;
    (this.onclose as ((ev: unknown) => void) | null)?.({});
  }
}

export class FakeTimers {
  now = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  setTimer = (fn: () => void, ms: number): number => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + ms, fn });
    return id;
  };

  clearTimer = (id: number): void => {
    this.timers.delete(id);
  };

  /** Runs every timer that comes due, in order, including ones scheduled while advancing. */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let nextId: number | null = null;
      let nextAt = Infinity;
      for (const [id, t] of this.timers) {
        if (t.at <= target && t.at < nextAt) {
          nextId = id;
          nextAt = t.at;
        }
      }
      if (nextId === null) break;
      const timer = this.timers.get(nextId)!;
      this.timers.delete(nextId);
      this.now = Math.max(this.now, timer.at);
      timer.fn();
    }
    this.now = target;
  }

  get pendingCount(): number {
    return this.timers.size;
  }
}

export class FakeDocument {
  visibilityState: 'visible' | 'hidden' = 'visible';
  private readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, fn: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }

  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  dispatch(type: string): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
  }
}
