import type { Store } from '@zqhoot/store';
import type { Clock, Logger, Scheduler } from '@zqhoot/service';

/** `setTimeout` cannot wait longer than this; a later deadline re-arms itself. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export type TimerHandler = (sessionId: string, questionIndex: number) => Promise<void>;

/**
 * The VM's question timers (ADR-0015): `setTimeout` that calls `GameService.onTimer`. Timers are
 * per session and question, and a stale one is harmless because the service ignores a close for a
 * question that is no longer open.
 */
export class TimerScheduler implements Scheduler {
  readonly #onTimer: TimerHandler;
  readonly #clock: Clock;
  readonly #log: Logger;
  readonly #timers = new Map<string, Map<number, NodeJS.Timeout>>();
  #disposed = false;

  constructor(onTimer: TimerHandler, clock: Clock, log: Logger) {
    this.#onTimer = onTimer;
    this.#clock = clock;
    this.#log = log;
  }

  scheduleClose(sessionId: string, questionIndex: number, at: number): void {
    // Frames still queued on a socket run after shutdown began; their timers must not outlive it.
    if (this.#disposed) return;
    const perSession = this.#timers.get(sessionId) ?? new Map<number, NodeJS.Timeout>();
    this.#timers.set(sessionId, perSession);
    const previous = perSession.get(questionIndex);
    if (previous !== undefined) clearTimeout(previous);
    this.#arm(sessionId, questionIndex, at, perSession);
  }

  cancel(sessionId: string): void {
    for (const timer of this.#timers.get(sessionId)?.values() ?? []) clearTimeout(timer);
    this.#timers.delete(sessionId);
  }

  /** Cancels every timer; afterwards `scheduleClose` does nothing. */
  dispose(): void {
    this.#disposed = true;
    for (const sessionId of [...this.#timers.keys()]) this.cancel(sessionId);
  }

  get pending(): number {
    let count = 0;
    for (const perSession of this.#timers.values()) count += perSession.size;
    return count;
  }

  #arm(
    sessionId: string,
    questionIndex: number,
    at: number,
    perSession: Map<number, NodeJS.Timeout>,
  ): void {
    const delay = Math.min(Math.max(0, at - this.#clock.now()), MAX_TIMEOUT_MS);
    const timer = setTimeout(() => {
      if (this.#clock.now() < at) {
        this.#arm(sessionId, questionIndex, at, perSession);
        return;
      }
      perSession.delete(questionIndex);
      if (perSession.size === 0 && this.#timers.get(sessionId) === perSession) {
        this.#timers.delete(sessionId);
      }
      this.#onTimer(sessionId, questionIndex).catch((err: unknown) => {
        this.#log.error(
          { sessionId, questionIndex, err: err instanceof Error ? err.message : String(err) },
          'question timer handler failed',
        );
      });
    }, delay);
    perSession.set(questionIndex, timer);
  }
}

/**
 * After a restart, sessions of `hostId` that were in `question` get their timer back. A deadline
 * that has already passed fires at once. Connection records left by the previous process are
 * deleted too: no socket of that process exists any more, and hosts must not see those players as
 * connected.
 */
export async function recoverSessions(opts: {
  store: Store;
  scheduler: Scheduler;
  hostId: string;
  answerGraceMs: number;
  log: Logger;
}): Promise<{ sessions: number; timers: number; connectionsCleared: number }> {
  const { store, scheduler, hostId, answerGraceMs, log } = opts;
  const summaries = await store.listSessionsByHost(hostId, Number.POSITIVE_INFINITY);
  let timers = 0;
  let connectionsCleared = 0;
  for (const summary of summaries) {
    for (const conn of await store.listConnections(summary.sessionId)) {
      await store.deleteConnection(conn.connectionId);
      connectionsCleared++;
    }
    if (summary.phase !== 'question') continue;
    const meta = await store.getSession(summary.sessionId);
    if (meta === null || meta.phase !== 'question' || meta.deadline === null) continue;
    scheduler.scheduleClose(meta.sessionId, meta.questionIndex, meta.deadline + answerGraceMs);
    timers++;
  }
  log.info({ sessions: summaries.length, timers, connectionsCleared }, 'recovered sessions');
  return { sessions: summaries.length, timers, connectionsCleared };
}
