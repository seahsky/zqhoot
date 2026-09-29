/**
 * Estimates the offset between the server clock and this device's wall clock
 * from the `ts` stamped on every server message (ADR-0005).
 *
 * `localReceive - ts` is the true offset plus that message's downlink latency, so the
 * minimum over many messages converges on the true offset from above. The client
 * therefore never believes the server is ahead of where it really is: it may open
 * options a few tens of ms late, never early.
 */
export class ServerClock {
  private offset: number | null = null;

  observe(serverTs: number, localReceive: number): void {
    if (!Number.isFinite(serverTs) || !Number.isFinite(localReceive)) return;
    const sample = localReceive - serverTs;
    if (this.offset === null || sample < this.offset) this.offset = sample;
  }

  /** `localReceive - serverTs`, minimised; null until the first observation. */
  get offsetMs(): number | null {
    return this.offset;
  }

  /** Local wall time at which the given server time occurs. */
  toLocal(serverTime: number): number {
    return serverTime + (this.offset ?? 0);
  }

  /** Estimated server time at the given local wall time. */
  serverNow(localNow: number): number {
    return localNow - (this.offset ?? 0);
  }

  /** Forget everything; called on every (re)connect because the path and latency change. */
  reset(): void {
    this.offset = null;
  }
}
