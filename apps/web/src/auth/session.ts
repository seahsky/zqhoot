import { LoginRequest, LoginResponse, Me } from '@zqhoot/protocol';
import type { RuntimeConfig } from '@zqhoot/protocol';
import { isInternalPath } from '../app/routing.ts';
import type { StorageLike } from '../net/credentials.ts';
import { ApiRequestError, createHttpClient } from '../net/http.ts';
import {
  authorizeUrl,
  logoutUrl,
  parseTokenResponse,
  refreshDelayMs,
  refreshRequest,
  tokenRequest,
} from './cognito.ts';
import type { CognitoAuth, Tokens } from './cognito.ts';
import { challengeS256, createState, createVerifier, parseCallback } from './pkce.ts';
import type { TokenRequest } from './pkce.ts';

/**
 * Host sign-in for both deployments (ADR-0009). `local` posts a username and password to
 * `/api/auth/login`; `cognito` runs authorization code + PKCE against the managed login and
 * uses the ID token as the bearer. Tokens live in memory; sessionStorage keeps what a reload
 * or a presenter tab opened with `window.open` needs to carry on (the local token, or the
 * Cognito refresh token), never an ID token.
 *
 * Framework-free: the React binding is `useHostAuth` in `useHostAuth.ts`.
 */

export const AUTH_KEY = 'zqhoot:host:auth';
export const PKCE_KEY = 'zqhoot:host:pkce';

export type AuthStatus = 'loading' | 'signed-out' | 'signed-in';

export interface AuthSnapshot {
  status: AuthStatus;
  displayName: string | null;
  /** A sign-in or sign-out request is in flight. */
  busy: boolean;
  /** Why the host is signed out, if it was not their own doing. */
  error: string | null;
}

export interface HostAuthOptions {
  auth: RuntimeConfig['auth'];
  apiBaseUrl: string;
  /** `window.location.origin`. */
  origin: string;
  /** `sessionStorage`, or null when the browser blocks it. */
  storage: StorageLike | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  getRandomValues?: Crypto['getRandomValues'];
  subtle?: Pick<SubtleCrypto, 'digest'>;
  /** Leaves the page (`location.assign`). */
  redirect: (url: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface StoredAuth {
  mode: 'local' | 'cognito';
  token?: string;
  expiresAt?: number;
  refreshToken?: string;
}

interface PendingLogin {
  verifier: string;
  state: string;
  returnTo: string;
}

/** The login response does not say whether `expiresAt` is seconds or milliseconds; accept both. */
export function toEpochMs(value: number): number {
  return value < 100_000_000_000 ? value * 1000 : value;
}

const RETRY_REFRESH_MS = 15_000;

export class HostAuth {
  private snap: AuthSnapshot = { status: 'loading', displayName: null, busy: false, error: null };
  private tokens: Tokens | null = null;
  private started = false;
  private timer: unknown = null;
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly o: HostAuthOptions) {
    this.now = o.now ?? (() => Date.now());
    this.fetchImpl = o.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  // --- React binding (useSyncExternalStore) ---

  getSnapshot = (): AuthSnapshot => this.snap;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<AuthSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const l of [...this.listeners]) l();
  }

  // --- reads ---

  /** The bearer for the next request, or null when signed out or expired. */
  getToken = (): string | null => {
    const t = this.tokens;
    return t && t.expiresAt > this.now() ? t.idToken : null;
  };

  get mode(): 'local' | 'cognito' {
    return this.o.auth.mode;
  }

  // --- start-up ---

  /**
   * Restores a session, or finishes a Cognito redirect (`?code=&state=` on `/host`). Runs once;
   * React StrictMode mounts effects twice, and an authorization code can be used only once.
   * `onReturn` gets the page the host was on before the redirect.
   */
  async start(search: string, onReturn: (path: string) => void): Promise<void> {
    if (this.started) return;
    this.started = true;
    const auth = this.o.auth;
    if (auth.mode === 'cognito') {
      const pending = this.takePending();
      const cb = parseCallback(search, pending?.state ?? null);
      if (cb.kind === 'code' && pending) {
        await this.exchange(auth, cb.code, pending.verifier);
        onReturn(pending.returnTo);
        return;
      }
      if (cb.kind === 'error') {
        this.set({
          status: 'signed-out',
          error: `Sign-in did not finish (${cb.description ?? cb.error}). Try again.`,
        });
        onReturn(pending?.returnTo ?? '/host');
        return;
      }
    }
    await this.restore();
  }

