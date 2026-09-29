import { TIMING } from '@zqhoot/protocol';
import { fullJitterDelay } from '../net/backoff.ts';

/**
 * What a host page does when the server refuses its sign-in token (`unauthorized`), or when it
 * has no usable token to say hello with. An expired ID token is the ordinary cause and one
 * refresh mends it; a token the server keeps refusing (a misconfigured audience, a device clock
 * that is far off) would otherwise make a loop of token requests and new sockets, each turn
 * costing the user pool's quota and a connection. So every refresh waits out the reconnect
 * backoff, there is one at a time, and after a few refusals in a row the page stops and shows
 * the sign-in screen. A `forbidden` `host.hello` never comes here: it is not the token's fault.
 */

/** Refreshes spent on refusals in a row, before the page gives up and signs the host out. */
export const MAX_AUTH_RETRIES = 3;

/**
 * How long to wait before the refresh that follows the `refusals`-th refusal in a row (1 for
 * the first), or null when the page should stop instead. The wait is the reconnect backoff.
 */
export function authRetryDelayMs(
  refusals: number,
  random: () => number = Math.random,
): number | null {
  if (refusals > MAX_AUTH_RETRIES) return null;
  return fullJitterDelay(
    Math.max(0, refusals - 1),
    { baseMs: TIMING.reconnectBaseMs, capMs: TIMING.reconnectCapMs },
    random,
  );
}

export interface AuthRetryOptions {
  /** Trades the refresh token for a new sign-in token; false when the host has to sign in again. */
  refresh: () => Promise<boolean>;
  /** The token was refreshed: open a new connection with it. */
  onRefreshed: () => void;
  /** Too many refusals in a row: stop trying. */
  onGiveUp: () => void;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * The refresh-and-reconnect policy for one host page. `refused()` is called whenever the token
 * is refused or missing, `accepted()` when the server answers a hello with a welcome.
 */
export class AuthRetry {
  private refusals = 0;
  private timer: unknown = null;
  private inFlight = false;
  private disposed = false;

  constructor(private readonly o: AuthRetryOptions) {}

  /** A refusal or a missing token. A refresh already waiting or running covers this one too. */
  refused(): void {
    if (this.disposed || this.timer !== null || this.inFlight) return;
    this.refusals += 1;
    const delay = authRetryDelayMs(this.refusals, this.o.random);
    if (delay === null) {
      this.o.onGiveUp();
      return;
    }
    const set = this.o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.timer = set(() => {
      this.timer = null;
      void this.run();
    }, delay);
  }

  /** The server accepted the token, so the next refusal is a new problem. */
  accepted(): void {
    this.refusals = 0;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) {
      (this.o.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.timer);
      this.timer = null;
    }
  }

  private async run(): Promise<void> {
    this.inFlight = true;
    let ok: boolean;
    try {
      ok = await this.o.refresh();
    } catch {
      // `refresh` reports a failure by returning false; a throw is not something to retry.
      ok = false;
      if (!this.disposed) this.o.onGiveUp();
    } finally {
      this.inFlight = false;
    }
    if (ok && !this.disposed) this.o.onRefreshed();
  }
}
