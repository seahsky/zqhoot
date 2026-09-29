/** The slice of the Screen Wake Lock API used here (HTTPS or localhost only, ADR-0008). */
interface SentinelLike {
  readonly released: boolean;
  release(): Promise<void>;
}

export interface WakeLockDeps {
  navigator?: { wakeLock?: { request(type: 'screen'): Promise<SentinelLike> } } | null;
  document?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'> | null;
}

export interface WakeLock {
  /** Start keeping the screen on; safe to call repeatedly. */
  acquire(): void;
  /** Stop, and stop re-requesting on visibility changes. */
  release(): void;
}

/**
 * Keeps the phone awake while a game is on screen. The browser drops the lock whenever
 * the page is hidden, so it is requested again on `visibilitychange`. Every failure
 * (unsupported, insecure context, low battery, permission policy) is silent: the game
 * works without it, only the screen may dim.
 */
export function createWakeLock(deps: WakeLockDeps = {}): WakeLock {
  const nav = deps.navigator === undefined ? globalThis.navigator : deps.navigator;
  const doc = deps.document === undefined ? globalThis.document : deps.document;
  let wanted = false;
  let sentinel: SentinelLike | null = null;
  let requesting = false;

  async function request(): Promise<void> {
    if (!wanted || requesting || (sentinel && !sentinel.released)) return;
    if (doc && doc.visibilityState !== 'visible') return;
    if (!nav?.wakeLock) return;
    requesting = true;
    try {
      const next = await nav.wakeLock.request('screen');
      if (wanted) sentinel = next;
      else await next.release().catch(() => undefined);
    } catch {
      sentinel = null;
    } finally {
      requesting = false;
    }
  }

  const onVisibility = (): void => {
    void request();
  };

  return {
    acquire() {
      if (wanted) return;
      wanted = true;
      doc?.addEventListener('visibilitychange', onVisibility);
      void request();
    },
    release() {
      if (!wanted) return;
      wanted = false;
      doc?.removeEventListener('visibilitychange', onVisibility);
      const held = sentinel;
      sentinel = null;
      void held?.release().catch(() => undefined);
    },
  };
}
