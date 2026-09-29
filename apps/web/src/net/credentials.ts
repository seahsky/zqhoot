import { Id } from '@zqhoot/protocol';

/** Returned by `join`; what `resume` needs (ADR-0008). */
export interface PlayerCredentials {
  sessionId: string;
  playerId: string;
  token: string;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length: number;
  key(index: number): string | null;
}

export interface CredentialStorages {
  /** Primary, per tab. */
  session: StorageLike | null;
  /** Mirror keyed by session id, because iOS can discard a backgrounded tab and its sessionStorage. */
  local: StorageLike | null;
}

export const SESSION_KEY = 'zqhoot:session';
export const MIRROR_PREFIX = 'zqhoot:session:';
/** Mirrors of sessions that were never left cleanly are pruned after this long. */
export const MIRROR_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface Stored extends PlayerCredentials {
  savedAt: number;
}

/** Reading `window.sessionStorage` itself throws when storage is blocked. */
export function browserStorages(): CredentialStorages {
  const pick = (name: 'sessionStorage' | 'localStorage'): StorageLike | null => {
    try {
      return typeof window === 'undefined' ? null : window[name];
    } catch {
      return null;
    }
  };
  return { session: pick('sessionStorage'), local: pick('localStorage') };
}

function guard<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function parseStored(raw: string | null): Stored | null {
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return null;
    const { sessionId, playerId, token, savedAt } = v as Record<string, unknown>;
    if (
      typeof sessionId !== 'string' ||
      typeof playerId !== 'string' ||
      typeof token !== 'string' ||
      !Id.safeParse(sessionId).success ||
      !Id.safeParse(playerId).success ||
      token.length < 20 ||
      token.length > 128
    ) {
      return null;
    }
    return { sessionId, playerId, token, savedAt: typeof savedAt === 'number' ? savedAt : 0 };
  } catch {
    return null;
  }
}

function strip({ sessionId, playerId, token }: Stored): PlayerCredentials {
  return { sessionId, playerId, token };
}

export function saveCredentials(
  creds: PlayerCredentials,
  storages: CredentialStorages = browserStorages(),
  now: number = Date.now(),
): void {
  const raw = JSON.stringify({ ...creds, savedAt: now } satisfies Stored);
  guard(() => storages.session?.setItem(SESSION_KEY, raw), undefined);
  guard(() => storages.local?.setItem(MIRROR_PREFIX + creds.sessionId, raw), undefined);
  pruneMirrors(storages.local, now);
}

/**
 * Prefers this tab's sessionStorage, then the localStorage mirror when the URL hints at a
 * session (`/play?s={sessionId}`). A hint that disagrees with sessionStorage wins: the URL
 * says which game this page is for, and resuming a different one would be wrong.
 */
export function loadCredentials(
  hintSessionId: string | null = null,
  storages: CredentialStorages = browserStorages(),
): PlayerCredentials | null {
  const fromSession = parseStored(
    guard(() => storages.session?.getItem(SESSION_KEY) ?? null, null),
  );
  if (fromSession && (!hintSessionId || fromSession.sessionId === hintSessionId)) {
    return strip(fromSession);
  }
  if (!hintSessionId) return null;

  const fromMirror = parseStored(
    guard(() => storages.local?.getItem(MIRROR_PREFIX + hintSessionId) ?? null, null),
  );
  if (!fromMirror || fromMirror.sessionId !== hintSessionId) return null;
  // Put it back so a reload of this tab does not depend on the mirror again.
  guard(() => storages.session?.setItem(SESSION_KEY, JSON.stringify(fromMirror)), undefined);
  return strip(fromMirror);
}

/**
 * Last resort for a browser that blocks both stores: `/join` keeps the credentials here
 * while it navigates to `/play`, so the player is not stranded after a successful join.
 * A reload loses them, which nothing can prevent without storage.
 */
let inMemory: PlayerCredentials | null = null;

export function holdInMemory(creds: PlayerCredentials): void {
  inMemory = creds;
}

/** `loadCredentials`, then whatever `holdInMemory` kept for the hinted (or any) session. */
export function loadCredentialsOrHeld(
  hintSessionId: string | null = null,
  storages: CredentialStorages = browserStorages(),
): PlayerCredentials | null {
  const stored = loadCredentials(hintSessionId, storages);
  if (stored) return stored;
  return inMemory && (!hintSessionId || inMemory.sessionId === hintSessionId) ? inMemory : null;
}

/** Both copies go on `ended`, `kicked` or `leave`. Without an id, clears whichever session this tab holds. */
export function clearCredentials(
  sessionId: string | null = null,
  storages: CredentialStorages = browserStorages(),
): void {
  if (inMemory && (!sessionId || inMemory.sessionId === sessionId)) inMemory = null;
  const held = parseStored(guard(() => storages.session?.getItem(SESSION_KEY) ?? null, null));
  const id = sessionId ?? held?.sessionId ?? null;
  if (!held || !sessionId || held.sessionId === sessionId) {
    guard(() => storages.session?.removeItem(SESSION_KEY), undefined);
  }
  if (id) guard(() => storages.local?.removeItem(MIRROR_PREFIX + id), undefined);
}

function pruneMirrors(local: StorageLike | null, now: number): void {
  if (!local) return;
  guard(() => {
    const stale: string[] = [];
    for (let i = 0; i < local.length; i++) {
      const key = local.key(i);
      if (!key?.startsWith(MIRROR_PREFIX)) continue;
      const stored = parseStored(local.getItem(key));
      if (!stored || now - stored.savedAt > MIRROR_MAX_AGE_MS) stale.push(key);
    }
    for (const key of stale) local.removeItem(key);
  }, undefined);
}