  private async restore(): Promise<void> {
    const stored = this.readStored();
    const auth = this.o.auth;
    if (!stored || stored.mode !== auth.mode) {
      this.set({ status: 'signed-out' });
      return;
    }
    if (auth.mode === 'local') {
      if (stored.token && stored.expiresAt && stored.expiresAt > this.now() + 30_000) {
        this.tokens = { idToken: stored.token, refreshToken: null, expiresAt: stored.expiresAt };
        await this.becomeSignedIn();
        return;
      }
      this.clearStored();
      this.set({ status: 'signed-out' });
      return;
    }
    if (stored.refreshToken) {
      const ok = await this.refresh(stored.refreshToken);
      if (ok) return;
    }
    this.set({ status: 'signed-out' });
  }

  // --- local sign-in ---

  async signInLocal(username: string, password: string): Promise<boolean> {
    const body = LoginRequest.safeParse({ username, password });
    if (!body.success) {
      this.set({ error: 'Enter your username and password.' });
      return false;
    }
    this.set({ busy: true, error: null });
    try {
      const http = createHttpClient({
        baseUrl: this.o.apiBaseUrl,
        fetchImpl: this.fetchImpl,
      });
      const res = await http.post('/api/auth/login', body.data, {
        schema: LoginResponse,
        token: null,
      });
      this.tokens = { idToken: res.token, refreshToken: null, expiresAt: toEpochMs(res.expiresAt) };
      this.writeStored({ mode: 'local', token: res.token, expiresAt: this.tokens.expiresAt });
      await this.becomeSignedIn();
      return true;
    } catch (err) {
      this.set({ error: signInErrorMessage(err), status: 'signed-out' });
      return false;
    } finally {
      this.set({ busy: false });
    }
  }

  // --- Cognito ---

  async signInCognito(returnTo: string): Promise<void> {
    const auth = this.o.auth;
    if (auth.mode !== 'cognito') return;
    this.set({ busy: true, error: null });
    try {
      const verifier = createVerifier(this.o.getRandomValues);
      const state = createState(this.o.getRandomValues);
      const challenge = await challengeS256(verifier, this.o.subtle);
      const pending: PendingLogin = {
        verifier,
        state,
        returnTo: isInternalPath(returnTo) ? returnTo : '/host',
      };
      try {
        this.o.storage?.setItem(PKCE_KEY, JSON.stringify(pending));
      } catch {
        // Without storage the callback cannot be verified; the redirect would only fail later.
        this.set({ error: 'Your browser blocks the storage sign-in needs. Allow it and retry.' });
        return;
      }
      this.o.redirect(authorizeUrl(auth, this.o.origin, challenge, state));
    } finally {
      this.set({ busy: false });
    }
  }

  private takePending(): PendingLogin | null {
    try {
      const raw = this.o.storage?.getItem(PKCE_KEY) ?? null;
      this.o.storage?.removeItem(PKCE_KEY);
      if (raw === null) return null;
      const v = JSON.parse(raw) as Partial<PendingLogin>;
      if (typeof v.verifier !== 'string' || typeof v.state !== 'string') return null;
      return {
        verifier: v.verifier,
        state: v.state,
        returnTo:
          typeof v.returnTo === 'string' && isInternalPath(v.returnTo) ? v.returnTo : '/host',
      };
    } catch {
      return null;
    }
  }

