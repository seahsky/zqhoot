import { describe, expect, it } from 'vitest';
import { AUTH_KEY, HostAuth, PKCE_KEY, toEpochMs } from '../src/auth/session.ts';
import type { HostAuthOptions } from '../src/auth/session.ts';
import { challengeS256 } from '../src/auth/pkce.ts';
import type { StorageLike } from '../src/net/credentials.ts';

class MemoryStorage implements StorageLike {
  private readonly data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  key(i: number) {
    return [...this.data.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

interface Call {
  url: string;
  init: RequestInit;
}

/** Answers by URL suffix; every request is recorded. */
function fakeServer(routes: Record<string, () => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    for (const [suffix, respond] of Object.entries(routes)) {
      if (url.endsWith(suffix)) return respond();
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const ME = { hostId: 'local:admin', displayName: 'Admin' };
const CLOCK = { t: 1_800_000_000_000 };

function make(over: Partial<HostAuthOptions> & Pick<HostAuthOptions, 'auth'>) {
  const storage = new MemoryStorage();
  const redirects: string[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const auth = new HostAuth({
    apiBaseUrl: '',
    origin: 'https://quiz.example.test',
    storage,
    now: () => CLOCK.t,
    redirect: (url) => redirects.push(url),
    setTimer: (fn, ms) => timers.push({ fn, ms }) && timers.length,
    clearTimer: () => undefined,
    getRandomValues: ((a: Uint8Array) => {
      a.forEach((_, i) => (a[i] = i + 1));
      return a;
    }) as HostAuthOptions['getRandomValues'],
    ...over,
  });
  return { auth, storage, redirects, timers };
}

const COGNITO = {
  mode: 'cognito' as const,
  region: 'us-east-1',
  userPoolId: 'us-east-1_x',
  clientId: 'client-1',
  domain: 'https://pool.auth.us-east-1.amazoncognito.com',
};

describe('local sign-in', () => {
  it('posts the credentials, keeps the token in memory and sessionStorage, and loads the name', async () => {
    const server = fakeServer({
      '/api/auth/login': () => json({ token: 'JWT', expiresAt: CLOCK.t + 12 * 3_600_000 }),
      '/api/me': () => json(ME),
    });
    const { auth, storage } = make({ auth: { mode: 'local' }, fetchImpl: server.fetchImpl });
    await auth.start('', () => undefined);
    expect(auth.getSnapshot().status).toBe('signed-out');

    expect(await auth.signInLocal('admin', 'correct horse')).toBe(true);
    expect(server.calls[0]?.url).toBe('/api/auth/login');
    expect(JSON.parse(String(server.calls[0]?.init.body))).toEqual({
      username: 'admin',
      password: 'correct horse',
    });
    // The login itself carries no bearer; the profile lookup does.
    expect((server.calls[0]?.init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect((server.calls[1]?.init.headers as Record<string, string>).Authorization).toBe(
      'Bearer JWT',
    );
    expect(auth.getToken()).toBe('JWT');
    expect(auth.getSnapshot()).toMatchObject({
      status: 'signed-in',
      displayName: 'Admin',
      error: null,
    });
    expect(JSON.parse(storage.getItem(AUTH_KEY) ?? '')).toMatchObject({
      mode: 'local',
      token: 'JWT',
    });
  });

  it('a pasted password is sent as typed (WCAG 3.3.8): nothing trims or rewrites it', async () => {
    const server = fakeServer({
      '/api/auth/login': () => json({ token: 'JWT', expiresAt: CLOCK.t + 60_000 }),
      '/api/me': () => json(ME),
    });
    const { auth } = make({ auth: { mode: 'local' }, fetchImpl: server.fetchImpl });
    await auth.signInLocal('admin', '  spaces and Ünïcode  ');
    expect(JSON.parse(String(server.calls[0]?.init.body)).password).toBe('  spaces and Ünïcode  ');
  });

  it('explains a wrong password, a rate limit and a dead network without signing in', async () => {
    for (const [status, text] of [
      [401, /isn't right/],
      [429, /Too many attempts/],
    ] as const) {
      const server = fakeServer({
        '/api/auth/login': () => json({ error: 'x', message: 'nope' }, status),
      });
      const { auth } = make({ auth: { mode: 'local' }, fetchImpl: server.fetchImpl });
      expect(await auth.signInLocal('admin', 'bad')).toBe(false);
      expect(auth.getSnapshot()).toMatchObject({ status: 'signed-out', busy: false });
      expect(auth.getSnapshot().error).toMatch(text);
      expect(auth.getToken()).toBeNull();
    }
    const offline = make({
      auth: { mode: 'local' },
      fetchImpl: (async () => {
        throw new TypeError('offline');
      }) as typeof fetch,
    });
    await offline.auth.signInLocal('admin', 'x');
    expect(offline.auth.getSnapshot().error).toMatch(/Couldn't reach the server/);
  });

  it('refuses an empty form without a request', async () => {
    const server = fakeServer({});
    const { auth } = make({ auth: { mode: 'local' }, fetchImpl: server.fetchImpl });
    expect(await auth.signInLocal('', '')).toBe(false);
    expect(server.calls).toHaveLength(0);
    expect(auth.getSnapshot().error).toMatch(/Enter your username and password/);
  });

  it('a reload restores a token that is still good, and forgets one that expired', async () => {
    const server = fakeServer({ '/api/me': () => json(ME) });
    const { auth, storage } = make({ auth: { mode: 'local' }, fetchImpl: server.fetchImpl });
    storage.setItem(
      AUTH_KEY,
      JSON.stringify({ mode: 'local', token: 'JWT', expiresAt: CLOCK.t + 3_600_000 }),
    );
    await auth.start('', () => undefined);
    expect(auth.getSnapshot().status).toBe('signed-in');
    expect(auth.getToken()).toBe('JWT');

    const stale = make({ auth: { mode: 'local' }, fetchImpl: server.fetchImpl });
    stale.storage.setItem(
      AUTH_KEY,
      JSON.stringify({ mode: 'local', token: 'OLD', expiresAt: CLOCK.t - 1 }),
    );
    await stale.auth.start('', () => undefined);
    expect(stale.auth.getSnapshot().status).toBe('signed-out');
    expect(stale.storage.getItem(AUTH_KEY)).toBeNull();
  });

  it('a 401 from the profile lookup signs the host out', async () => {
    const server = fakeServer({
      '/api/me': () => json({ error: 'unauthorized', message: 'x' }, 401),
    });
    const { auth, storage } = make({ auth: { mode: 'local' }, fetchImpl: server.fetchImpl });
    storage.setItem(
      AUTH_KEY,
      JSON.stringify({ mode: 'local', token: 'JWT', expiresAt: CLOCK.t + 3_600_000 }),
    );
    await auth.start('', () => undefined);
    expect(auth.getSnapshot()).toMatchObject({
      status: 'signed-out',
      error: 'Your session ended. Sign in again.',
    });
    expect(auth.getToken()).toBeNull();
  });

  it('signing out clears memory and storage and stays on the page', async () => {
    const server = fakeServer({
      '/api/auth/login': () => json({ token: 'JWT', expiresAt: CLOCK.t + 60_000 }),
      '/api/me': () => json(ME),
    });
    const { auth, storage, redirects } = make({
      auth: { mode: 'local' },
      fetchImpl: server.fetchImpl,
    });
    await auth.signInLocal('admin', 'pw');
    auth.signOut();
    expect(auth.getToken()).toBeNull();
    expect(storage.getItem(AUTH_KEY)).toBeNull();
    expect(redirects).toEqual([]);
    expect(auth.getSnapshot().status).toBe('signed-out');
  });

  it('survives storage that throws', async () => {
    const server = fakeServer({
      '/api/auth/login': () => json({ token: 'JWT', expiresAt: CLOCK.t + 60_000 }),
      '/api/me': () => json(ME),
    });
    const throwing: StorageLike = {
      length: 0,
      key: () => null,
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    const { auth } = make({
      auth: { mode: 'local' },
      fetchImpl: server.fetchImpl,
      storage: throwing,
    });
    await auth.start('', () => undefined);
    expect(await auth.signInLocal('admin', 'pw')).toBe(true);
    expect(auth.getToken()).toBe('JWT');
  });

  it('reads an expiry given in seconds as well as milliseconds', () => {
    expect(toEpochMs(1_800_000_000)).toBe(1_800_000_000_000);
    expect(toEpochMs(1_800_000_000_000)).toBe(1_800_000_000_000);
  });
});

describe('Cognito sign-in', () => {
  it('redirects to the authorize URL after saving the verifier and state', async () => {
    const { auth, storage, redirects } = make({
      auth: COGNITO,
      fetchImpl: fakeServer({}).fetchImpl,
    });
    await auth.start('', () => undefined);
    await auth.signInCognito('/edit?q=abc123');
    expect(redirects).toHaveLength(1);
    const url = new URL(redirects[0] as string);
    expect(url.origin + url.pathname).toBe(`${COGNITO.domain}/oauth2/authorize`);
    const pending = JSON.parse(storage.getItem(PKCE_KEY) ?? '') as {
      verifier: string;
      state: string;
      returnTo: string;
    };
    expect(url.searchParams.get('state')).toBe(pending.state);
    expect(url.searchParams.get('code_challenge')).toBe(await challengeS256(pending.verifier));
    expect(url.searchParams.get('redirect_uri')).toBe('https://quiz.example.test/host');
    expect(pending.returnTo).toBe('/edit?q=abc123');
  });

  it('never returns to a URL that leaves the site', async () => {
    const { auth, storage } = make({ auth: COGNITO, fetchImpl: fakeServer({}).fetchImpl });
    await auth.signInCognito('https://evil.example/');
    expect(JSON.parse(storage.getItem(PKCE_KEY) ?? '').returnTo).toBe('/host');
  });

  const callback = async (search: (state: string) => string, tokenReply: () => Response) => {
    const server = fakeServer({ '/oauth2/token': tokenReply, '/api/me': () => json(ME) });
    const ctx = make({ auth: COGNITO, fetchImpl: server.fetchImpl });
    await ctx.auth.signInCognito('/host/live?s=abcdef');
    const state = new URL(ctx.redirects[0] as string).searchParams.get('state') as string;
    const returned: string[] = [];
    const fresh = new HostAuth({
      auth: COGNITO,
      apiBaseUrl: '',
      origin: 'https://quiz.example.test',
      storage: ctx.storage,
      now: () => CLOCK.t,
      fetchImpl: server.fetchImpl,
      redirect: () => undefined,
      setTimer: (fn, ms) => ctx.timers.push({ fn, ms }) && ctx.timers.length,
      clearTimer: () => undefined,
    });
    await fresh.start(search(state), (p) => returned.push(p));
    return { auth: fresh, server, ctx, returned };
  };

  it('exchanges the code, keeps the ID token in memory and only the refresh token in storage', async () => {
    const { auth, server, ctx, returned } = await callback(
      (state) => `?code=CODE&state=${state}`,
      () => json({ id_token: 'ID', access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }),
    );
    const token = server.calls.find((c) => c.url.endsWith('/oauth2/token'));
    expect(String(token?.init.body)).toContain('grant_type=authorization_code');
    expect(String(token?.init.body)).toContain('code=CODE');
    expect((token?.init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
    expect(auth.getToken()).toBe('ID');
    expect(auth.getSnapshot()).toMatchObject({ status: 'signed-in', displayName: 'Admin' });
    expect(JSON.parse(ctx.storage.getItem(AUTH_KEY) ?? '')).toEqual({
      mode: 'cognito',
      refreshToken: 'RT',
    });
    expect(ctx.storage.getItem(PKCE_KEY)).toBeNull();
    expect(returned).toEqual(['/host/live?s=abcdef']);
    // The ID token is what the API gets as the bearer.
    const me = server.calls.find((c) => c.url.endsWith('/api/me'));
    expect((me?.init.headers as Record<string, string>).Authorization).toBe('Bearer ID');
    // A refresh is scheduled a minute before it expires.
    expect(ctx.timers.at(-1)?.ms).toBe(3_600_000 - 60_000);
  });

  it('rejects a callback whose state does not match', async () => {
    const { auth, server } = await callback(
      () => '?code=CODE&state=forged',
      () => json({ id_token: 'ID', expires_in: 3600 }),
    );
    expect(server.calls.some((c) => c.url.endsWith('/oauth2/token'))).toBe(false);
    expect(auth.getSnapshot().status).toBe('signed-out');
    expect(auth.getSnapshot().error).toMatch(/state_mismatch/);
  });

  it('reports an error from Cognito and a refused code exchange', async () => {
    const denied = await callback(
      () => '?error=access_denied&error_description=User+cancelled',
      () => json({}),
    );
    expect(denied.auth.getSnapshot()).toMatchObject({ status: 'signed-out' });
    expect(denied.auth.getSnapshot().error).toMatch(/User cancelled/);

    const refused = await callback(
      (state) => `?code=CODE&state=${state}`,
      () => json({ error: 'invalid_grant' }, 400),
    );
    expect(refused.auth.getSnapshot()).toMatchObject({ status: 'signed-out', busy: false });
    expect(refused.auth.getToken()).toBeNull();
  });

  it('is started once, so a second mount cannot spend the code twice', async () => {
    const server = fakeServer({
      '/oauth2/token': () => json({ id_token: 'ID', refresh_token: 'RT', expires_in: 60 }),
      '/api/me': () => json(ME),
    });
    const ctx = make({ auth: COGNITO, fetchImpl: server.fetchImpl });
    await ctx.auth.signInCognito('/host');
    const state = new URL(ctx.redirects[0] as string).searchParams.get('state');
    await Promise.all([
      ctx.auth.start(`?code=CODE&state=${state}`, () => undefined),
      ctx.auth.start(`?code=CODE&state=${state}`, () => undefined),
    ]);
    expect(server.calls.filter((c) => c.url.endsWith('/oauth2/token'))).toHaveLength(1);
  });

  it('refreshes with the refresh token before the ID token expires, keeping the refresh token', async () => {
    let n = 0;
    const server = fakeServer({
      '/oauth2/token': () => json({ id_token: `ID${++n}`, expires_in: 3600 }),
      '/api/me': () => json(ME),
    });
    const ctx = make({ auth: COGNITO, fetchImpl: server.fetchImpl });
    ctx.storage.setItem(AUTH_KEY, JSON.stringify({ mode: 'cognito', refreshToken: 'RT' }));
    await ctx.auth.start('', () => undefined);
    expect(ctx.auth.getToken()).toBe('ID1');
    expect(String(server.calls[0]?.init.body)).toContain('grant_type=refresh_token');
    expect(String(server.calls[0]?.init.body)).toContain('refresh_token=RT');

    CLOCK.t += 3_540_000;
    ctx.timers.at(-1)?.fn();
    await new Promise((r) => setTimeout(r, 0));
    expect(ctx.auth.getToken()).toBe('ID2');
    expect(JSON.parse(ctx.storage.getItem(AUTH_KEY) ?? '').refreshToken).toBe('RT');
    CLOCK.t -= 3_540_000;
  });

  it('a revoked refresh token signs the host out', async () => {
    const server = fakeServer({ '/oauth2/token': () => json({ error: 'invalid_grant' }, 400) });
    const ctx = make({ auth: COGNITO, fetchImpl: server.fetchImpl });
    ctx.storage.setItem(AUTH_KEY, JSON.stringify({ mode: 'cognito', refreshToken: 'REVOKED' }));
    await ctx.auth.start('', () => undefined);
    expect(ctx.auth.getSnapshot().status).toBe('signed-out');
    expect(ctx.storage.getItem(AUTH_KEY)).toBeNull();
  });

  it('signing out clears the tokens and goes through the Cognito logout URL', async () => {
    const server = fakeServer({
      '/oauth2/token': () => json({ id_token: 'ID', refresh_token: 'RT', expires_in: 3600 }),
      '/api/me': () => json(ME),
    });
    const ctx = make({ auth: COGNITO, fetchImpl: server.fetchImpl });
    ctx.storage.setItem(AUTH_KEY, JSON.stringify({ mode: 'cognito', refreshToken: 'RT' }));
    await ctx.auth.start('', () => undefined);
    ctx.auth.signOut();
    expect(ctx.auth.getToken()).toBeNull();
    expect(ctx.storage.getItem(AUTH_KEY)).toBeNull();
    const url = new URL(ctx.redirects.at(-1) as string);
    expect(url.pathname).toBe('/logout');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('logout_uri')).toBe('https://quiz.example.test/host');
  });

  it('a 401 from the API is retried once with a refreshed token', async () => {
    let n = 0;
    const server = fakeServer({
      '/oauth2/token': () => json({ id_token: `ID${++n}`, expires_in: 3600 }),
      '/api/me': () => json(ME),
    });
    const ctx = make({ auth: COGNITO, fetchImpl: server.fetchImpl });
    ctx.storage.setItem(AUTH_KEY, JSON.stringify({ mode: 'cognito', refreshToken: 'RT' }));
    await ctx.auth.start('', () => undefined);
    expect(await ctx.auth.handleUnauthorized()).toBe(true);
    expect(ctx.auth.getToken()).toBe('ID2');
  });
});

describe('a mismatch between the stored session and the config', () => {
  it('ignores a local token when the deployment now uses Cognito', async () => {
    const ctx = make({ auth: COGNITO, fetchImpl: fakeServer({}).fetchImpl });
    ctx.storage.setItem(
      AUTH_KEY,
      JSON.stringify({ mode: 'local', token: 'JWT', expiresAt: CLOCK.t + 60_000 }),
    );
    await ctx.auth.start('', () => undefined);
    expect(ctx.auth.getSnapshot().status).toBe('signed-out');
  });
});
