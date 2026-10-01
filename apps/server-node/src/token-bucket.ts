/** Token bucket: `burst` tokens at most, refilled at `perSecond`. */
export class TokenBucket {
  readonly #perSecond: number;
  readonly #burst: number;
  #tokens: number;
  #updatedAt: number;

  constructor(perSecond: number, burst: number, now: number) {
    this.#perSecond = perSecond;
    this.#burst = burst;
    this.#tokens = burst;
    this.#updatedAt = now;
  }

  take(now: number): boolean {
    const elapsedSeconds = Math.max(0, now - this.#updatedAt) / 1000;
    this.#tokens = Math.min(this.#burst, this.#tokens + elapsedSeconds * this.#perSecond);
    this.#updatedAt = now;
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }
}
