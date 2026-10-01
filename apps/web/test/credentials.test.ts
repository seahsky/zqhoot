import { describe, expect, it } from 'vitest';
import {
  MIRROR_MAX_AGE_MS,
  MIRROR_PREFIX,
  SESSION_KEY,
  clearCredentials,
  holdInMemory,
  loadCredentials,
  loadCredentialsOrHeld,
  saveCredentials,
} from '../src/net/credentials.ts';
import type { CredentialStorages, PlayerCredentials, StorageLike } from '../src/net/credentials.ts';

class MemoryStorage implements StorageLike {
  readonly data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }
}

/** Every access throws, like storage with site data blocked. */
const throwing: StorageLike = {
  get length(): number {
    throw new Error('SecurityError');
  },
  getItem() {
    throw new Error('SecurityError');
  },
  setItem() {
    throw new Error('QuotaExceededError');
  },
  removeItem() {
    throw new Error('SecurityError');
  },
  key() {
    throw new Error('SecurityError');
  },
};

const A: PlayerCredentials = {
  sessionId: 'session-aaaa-01',
  playerId: 'player-aaaa-01',
  token: 'a'.repeat(43),
};
const B: PlayerCredentials = {
  sessionId: 'session-bbbb-02',
  playerId: 'player-bbbb-02',
  token: 'b'.repeat(43),
};

function fresh(): CredentialStorages & { session: MemoryStorage; local: MemoryStorage } {
  return { session: new MemoryStorage(), local: new MemoryStorage() };
}

describe('credentials storage (ADR-0008)', () => {
  it('saves to sessionStorage under zqhoot:session and mirrors to localStorage by session id', () => {
    const s = fresh();
    saveCredentials(A, s, 1_000);
    expect(JSON.parse(s.session.getItem(SESSION_KEY)!)).toMatchObject(A);
    expect(JSON.parse(s.local.getItem(`${MIRROR_PREFIX}${A.sessionId}`)!)).toMatchObject(A);
    expect(SESSION_KEY).toBe('zqhoot:session');
    expect(MIRROR_PREFIX).toBe('zqhoot:session:');
  });

  it('loads from sessionStorage first', () => {
    const s = fresh();
    saveCredentials(A, s);
    expect(loadCredentials(null, s)).toEqual(A);
    expect(loadCredentials(A.sessionId, s)).toEqual(A);
  });

  it('falls back to the mirror only with a matching ?s= hint, and restores sessionStorage', () => {
    const s = fresh();
    saveCredentials(A, s);
    s.session.removeItem(SESSION_KEY); // iOS discarded the tab
    expect(loadCredentials(null, s)).toBeNull();
    expect(loadCredentials(B.sessionId, s)).toBeNull();
    expect(loadCredentials(A.sessionId, s)).toEqual(A);
    expect(s.session.getItem(SESSION_KEY)).not.toBeNull();
    expect(loadCredentials(null, s)).toEqual(A);
  });

  it('prefers the hint over a different session held in sessionStorage', () => {
    const s = fresh();
    saveCredentials(A, s);
    saveCredentials(B, s); // sessionStorage now holds B; the mirror still has A
    expect(loadCredentials(B.sessionId, s)).toEqual(B);
    expect(loadCredentials(A.sessionId, s)).toEqual(A);
  });

  it('clears both copies for the session', () => {
    const s = fresh();
    saveCredentials(A, s);
    clearCredentials(A.sessionId, s);
    expect(s.session.data.size).toBe(0);
    expect(s.local.data.size).toBe(0);
    expect(loadCredentials(A.sessionId, s)).toBeNull();
  });

  it('clears whichever session the tab holds when no id is given', () => {
    const s = fresh();
    saveCredentials(A, s);
    clearCredentials(null, s);
    expect(s.session.data.size).toBe(0);
    expect(s.local.data.size).toBe(0);
  });

  it("leaves another session's credentials alone", () => {
    const s = fresh();
    saveCredentials(A, s);
    saveCredentials(B, s);
    clearCredentials(A.sessionId, s); // sessionStorage holds B, not A
    expect(loadCredentials(null, s)).toEqual(B);
    expect(s.local.getItem(`${MIRROR_PREFIX}${A.sessionId}`)).toBeNull();
    expect(s.local.getItem(`${MIRROR_PREFIX}${B.sessionId}`)).not.toBeNull();
  });

  it('rejects malformed, tampered or wrong-shaped entries', () => {
    const s = fresh();
    for (const raw of [
      'not json',
      'null',
      '42',
      JSON.stringify({ ...A, token: 'short' }),
      JSON.stringify({ ...A, sessionId: 'has spaces!' }),
      JSON.stringify({ ...A, playerId: 7 }),
      JSON.stringify({ sessionId: A.sessionId }),
    ]) {
      s.session.setItem(SESSION_KEY, raw);
      expect(loadCredentials(null, s)).toBeNull();
    }
  });

  it('prunes stale mirrors of sessions that were never left, keeping fresh ones', () => {
    const s = fresh();
    saveCredentials(A, s, 0);
    saveCredentials(B, s, MIRROR_MAX_AGE_MS + 1);
    expect(s.local.getItem(`${MIRROR_PREFIX}${A.sessionId}`)).toBeNull();
    expect(s.local.getItem(`${MIRROR_PREFIX}${B.sessionId}`)).not.toBeNull();
  });

  it('does not touch unrelated localStorage keys', () => {
    const s = fresh();
    s.local.setItem('theme', 'dark');
    saveCredentials(A, s, 0);
    saveCredentials(B, s, MIRROR_MAX_AGE_MS + 1);
    expect(s.local.getItem('theme')).toBe('dark');
  });
});

