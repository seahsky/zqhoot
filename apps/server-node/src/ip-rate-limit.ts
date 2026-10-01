import type { Clock } from '@zqhoot/service';
import { TokenBucket } from './token-bucket.ts';

/** ADR-0013, VM row of the rate-limit table: a token bucket per IP refilled at 20 requests per second. */
export const API_RATE_PER_SECOND = 20;
/**
 * The bucket size, which ADR-0013 leaves open. It equals the AWS stage burst, so a class of 400
 * phones behind one NAT can look up a PIN within seconds; only sustained traffic is held to 20/s.
 */
export const API_RATE_BURST = 400;

interface Entry {
  bucket: TokenBucket;
  lastSeen: number;
}

/** A `TokenBucket` per client address, forgotten once it would be full again. */
export class IpRateLimiter {
  readonly #perSecond: number;
  readonly #burst: number;
  readonly #clock: Clock;
  readonly #entries = new Map<string, Entry>();
  /** After this long without a request a bucket is full, so dropping it changes nothing. */
  readonly #refillMs: number;
  #nextSweep: number;

  constructor(perSecond: number, burst: number, clock: Clock) {
    this.#perSecond = perSecond;
    this.#burst = burst;
    this.#clock = clock;
    this.#refillMs = Math.ceil((burst / perSecond) * 1000);
    this.#nextSweep = clock.now() + this.#refillMs;
  }

  /** Spends one token of `ip`'s bucket. An unknown address (a socket already gone) is not limited. */
  allow(ip: string | undefined): boolean {
    if (ip === undefined) return true;
    const now = this.#clock.now();
    this.#sweep(now);
    let entry = this.#entries.get(ip);
    if (entry === undefined) {
      entry = { bucket: new TokenBucket(this.#perSecond, this.#burst, now), lastSeen: now };
      this.#entries.set(ip, entry);
    }
    entry.lastSeen = now;
    return entry.bucket.take(now);
  }

  /** Addresses currently remembered; for tests. */
  get size(): number {
    return this.#entries.size;
  }

  // Sweeping on use keeps the map bounded without a timer that would have to be stopped at shutdown.
  #sweep(now: number): void {
    if (now < this.#nextSweep) return;
    this.#nextSweep = now + this.#refillMs;
    for (const [ip, entry] of this.#entries) {
      if (now - entry.lastSeen >= this.#refillMs) this.#entries.delete(ip);
    }
  }
}