  private async postToken(req: TokenRequest): Promise<Response> {
    return this.fetchImpl(req.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: req.body,
    });
  }

  private async exchange(auth: CognitoAuth, code: string, verifier: string): Promise<void> {
    this.set({ busy: true });
    try {
      const res = await this.postToken(tokenRequest(auth, this.o.origin, code, verifier));
      const tokens = res.ok ? parseTokenResponse(await res.json(), this.now()) : null;
      if (!tokens) throw new ApiRequestError(res.status, 'token', 'The sign-in reply was refused.');
      await this.adopt(tokens);
    } catch {
      this.set({ status: 'signed-out', error: 'Sign-in did not finish. Try again.' });
    } finally {
      this.set({ busy: false });
    }
  }

  /** Trades the refresh token for a new ID token. False when the host must sign in again. */
  async refresh(refreshToken: string | null = this.tokens?.refreshToken ?? null): Promise<boolean> {
    const auth = this.o.auth;
    if (auth.mode !== 'cognito' || !refreshToken) return false;
    try {
      const res = await this.postToken(refreshRequest(auth, refreshToken));
      if (!res.ok) {
        // 400 invalid_grant: revoked or expired. A 5xx is worth another try.
        if (res.status >= 500) return this.retryRefresh(refreshToken);
        this.dropSession();
        return false;
      }
      const tokens = parseTokenResponse(await res.json(), this.now(), refreshToken);
      if (!tokens) {
        this.dropSession();
        return false;
      }
      await this.adopt(tokens);
      return true;
    } catch {
      return this.retryRefresh(refreshToken);
    }
  }

  private retryRefresh(refreshToken: string): boolean {
    const held = this.tokens;
    if (held && held.expiresAt > this.now()) {
      this.schedule(RETRY_REFRESH_MS, () => void this.refresh(refreshToken));
      return true;
    }
    // Nothing usable in memory and no way to reach Cognito: ask again on the next start-up.
    this.set({ status: 'signed-out', error: "Couldn't reach the sign-in service. Try again." });
    return false;
  }

  private async adopt(tokens: Tokens): Promise<void> {
    this.tokens = tokens;
    if (tokens.refreshToken)
      this.writeStored({ mode: 'cognito', refreshToken: tokens.refreshToken });
    this.schedule(refreshDelayMs(tokens.expiresAt, this.now()), () => void this.refresh());
    await this.becomeSignedIn();
  }

  private schedule(ms: number, fn: () => void): void {
    this.cancelTimer();
    const set = this.o.setTimer ?? ((f, m) => setTimeout(f, m));
    this.timer = set(fn, ms);
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    (this.o.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
  }

  // --- profile, unauthorized, sign-out ---

  /** `GET /api/me` proves the token works and gives the name to show. */
  private async becomeSignedIn(): Promise<void> {
    this.set({ status: 'signed-in', error: null });
    try {
      const http = createHttpClient({
        baseUrl: this.o.apiBaseUrl,
        getToken: this.getToken,
        fetchImpl: this.fetchImpl,
      });
      const me = await http.get('/api/me', { schema: Me });
      this.set({ displayName: me.displayName });
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 401) {
        this.dropSession('Your session ended. Sign in again.');
      }
      // Any other failure only costs the display name.
    }
  }

  /**
   * A request came back 401. Cognito: the ID token may simply have expired, so try the refresh
   * token once. Returns whether the caller may retry.
   */
  async handleUnauthorized(): Promise<boolean> {
    if (this.o.auth.mode === 'cognito' && (await this.refresh())) return true;
    this.dropSession('Your session ended. Sign in again.');
    return false;
  }

  /** Forget the tokens without leaving the page. */
  private dropSession(error: string | null = null): void {
    this.cancelTimer();
    this.tokens = null;
    this.clearStored();
    this.set({ status: 'signed-out', displayName: null, error });
  }

  /** Cognito goes through its logout endpoint so managed login forgets the host too. */
  signOut(): void {
    const auth = this.o.auth;
    this.dropSession();
    if (auth.mode === 'cognito') this.o.redirect(logoutUrl(auth, this.o.origin));
  }

  // --- storage ---

  private readStored(): StoredAuth | null {
    try {
      const raw = this.o.storage?.getItem(AUTH_KEY) ?? null;
      if (raw === null) return null;
      const v = JSON.parse(raw) as StoredAuth;
      return v && (v.mode === 'local' || v.mode === 'cognito') ? v : null;
    } catch {
      return null;
    }
  }

  private writeStored(v: StoredAuth): void {
    try {
      this.o.storage?.setItem(AUTH_KEY, JSON.stringify(v));
    } catch {
      // The session then lasts only until the tab reloads.
    }
  }

  private clearStored(): void {
    try {
      this.o.storage?.removeItem(AUTH_KEY);
    } catch {
      // Nothing to clear.
    }
  }
}

export function signInErrorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.status === 401 || err.status === 403) return "That username or password isn't right.";
    if (err.status === 429) return 'Too many attempts. Wait a few minutes, then try again.';
    if (err.status === 0) return "Couldn't reach the server. Check your connection.";
    return err.message;
  }
  return 'Sign-in failed. Try again.';
}