describe('credentials when storage throws', () => {
  it('never throws from save, load or clear', () => {
    const s: CredentialStorages = { session: throwing, local: throwing };
    expect(() => saveCredentials(A, s)).not.toThrow();
    expect(loadCredentials(A.sessionId, s)).toBeNull();
    expect(() => clearCredentials(A.sessionId, s)).not.toThrow();
  });

  it('still works through localStorage when sessionStorage throws', () => {
    const local = new MemoryStorage();
    const s: CredentialStorages = { session: throwing, local };
    saveCredentials(A, s);
    expect(loadCredentials(A.sessionId, s)).toEqual(A);
    expect(loadCredentials(null, s)).toBeNull(); // no hint, no primary
  });

  it('still works through sessionStorage when localStorage throws', () => {
    const session = new MemoryStorage();
    const s: CredentialStorages = { session, local: throwing };
    saveCredentials(A, s);
    expect(loadCredentials(null, s)).toEqual(A);
    clearCredentials(A.sessionId, s);
    expect(session.data.size).toBe(0);
  });

  it('works with no storage at all', () => {
    const s: CredentialStorages = { session: null, local: null };
    expect(() => saveCredentials(A, s)).not.toThrow();
    expect(loadCredentials(A.sessionId, s)).toBeNull();
  });
});

describe('in-memory hand-off for browsers that block storage', () => {
  const blocked: CredentialStorages = { session: throwing, local: throwing };

  it('lets /play find what /join just received even when nothing can be stored', () => {
    saveCredentials(A, blocked);
    expect(loadCredentials(A.sessionId, blocked)).toBeNull();
    holdInMemory(A);
    expect(loadCredentialsOrHeld(A.sessionId, blocked)).toEqual(A);
    expect(loadCredentialsOrHeld(null, blocked)).toEqual(A);
    expect(loadCredentialsOrHeld(B.sessionId, blocked)).toBeNull();
    clearCredentials(A.sessionId, blocked);
    expect(loadCredentialsOrHeld(A.sessionId, blocked)).toBeNull();
  });

  it('prefers storage when it works', () => {
    const s = fresh();
    saveCredentials(B, s);
    holdInMemory(A);
    expect(loadCredentialsOrHeld(null, s)).toEqual(B);
    clearCredentials(null, s);
  });

  it('clearing another session leaves the held one alone', () => {
    holdInMemory(A);
    clearCredentials(B.sessionId, blocked);
    expect(loadCredentialsOrHeld(A.sessionId, blocked)).toEqual(A);
    clearCredentials(A.sessionId, blocked);
  });
});
