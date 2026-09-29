import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  HOST_PIN,
  hostSnapshot,
  openQ,
  openResponses,
  roster,
  singleImageQ,
  singleQ,
} from '../src/dev/fixtures/hostSnapshots.ts';
import { DEFAULT_QUIZ_SETTINGS } from '@zqhoot/protocol';
import { HostApi, TOKEN, signedIn } from './host-api.ts';
import { ScriptedServer } from './scripted.ts';

/**
 * The host containers against a scripted server, in a real browser: sign-in in both modes, the
 * dashboard, live control, the presenter's keyboard map and auto-close, and the editor. Runs on
 * one project (playwright.config.ts).
 */

const SESSION = 'session-demo-01';

/** A host snapshot with times relative to the browser's clock, which is also the test's. */
function questionSnap(
  question: Record<string, unknown>,
  over: { openInMs?: number; limitMs?: number | null } = {},
) {
  const openAt = Date.now() + (over.openInMs ?? -1_000);
  const limit = over.limitMs === undefined ? 20_000 : over.limitMs;
  return hostSnapshot({
    phase: 'question',
    questionIndex: 0,
    totalQuestions: 3,
    roster: roster(3),
    question: {
      question: question as never,
      openAt,
      deadline: limit === null ? null : openAt + limit,
      closedAt: null,
    },
  });
}

/** Answers `host.hello` with the given snapshot. */
function hostServer(server: ScriptedServer, snapshot: () => Record<string, unknown>) {
  server.onClient = (msg, ws) => {
    if (msg.type === 'host.hello') {
      server.send(ws, { type: 'welcome', role: 'host', snapshot: snapshot() });
    }
  };
}

test.describe('sign-in, local mode', () => {
  test('the form suits password managers and paste, and a wrong password is explained', async ({
    page,
  }) => {
    const server = new ScriptedServer();
    await server.attach(page);
    const api = new HostApi();
    await api.attach(page);
    await page.route('**/api/auth/login', (route) => {
      const body = route.request().postDataJSON() as { username: string; password: string };
      return body.password === 'right password'
        ? route.fulfill({ json: { token: TOKEN, expiresAt: Date.now() + 3_600_000 } })
        : route.fulfill({ status: 401, json: { error: 'unauthorized', message: 'no' } });
    });

    await page.goto('/host');
    await expect(page.getByRole('heading', { name: 'Host sign-in' })).toBeVisible();
    const user = page.getByLabel('Username');
    const pass = page.getByLabel('Password');
    await expect(user).toHaveAttribute('autocomplete', 'username');
    await expect(pass).toHaveAttribute('autocomplete', 'current-password');
    await expect(pass).toHaveAttribute('type', 'password');

    // Pasting into either field is not blocked (WCAG 3.3.8).
    await pass.focus();
    const allowed = await page.evaluate(() => {
      const data = new DataTransfer();
      data.setData('text/plain', 'pasted');
      const ev = new ClipboardEvent('paste', {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      });
      return document.activeElement!.dispatchEvent(ev);
    });
    expect(allowed).toBe(true);

    await user.fill('admin');
    await pass.fill('wrong');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toContainText("isn't right");

    await pass.fill('right password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Your quizzes' })).toBeVisible();
    // The token is kept in sessionStorage for a reload (and for a presenter tab).
    const stored = await page.evaluate(() => sessionStorage.getItem('zqhoot:host:auth'));
    expect(JSON.parse(stored ?? '{}')).toMatchObject({ mode: 'local', token: TOKEN });
    // Every API call after sign-in carries it as a bearer.
    expect(api.calls.some((c) => c.path === '/api/quizzes' && c.auth === `Bearer ${TOKEN}`)).toBe(
      true,
    );
    // A reload stays signed in.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Your quizzes' })).toBeVisible();

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Host sign-in' })).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem('zqhoot:host:auth'))).toBeNull();
  });
});

test.describe('sign-in, Cognito', () => {
  const DOMAIN = 'https://login.example.test';
  const auth = {
    mode: 'cognito',
    region: 'us-east-1',
    userPoolId: 'us-east-1_x',
    clientId: 'client-abc',
    domain: DOMAIN,
  };

  test('PKCE redirect out, code exchange back, the ID token as bearer, and sign-out through the logout URL', async ({
    page,
    baseURL,
  }) => {
    // The app builds its redirect and logout URIs from its own origin, which follows ZQ_E2E_PORT.
    const hostUrl = new URL('/host', baseURL).href;
    const server = new ScriptedServer();
    await server.attach(page, { auth });
    const api = new HostApi();
    await api.attach(page);
    let authorizeUrl: URL | null = null;
    let tokenBody: URLSearchParams | null = null;
    let logoutUrl: URL | null = null;

    await page.route(`${DOMAIN}/oauth2/authorize*`, (route) => {
      authorizeUrl = new URL(route.request().url());
      const state = authorizeUrl.searchParams.get('state');
      return route.fulfill({
        status: 302,
        headers: { location: `${hostUrl}?code=CODE123&state=${state}` },
      });
    });
    await page.route(`${DOMAIN}/oauth2/token`, (route) => {
      tokenBody = new URLSearchParams(route.request().postData() ?? '');
      return route.fulfill({
        json: {
          id_token: 'ID.TOKEN.VALUE',
          access_token: 'AT',
          refresh_token: 'REFRESH1',
          expires_in: 3600,
          token_type: 'Bearer',
        },
        headers: { 'access-control-allow-origin': '*' },
      });
    });
    await page.route(`${DOMAIN}/logout*`, (route) => {
      logoutUrl = new URL(route.request().url());
      return route.fulfill({ status: 302, headers: { location: hostUrl } });
    });

    await page.goto('/host');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Your quizzes' })).toBeVisible();

    const authorize = authorizeUrl as URL | null;
    expect(authorize?.pathname).toBe('/oauth2/authorize');
    expect(Object.fromEntries(authorize?.searchParams ?? [])).toMatchObject({
      response_type: 'code',
      client_id: 'client-abc',
      redirect_uri: hostUrl,
      scope: 'openid email profile',
      code_challenge_method: 'S256',
    });
    expect(authorize?.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const token = tokenBody as URLSearchParams | null;
    expect(Object.fromEntries(token ?? [])).toMatchObject({
      grant_type: 'authorization_code',
      client_id: 'client-abc',
      code: 'CODE123',
      redirect_uri: hostUrl,
    });
    expect(token?.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // The ID token is the bearer; only the refresh token is kept in sessionStorage.
    await expect.poll(() => api.calls.some((c) => c.auth === 'Bearer ID.TOKEN.VALUE')).toBe(true);
    const stored = JSON.parse(
      (await page.evaluate(() => sessionStorage.getItem('zqhoot:host:auth'))) ?? '{}',
    );
    expect(stored).toEqual({ mode: 'cognito', refreshToken: 'REFRESH1' });
    expect(page.url()).not.toContain('code=');

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    const logout = logoutUrl as URL | null;
    expect(Object.fromEntries(logout?.searchParams ?? [])).toEqual({
      client_id: 'client-abc',
      logout_uri: hostUrl,
    });
    expect(await page.evaluate(() => sessionStorage.getItem('zqhoot:host:auth'))).toBeNull();
  });

  test('sign-out with unsaved changes asks once, then reaches the logout URL with no native prompt', async ({
    page,
    baseURL,
  }) => {
    const hostUrl = new URL('/host', baseURL).href;
    const server = new ScriptedServer();
    await server.attach(page, { auth });
    await new HostApi().attach(page);
    await page.route(`${DOMAIN}/oauth2/token`, (route) =>
      route.fulfill({
        json: {
          id_token: 'ID.TOKEN.1',
          access_token: 'AT',
          expires_in: 3600,
          token_type: 'Bearer',
        },
        headers: { 'access-control-allow-origin': '*' },
      }),
    );
    let logouts = 0;
    await page.route(`${DOMAIN}/logout*`, (route) => {
      logouts += 1;
      return route.fulfill({ status: 302, headers: { location: hostUrl } });
    });
    await page.addInitScript(() => {
      // Seeded once: after sign-out the emptied storage must stay empty across the redirect.
      if (!sessionStorage.getItem('seeded')) {
        sessionStorage.setItem('seeded', '1');
        sessionStorage.setItem(
          'zqhoot:host:auth',
          JSON.stringify({ mode: 'cognito', refreshToken: 'REFRESH1' }),
        );
      }
    });
    const native: string[] = [];
    page.on('dialog', (d) => {
      native.push(d.type());
      void d.dismiss();
    });

    await page.goto('/edit?q=new');
    await page.getByLabel('Title', { exact: true }).fill('Draft');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page
      .getByRole('dialog', { name: 'Leave without saving?' })
      .getByRole('button', { name: 'Leave and lose changes' })
      .click();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    expect(logouts).toBe(1);
    expect(native).toEqual([]);
    expect(await page.evaluate(() => sessionStorage.getItem('zqhoot:host:auth'))).toBeNull();
  });

  test('a callback whose state does not match is refused without a token request', async ({
    page,
  }) => {
    const server = new ScriptedServer();
    await server.attach(page, { auth });
    await new HostApi().attach(page);
    let tokenRequests = 0;
    await page.route(`${DOMAIN}/oauth2/token`, (route) => {
      tokenRequests += 1;
      return route.fulfill({ json: {} });
    });
    await page.goto('/host?code=CODE&state=forged');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('state_mismatch');
    expect(tokenRequests).toBe(0);
  });
});

test.describe('the dashboard', () => {
  async function seeded(page: Page) {
    const server = new ScriptedServer();
    await server.attach(page);
    const api = new HostApi();
    api.quizzes = [
      {
        id: 'quiz-demo-0001',
        title: 'Friday night trivia',
        questionCount: 10,
        updatedAt: Date.now() - 86_400_000,
        version: 4,
      },
      {
        id: 'quiz-demo-0002',
        title: 'Product retro',
        questionCount: 1,
        updatedAt: Date.now() - 2 * 86_400_000,
        version: 1,
      },
    ];
    api.sessions = [
      {
        sessionId: SESSION,
        pin: HOST_PIN,
        quizId: 'quiz-demo-0001',
        quizTitle: 'Friday night trivia',
        phase: 'ended',
        createdAt: Date.now() - 3_600_000,
        expiresAt: Date.now() + 3_600_000,
      },
    ];
    api.full.set('quiz-demo-0001', {
      id: 'quiz-demo-0001',
      ownerId: 'local:admin',
      title: 'Friday night trivia',
      questions: [singleQ],
      settings: DEFAULT_QUIZ_SETTINGS,
      version: 4,
      createdAt: 1,
      updatedAt: 2,
    });
    await api.attach(page);
    await signedIn(page);
    return { server, api };
  }

  test('lists quizzes and sessions, duplicates, and deletes only after a confirmation', async ({
    page,
  }) => {
    const { api } = await seeded(page);
    await page.goto('/host');
    await expect(
      page.getByRole('heading', { name: 'Friday night trivia', level: 3 }).first(),
    ).toBeVisible();
    await expect(page.getByText('10 questions · edited')).toBeVisible();
    await expect(page.getByText(/PIN 482 915/)).toBeVisible();

    await page.getByRole('button', { name: 'Duplicate Friday night trivia' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Duplicated' })).toBeVisible();
    expect(api.calledWith('POST', '/api/quizzes/quiz-demo-0001/duplicate')).toHaveLength(1);

    await page.getByRole('button', { name: 'Delete Product retro' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Delete this quiz?');
    // Focus starts on Cancel, so a stray Enter cannot delete.
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(api.calledWith('DELETE', /quizzes/)).toHaveLength(0);
    await page.getByRole('button', { name: 'Delete Product retro' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete quiz' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Quiz deleted' })).toBeVisible();
    expect(api.calledWith('DELETE', '/api/quizzes/quiz-demo-0002')).toHaveLength(1);
    await expect(page.getByRole('heading', { name: 'Product retro', level: 3 })).toHaveCount(0);
  });

  test('deleting a quiz by keyboard leaves focus on the quiz that took its place, then on New quiz', async ({
    page,
  }) => {
    await seeded(page);
    await page.goto('/host');
    const active = page.locator(':focus');
    const confirm = async () => {
      await expect(page.getByRole('dialog', { name: 'Delete this quiz?' })).toBeVisible();
      await page.keyboard.press('Tab'); // Cancel has focus first, Delete quiz is next
      await page.keyboard.press('Enter');
    };
    // Newest first: Friday night trivia, then Product retro. Delete the first.
    await page.getByRole('button', { name: 'Delete Friday night trivia' }).focus();
    await page.keyboard.press('Enter');
    await confirm();
    await expect(page.getByRole('status').filter({ hasText: 'Quiz deleted' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete Friday night trivia' })).toHaveCount(0);
    // The card that moved up is Product retro: its first action, Start session.
    await expect(active).toHaveText('Start session');
    await expect(active.locator('xpath=ancestor::li[1]')).toContainText('Product retro');

    // Deleting the only quiz left has nothing to move to but the way to make another.
    await page.getByRole('button', { name: 'Delete Product retro' }).focus();
    await page.keyboard.press('Enter');
    await confirm();
    await expect(page.getByText('You have no quizzes yet')).toBeVisible();
    await expect(active).toHaveText('New quiz');
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
  });

  test('downloads results with the bearer header and saves them as a file', async ({ page }) => {
    const { api } = await seeded(page);
    await page.goto('/host');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: /Download results for Friday night trivia/ }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('zqhoot-results-482915.csv');
    const path = await file.path();
    const { readFileSync } = await import('node:fs');
    // The saved file is the reply byte for byte: one UTF-8 byte order mark, then the CSV. (Reading
    // the reply as text drops the mark, so the dashboard has to write it back.)
    const saved = readFileSync(path);
    expect([...saved.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(saved.subarray(3).toString('utf8')).toBe(api.csv);
    const [call] = api.calledWith('GET', `/api/sessions/${SESSION}/results.csv`);
    expect(call?.auth).toBe(`Bearer ${TOKEN}`);
    expect(call?.accept).toBe('text/csv');
  });

  test('starting a session opens live control, which says hello as a control client', async ({
    page,
  }) => {
    const { server, api } = await seeded(page);
    hostServer(server, () => hostSnapshot({ roster: roster(3) }));
    await page.goto('/host');
    await page.getByRole('button', { name: 'Start session' }).first().click();
    await expect(page).toHaveURL(new RegExp(`/host/live\\?s=${SESSION}$`));
    expect(api.calledWith('POST', '/api/sessions')[0]?.body).toEqual({ quizId: 'quiz-demo-0001' });
    await expect(page.getByRole('heading', { name: 'Friday night trivia' })).toBeVisible();
    await expect.poll(() => server.clientMessages('host.hello').length).toBe(1);
    expect(server.clientMessages('host.hello')[0]).toEqual({
      type: 'host.hello',
      v: 1,
      sessionId: SESSION,
      client: 'control',
      authToken: TOKEN,
    });
  });

  test('opens the presenter in a new tab that is already signed in', async ({ page, context }) => {
    await seeded(page);
    await page.goto('/host');
    const popup = context.waitForEvent('page');
    await page.getByRole('button', { name: /Open presenter for Friday night trivia/ }).click();
    const tab = await popup;
    expect(tab.url()).toContain(`/present?s=${SESSION}`);
    // window.open kept the opener's sessionStorage; a noopener link would not have.
    expect(await tab.evaluate(() => sessionStorage.getItem('zqhoot:host:auth'))).toContain(TOKEN);
  });
});

test.describe('a host.hello the server refuses', () => {
  const DOMAIN = 'https://login.example.test';
  const auth = {
    mode: 'cognito',
    region: 'us-east-1',
    userPoolId: 'us-east-1_x',
    clientId: 'client-abc',
    domain: DOMAIN,
  };

  /** Cognito mode with a refresh token in sessionStorage, and a token endpoint that counts. */
  async function cognitoHost(page: Page, code: 'forbidden' | 'unauthorized') {
    const server = new ScriptedServer();
    await server.attach(page, { auth });
    server.onClient = (msg, ws) => {
      if (msg.type === 'host.hello') {
        server.send(ws, { type: 'error', code, message: `refused: ${code}`, ref: 'host.hello' });
        // Like the real server, which closes the socket after refusing a hello.
        void ws.close({ code: 1008 });
      }
    };
    await new HostApi().attach(page);
    const tokens = { calls: 0 };
    await page.route(`${DOMAIN}/oauth2/token`, (route) => {
      tokens.calls += 1;
      return route.fulfill({
        json: {
          id_token: `ID.TOKEN.${tokens.calls}`,
          access_token: 'AT',
          expires_in: 3600,
          token_type: 'Bearer',
        },
        headers: { 'access-control-allow-origin': '*' },
      });
    });
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('zqhoot:host:auth')) {
        sessionStorage.setItem(
          'zqhoot:host:auth',
          JSON.stringify({ mode: 'cognito', refreshToken: 'REFRESH1' }),
        );
      }
    });
    return { server, tokens };
  }

  for (const [name, path, heading] of [
    ['live control', `/host/live?s=${SESSION}`, 'This session belongs to another host'],
    ['the presenter', `/present?s=${SESSION}`, 'This session belongs to another host'],
  ] as const) {
    test(`${name}: forbidden stops for good: one hello, no token refresh, a screen that says why`, async ({
      page,
    }) => {
      const { server, tokens } = await cognitoHost(page, 'forbidden');
      await page.goto(path);
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
      await expect(page.getByText('from a different account')).toBeVisible();
      // The link to the dashboard and the way out are on the screen, as real controls.
      await expect(page.getByRole('link', { name: 'Back to your quizzes' })).toHaveAttribute(
        'href',
        '/host',
      );
      await expect(page.getByRole('button', { name: /^Sign out/ }).last()).toBeVisible();

      // The one refresh is the sign-in restored from the stored refresh token at page load.
      const refreshesAtStart = tokens.calls;
      expect(refreshesAtStart).toBe(1);
      expect(server.clientMessages('host.hello')).toHaveLength(1);
      // The unfixed page said hello and refreshed about 45 times a second from here on.
      await page.waitForTimeout(4_000);
      expect(server.clientMessages('host.hello')).toHaveLength(1);
      expect(tokens.calls).toBe(refreshesAtStart);
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    });
  }

  test('forbidden: Sign out leaves the page, and the way back is the dashboard', async ({
    page,
  }) => {
    const server = new ScriptedServer();
    await server.attach(page);
    server.onClient = (msg, ws) => {
      if (msg.type === 'host.hello') {
        server.send(ws, { type: 'error', code: 'forbidden', message: 'no', ref: 'host.hello' });
      }
    };
    await new HostApi().attach(page);
    await signedIn(page);
    await page.goto(`/present?s=${SESSION}`);
    await expect(
      page.getByRole('heading', { name: 'This session belongs to another host' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Host sign-in' })).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem('zqhoot:host:auth'))).toBeNull();
    expect(server.clientMessages('host.hello')).toHaveLength(1);
  });

  test('a token the server keeps refusing gets a few spaced-out refreshes, then the sign-in screen', async ({
    page,
  }) => {
    const { server, tokens } = await cognitoHost(page, 'unauthorized');
    await page.goto(`/host/live?s=${SESSION}`);
    // Every refresh waits out the reconnect backoff (under 0.5, 1 and 2 seconds), and after
    // three refreshes, the next refusal ends it: the host is asked to sign in again.
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('alert')).toContainText('Your session ended');
    const hellos = server.clientMessages('host.hello').length;
    // The restore at page load, then at most three refreshes, one per refusal.
    expect(tokens.calls).toBeLessThanOrEqual(1 + 3);
    expect(hellos).toBeLessThanOrEqual(1 + 3);
    expect(hellos).toBeGreaterThanOrEqual(2);
    await page.waitForTimeout(3_000);
    expect(server.clientMessages('host.hello')).toHaveLength(hellos);
    expect(tokens.calls).toBeLessThanOrEqual(1 + 3);
  });

  test('an expired token mends itself: one refresh, a new hello, and the game carries on', async ({
    page,
  }) => {
    const server = new ScriptedServer();
    await server.attach(page, { auth });
    let refused = false;
    server.onClient = (msg, ws) => {
      if (msg.type !== 'host.hello') return;
      if (!refused) {
        refused = true;
        server.send(ws, {
          type: 'error',
          code: 'unauthorized',
          message: 'expired',
          ref: 'host.hello',
        });
        return;
      }
      server.send(ws, {
        type: 'welcome',
        role: 'host',
        snapshot: hostSnapshot({ roster: roster(3) }),
      });
    };
    await new HostApi().attach(page);
    let refreshes = 0;
    await page.route(`${DOMAIN}/oauth2/token`, (route) => {
      refreshes += 1;
      return route.fulfill({
        json: { id_token: `ID.TOKEN.${refreshes}`, expires_in: 3600, token_type: 'Bearer' },
        headers: { 'access-control-allow-origin': '*' },
      });
    });
    await page.addInitScript(() => {
      sessionStorage.setItem(
        'zqhoot:host:auth',
        JSON.stringify({ mode: 'cognito', refreshToken: 'REFRESH1' }),
      );
    });
    await page.goto(`/host/live?s=${SESSION}`);
    await expect(page.getByText('Waiting to start')).toBeVisible({ timeout: 10_000 });
    expect(refreshes).toBe(2); // page load, then the one after the refusal
    const hellos = server.clientMessages('host.hello');
    expect(hellos).toHaveLength(2);
    expect(hellos[0]?.authToken).toBe('ID.TOKEN.1');
    expect(hellos[1]?.authToken).toBe('ID.TOKEN.2');
  });
});

test.describe('live control', () => {
  async function control(page: Page, snapshot: () => Record<string, unknown>) {
    const server = new ScriptedServer();
    await server.attach(page);
    hostServer(server, snapshot);
    await new HostApi().attach(page);
    await signedIn(page);
    await page.goto(`/host/live?s=${SESSION}`);
    return server;
  }

  test('shows the phase, PIN and join URL, and Next sends host.next with the from guard', async ({
    page,
  }) => {
    const server = await control(page, () => hostSnapshot({ roster: roster(3) }));
    await expect(page.getByText('Waiting to start')).toBeVisible();
    await expect(page.getByText('482 915')).toBeVisible();
    await expect(page.getByText('http://localhost:4173/join')).toBeVisible();
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await expect.poll(() => server.clientMessages('host.next').length).toBe(1);
    expect(server.clientMessages('host.next')[0]).toEqual({
      type: 'host.next',
      from: { phase: 'lobby', questionIndex: -1 },
    });

    // The state moves on when the server says so; the button follows.
    server.send(server.last, { type: 'host.state', snapshot: questionSnap(singleQ) });
    await expect(page.getByRole('button', { name: 'End question' })).toBeVisible();
    await expect(page.getByText('Question 1 of 3')).toBeVisible();
    // Hosts see the answer, the room does not.
    await expect(page.getByText('Now: Multiple choice')).toBeVisible();
    await expect(page.getByText('Correct answer')).toBeVisible();
  });

  test('lock, skip, kick and end each send their command, the last two after a confirmation', async ({
    page,
  }) => {
    const server = await control(page, () => questionSnap(singleQ));
    await expect(page.getByRole('button', { name: 'End question' })).toBeVisible();

    await page.getByRole('button', { name: 'Lock joining' }).click();
    await expect.poll(() => server.clientMessages('host.lock').length).toBe(1);
    expect(server.clientMessages('host.lock')[0]).toEqual({ type: 'host.lock', locked: true });

    await page.getByRole('button', { name: 'Skip question' }).click();
    await expect.poll(() => server.clientMessages('host.skip').length).toBe(1);
    expect(server.clientMessages('host.skip')[0]).toEqual({ type: 'host.skip', questionIndex: 0 });

    // Roster: search, then kick with a confirmation.
    await page.getByLabel('Find a player').fill('Jo');
    await expect(page.getByText('1 of 3 shown')).toBeVisible();
    await page.getByRole('button', { name: 'Kick Jo' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    expect(server.clientMessages('host.kick')).toHaveLength(0);
    await page.getByRole('button', { name: 'Kick Jo' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Remove player' }).click();
    await expect.poll(() => server.clientMessages('host.kick').length).toBe(1);
    expect(server.clientMessages('host.kick')[0]).toMatchObject({
      type: 'host.kick',
      playerId: expect.stringMatching(/^player-/),
    });

    await page.getByRole('button', { name: 'End session' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'End session' }).click();
    await expect.poll(() => server.clientMessages('host.end').length).toBe(1);
  });

  test('polls host.stats while a question is open and shows the distribution', async ({ page }) => {
    const server = new ScriptedServer();
    await server.attach(page);
    server.onClient = (msg, ws) => {
      if (msg.type === 'host.hello')
        server.send(ws, { type: 'welcome', role: 'host', snapshot: questionSnap(singleQ) });
      if (msg.type === 'host.stats') {
        server.send(ws, {
          type: 'stats',
          questionIndex: 0,
          stats: {
            type: 'single',
            answered: 2,
            totalPlayers: 3,
            counts: { 'option-mercury': 1, 'option-venus': 1, 'option-earth': 0, 'option-mars': 0 },
          },
        });
      }
    };
    await new HostApi().attach(page);
    await signedIn(page);
    await page.goto(`/host/live?s=${SESSION}`);
    await expect(page.getByText('2 of 3 answered (67%)')).toBeVisible();
    await expect(page.getByText('A · Mercury')).toBeVisible();
    expect(server.clientMessages('host.stats')[0]).toEqual({
      type: 'host.stats',
      questionIndex: 0,
    });
  });

  test('the moderation queue lists pending and visible responses, and Show sends host.moderate', async ({
    page,
  }) => {
    const server = new ScriptedServer();
    await server.attach(page);
    server.onClient = (msg, ws) => {
      if (msg.type === 'host.hello')
        server.send(ws, { type: 'welcome', role: 'host', snapshot: questionSnap(openQ) });
      if (msg.type === 'host.stats') {
        server.send(ws, {
          type: 'stats',
          questionIndex: 0,
          stats: {
            type: 'open',
            answered: 4,
            totalPlayers: 3,
            responses: openResponses().map((r, i) => ({
              ...r,
              receivedAt: Date.now() - 60_000 + i * 1_000,
            })),
            cursor: null,
          },
        });
      }
    };
    await new HostApi().attach(page);
    await signedIn(page);
    await page.goto(`/host/live?s=${SESSION}`);

    await expect(page.getByRole('heading', { name: 'Waiting for approval (2)' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'On the big screen (7)' })).toBeVisible();
    const show = page.getByRole('button', { name: /Show Tomas's response/ });
    await show.focus();
    await page.keyboard.press('Enter'); // operable from the keyboard
    await expect.poll(() => server.clientMessages('host.moderate').length).toBe(1);
    expect(server.clientMessages('host.moderate')[0]).toMatchObject({
      type: 'host.moderate',
      questionIndex: 0,
      status: 'visible',
      responseId: 'player-0010-0',
    });
    await expect(page.getByRole('heading', { name: 'Waiting for approval (1)' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'On the big screen (8)' })).toBeVisible();
  });

  test.describe('focus stays in the page after an action removes the control that had it', () => {
    /** The element with focus; `<body>` means focus was lost, which is what these tests forbid. */
    const active = (page: Page) => page.locator(':focus');
    const focusIsOnBody = (page: Page) =>
      page.evaluate(() => document.activeElement === document.body || !document.activeElement);

    /** A control page whose server keeps the moderation state, as the real one does. */
    async function moderated(page: Page) {
      const server = new ScriptedServer();
      await server.attach(page);
      const at = Date.now() - 60_000;
      const responses = openResponses().map((r, i) => ({ ...r, receivedAt: at + i * 1_000 }));
      server.onClient = (msg, ws) => {
        if (msg.type === 'host.hello')
          server.send(ws, { type: 'welcome', role: 'host', snapshot: questionSnap(openQ) });
        if (msg.type === 'host.moderate') {
          const r = responses.find((x) => x.id === msg.responseId);
          if (r) r.status = msg.status as typeof r.status;
        }
        if (msg.type === 'host.stats') {
          server.send(ws, {
            type: 'stats',
            questionIndex: 0,
            stats: { type: 'open', answered: 4, totalPlayers: 3, responses, cursor: null },
          });
        }
      };
      await new HostApi().attach(page);
      await signedIn(page);
      await page.goto(`/host/live?s=${SESSION}`);
      await expect(page.getByRole('heading', { name: 'Waiting for approval (2)' })).toBeVisible();
      return server;
    }

    test('Show and Hide: the response that took its place, or the list heading when it is empty', async ({
      page,
    }) => {
      const server = await moderated(page);
      // Two are waiting, newest first: Tomas, then Riley.
      await page.getByRole('button', { name: /Show Tomas's response/ }).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('heading', { name: 'Waiting for approval (1)' })).toBeVisible();
      await expect(active(page)).toHaveAccessibleName(/Show Riley's response/);

      await page.keyboard.press('Enter');
      await expect(page.getByRole('heading', { name: 'Waiting for approval (0)' })).toBeVisible();
      await expect(active(page)).toHaveText('Waiting for approval (0)');
      expect(await focusIsOnBody(page)).toBe(false);

      // Mateo is the only response that is hidden: showing him empties that list too.
      await page.getByRole('button', { name: /Show Mateo's response/ }).focus();
      await page.keyboard.press('Enter');
      await expect(active(page)).toHaveText('Hidden (0)');

      // Hiding the oldest visible response, which is last in its list: focus goes to the new last.
      await page.getByRole('button', { name: /Hide Ana's response/ }).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('heading', { name: /^Hidden \(1\)$/ })).toBeVisible();
      await expect(active(page)).toHaveAccessibleName(/Hide Jo's response/);
      // Every press went to the server, and nothing left focus on the page's <body>.
      expect(server.clientMessages('host.moderate')).toHaveLength(4);
      expect(await focusIsOnBody(page)).toBe(false);
    });

    test('Show with the mouse lands focus on the next response too', async ({ page }) => {
      await moderated(page);
      await page.getByRole('button', { name: /Show Tomas's response/ }).click();
      await expect(active(page)).toHaveAccessibleName(/Show Riley's response/);
    });

    test('a focus the host has already moved elsewhere is not taken back', async ({ page }) => {
      const server = new ScriptedServer();
      await server.attach(page);
      hostServer(server, () => questionSnap(singleQ));
      const hello = server.onClient;
      let release: () => void = () => undefined;
      const kicked = new Promise<void>((resolve) => (release = resolve));
      server.onClient = (msg, ws) => {
        hello(msg, ws);
        if (msg.type === 'host.kick') {
          // The server takes its time: the row is still there when the host moves on.
          void kicked.then(() =>
            server.send(ws, { type: 'roster', upsert: [], removed: [msg.playerId as string] }),
          );
        }
      };
      await new HostApi().attach(page);
      await signedIn(page);
      await page.goto(`/host/live?s=${SESSION}`);
      const top = roster(3)[2]!.nickname;
      await page.getByRole('button', { name: `Kick ${top}` }).focus();
      await page.keyboard.press('Enter');
      await page.getByRole('dialog').getByRole('button', { name: 'Remove player' }).click();
      await expect.poll(() => server.clientMessages('host.kick').length).toBe(1);
      await page.getByRole('button', { name: 'Lock joining' }).focus();

      release();
      await expect(page.getByRole('button', { name: `Kick ${top}` })).toHaveCount(0);
      await expect(active(page)).toHaveAccessibleName('Lock joining');
    });

    test('Kick: the next row’s Kick button, and the search box after the last row', async ({
      page,
    }) => {
      const server = new ScriptedServer();
      await server.attach(page);
      hostServer(server, () => questionSnap(singleQ));
      const kick = server.onClient;
      server.onClient = (msg, ws) => {
        kick(msg, ws);
        if (msg.type === 'host.kick') {
          server.send(ws, { type: 'roster', upsert: [], removed: [msg.playerId as string] });
        }
      };
      await new HostApi().attach(page);
      await signedIn(page);
      await page.goto(`/host/live?s=${SESSION}`);
      const names = roster(3).map((r) => r.nickname); // listed newest first: the last is on top
      const [first, second, third] = [names[2], names[1], names[0]] as string[];
      await expect(page.getByTestId('roster')).toContainText(first!);

      // Kick the top row: focus goes to the row that follows it.
      const kickButton = (name: string) => page.getByRole('button', { name: `Kick ${name}` });
      await kickButton(first!).focus();
      await page.keyboard.press('Enter');
      await page.getByRole('dialog').getByRole('button', { name: 'Remove player' }).click();
      await expect(kickButton(first!)).toHaveCount(0);
      await expect(active(page)).toHaveAccessibleName(`Kick ${second}`);

      // Kick the middle one, by keyboard from the dialog: again the row that follows.
      await page.keyboard.press('Enter');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Enter');
      await expect(kickButton(second!)).toHaveCount(0);
      await expect(active(page)).toHaveAccessibleName(`Kick ${third}`);

      // The last row has no next one: the search box.
      await page.keyboard.press('Enter');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Enter');
      await expect(kickButton(third!)).toHaveCount(0);
      await expect(active(page)).toHaveAccessibleName('Find a player');
      expect(server.clientMessages('host.kick')).toHaveLength(3);
      expect(await focusIsOnBody(page)).toBe(false);
    });

    test('Skip question and End session: focus moves to Next, or to the Control heading when it is done', async ({
      page,
    }) => {
      const server = new ScriptedServer();
      await server.attach(page);
      let snapshot: Record<string, unknown> = questionSnap(singleQ);
      server.onClient = (msg, ws) => {
        if (msg.type === 'host.hello') server.send(ws, { type: 'welcome', role: 'host', snapshot });
        if (msg.type === 'host.skip' || msg.type === 'host.end') {
          snapshot = {
            ...snapshot,
            sv: (snapshot.sv as number) + 1,
            phase: msg.type === 'host.skip' ? 'reveal' : 'ended',
            ...(msg.type === 'host.skip'
              ? {
                  result: {
                    type: 'single',
                    answered: 3,
                    totalPlayers: 3,
                    correctOptionId: 'option-mercury',
                    counts: { 'option-mercury': 3 },
                  },
                }
              : { question: undefined, podium: [] }),
          };
          server.send(ws, { type: 'host.state', snapshot });
        }
      };
      await new HostApi().attach(page);
      await signedIn(page);
      await page.goto(`/host/live?s=${SESSION}`);

      await page.getByRole('button', { name: 'Skip question' }).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('button', { name: 'Skip question' })).toHaveCount(0);
      await expect(active(page)).toHaveText('Leaderboard');
      expect(await focusIsOnBody(page)).toBe(false);

      await page.getByRole('button', { name: 'End session' }).focus();
      await page.keyboard.press('Enter');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Enter');
      await expect(page.getByText('Ended', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'End session' })).toHaveCount(0);
      // Next has nothing left to do, so it cannot hold focus: the panel's heading does.
      await expect(active(page)).toHaveText('Control');
    });
  });

  test('closes a question by itself at the deadline, once', async ({ page }) => {
    const server = await control(page, () =>
      questionSnap(singleQ, { openInMs: -500, limitMs: 1_500 }),
    );
    await expect.poll(() => server.clientMessages('host.close').length, { timeout: 5_000 }).toBe(1);
    expect(server.clientMessages('host.close')[0]).toEqual({
      type: 'host.close',
      questionIndex: 0,
      reason: 'timer',
    });
    await page.waitForTimeout(1_500);
    expect(server.clientMessages('host.close')).toHaveLength(1);
  });
});

test.describe('the presenter', () => {
  async function present(page: Page, snapshot: () => Record<string, unknown>) {
    const server = new ScriptedServer();
    await server.attach(page);
    hostServer(server, snapshot);
    await new HostApi().attach(page);
    await signedIn(page);
    await page.goto(`/present?s=${SESSION}`);
    return server;
  }

  test('says hello as a presenter and shows the lobby: PIN in threes, join URL, QR image, player count', async ({
    page,
  }) => {
    const server = await present(page, () => hostSnapshot({ roster: roster(5) }));
    await expect(page.getByTestId('pin')).toHaveText('482 915');
    await expect(page.getByTestId('join-url')).toHaveText('http://localhost:4173/join');
    await expect(page.getByTestId('player-count')).toHaveText('5 players');
    const qr = page.getByTestId('qr');
    await expect(qr).toHaveAttribute('src', /^data:image\/svg\+xml/);
    await expect(qr).toHaveAttribute('alt', /pin=482915/);
    expect(server.clientMessages('host.hello')[0]).toMatchObject({
      client: 'present',
      sessionId: SESSION,
    });
    // Nothing was injected as markup: the QR is an image, not inline SVG.
    expect(await page.locator('svg[shape-rendering]').count()).toBe(0);
  });

  test("the question's picture is described in the host's words, or is decoration without them", async ({
    page,
  }) => {
    const server = await present(page, () => questionSnap(singleImageQ, { limitMs: null }));
    const picture = page.getByTestId('stage').locator('img');
    await expect(picture).toHaveAttribute('alt', singleImageQ.imageAlt as string);
    await expect(page.getByRole('img', { name: singleImageQ.imageAlt as string })).toBeVisible();

    // The next question has a picture and no description: an empty alt, so a screen reader
    // skips it and the prompt carries the question.
    const next = questionSnap({ ...singleImageQ, imageAlt: undefined }, { limitMs: null });
    server.send(server.last, {
      type: 'host.state',
      snapshot: { ...next, sv: (next.sv as number) + 1 },
    });
    await expect(picture).toHaveAttribute('alt', '');
    await expect(page.getByRole('img')).toHaveCount(0);
  });

  test('the lobby says the PIN once, and who has joined at most every ten seconds, without the PIN', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    // Every change to what a live region says, with when it happened.
    await page.addInitScript(() => {
      const heard: Array<{ at: number; text: string }> = [];
      (window as unknown as { __heard: typeof heard }).__heard = heard;
      const last = new WeakMap<Element, string>();
      new MutationObserver(() => {
        for (const el of document.querySelectorAll('[role="status"]')) {
          const text = (el.textContent ?? '').trim();
          if (text !== (last.get(el) ?? '')) {
            last.set(el, text);
            if (text) heard.push({ at: performance.now(), text });
          }
        }
      }).observe(document, { subtree: true, childList: true, characterData: true });
    });
    const server = await present(page, () => hostSnapshot({ roster: [] }));
    await expect(page.getByTestId('pin')).toBeVisible();

    // Three players join within a moment.
    const join = (i: number) =>
      server.send(server.last, { type: 'roster', upsert: roster(3).slice(i, i + 1), removed: [] });
    join(0);
    await page.waitForTimeout(150);
    join(1);
    await page.waitForTimeout(150);
    join(2);
    await expect(page.getByTestId('player-count')).toHaveText('3 players');

    // The first join is heard at once; the rest wait for the ten seconds to pass.
    type Heard = Array<{ at: number; text: string }>;
    const readHeard = async () =>
      (await page.evaluate(() => (window as never as { __heard: Heard }).__heard)).filter((h) =>
        /PIN|joined/.test(h.text),
      );
    await expect.poll(async () => (await readHeard()).length, { timeout: 20_000 }).toBe(3);
    const heard = await readHeard();
    expect(heard.map((h) => h.text)).toEqual([
      'Lobby. PIN 4 8 2 9 1 5.',
      '1 player has joined.',
      '3 players have joined.',
    ]);
    // "2 players" was never said: it was replaced before its turn came.
    expect(heard[2]!.at - heard[1]!.at).toBeGreaterThanOrEqual(9_500);
    // The PIN is in one announcement, and no join announcement carries it.
    expect(heard.filter((h) => /PIN/.test(h.text))).toHaveLength(1);
    for (const h of heard.slice(1)) expect(h.text).not.toMatch(/\d{3}|PIN/);
  });

  test('the control bar is a labelled group, and a clicker still advances the game from inside it', async ({
    page,
  }) => {
    const server = await present(page, () => hostSnapshot({ roster: roster(3) }));
    await expect(page.getByTestId('pin')).toBeVisible();
    const bar = page.getByRole('group', { name: 'Presenter controls' });
    await expect(bar).toBeVisible();
    // Not a toolbar: that role tells a screen reader user that arrows move between its buttons.
    await expect(page.getByRole('toolbar')).toHaveCount(0);

    // Focus is on a button in the bar, as after a click; → and Page Down are still "next".
    const size = bar.getByRole('button', { name: /Text size/ });
    await size.focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => server.clientMessages('host.next').length).toBe(1);
    await page.keyboard.press('PageDown');
    await expect.poll(() => server.clientMessages('host.next').length).toBe(2);
    await expect(size).toBeFocused();
    // Space on a button presses that button, and only that.
    await page.keyboard.press('Space');
    await expect(bar.getByRole('button', { name: 'Text size 125%' })).toBeVisible();
    await page.waitForTimeout(300);
    expect(server.clientMessages('host.next')).toHaveLength(2);
  });

  test('the keyboard map: Space, arrows, Page Down, Enter, L, and nothing for the left arrow', async ({
    page,
  }) => {
    const server = await present(page, () => hostSnapshot({ roster: roster(5) }));
    await expect(page.getByTestId('pin')).toBeVisible();

    await page.keyboard.press('Space');
    await expect.poll(() => server.clientMessages('host.next').length).toBe(1);
    expect(server.clientMessages('host.next')[0]).toEqual({
      type: 'host.next',
      from: { phase: 'lobby', questionIndex: -1 },
    });
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('PageDown');
    await expect.poll(() => server.clientMessages('host.next').length).toBe(3);

    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Enter'); // no question is open: nothing to close
    await page.keyboard.press('l');
    await expect.poll(() => server.clientMessages('host.lock').length).toBe(1);
    expect(server.clientMessages('host.lock')[0]).toEqual({ type: 'host.lock', locked: true });
    await page.waitForTimeout(300);
    expect(server.clientMessages('host.close')).toHaveLength(0);
    expect(
      server.received.filter(
        (m) => !['host.hello', 'host.next', 'host.lock', 'ping'].includes(m.type),
      ),
    ).toEqual([]);

    // The state follows the server: a question opens, Enter ends it, Space uses the new guard.
    server.send(server.last, {
      type: 'host.state',
      snapshot: questionSnap(singleQ, { limitMs: null }),
    });
    await expect(
      page.getByRole('heading', { name: 'Which planet is closest to the Sun?' }),
    ).toBeVisible();
    await page.keyboard.press('Enter');
    await expect.poll(() => server.clientMessages('host.close').length).toBe(1);
    expect(server.clientMessages('host.close')[0]).toEqual({
      type: 'host.close',
      questionIndex: 0,
      reason: 'manual',
    });
    await page.keyboard.press('Space');
    await expect.poll(() => server.clientMessages('host.next').length).toBe(4);
    expect(server.clientMessages('host.next').at(-1)).toEqual({
      type: 'host.next',
      from: { phase: 'question', questionIndex: 0 },
    });
  });

  test('keys typed into a form control are ignored', async ({ page }) => {
    const server = await present(page, () => hostSnapshot({ roster: roster(2) }));
    await expect(page.getByTestId('pin')).toBeVisible();
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.id = 'scratch';
      input.setAttribute('aria-label', 'scratch');
      document.body.append(input);
      input.focus();
    });
    await page.keyboard.type('l t d f ');
    await page.keyboard.press('Space');
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(300);
    expect(
      server.received.map((m) => m.type).filter((t) => t.startsWith('host.') && t !== 'host.hello'),
    ).toEqual([]);
    await expect(page.getByRole('button', { name: /Text size 100%/ })).toBeVisible();
  });

  test('T, D and F change the stage and are remembered; ? opens the help, which Escape closes', async ({
    page,
  }) => {
    await present(page, () => hostSnapshot({ roster: roster(2) }));
    await expect(page.getByTestId('pin')).toBeVisible();

    await page.keyboard.press('t');
    await expect(page.getByRole('button', { name: 'Text size 125%' })).toBeVisible();
    await page.keyboard.press('t');
    await expect(page.getByRole('button', { name: 'Text size 150%' })).toBeVisible();
    await page.keyboard.press('t');
    await expect(page.getByRole('button', { name: 'Text size 100%' })).toBeVisible();
    await page.keyboard.press('t');

    await page.keyboard.press('d');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await page.evaluate(() => localStorage.getItem('zqhoot:present:text-scale'))).toBe(
      '1.25',
    );
    expect(await page.evaluate(() => localStorage.getItem('zqhoot:present:theme'))).toBe('dark');

    // A reload keeps both.
    await page.reload();
    await expect(page.getByRole('button', { name: 'Text size 125%' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.keyboard.press('Shift+?');
    const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(help).toBeVisible();
    for (const text of ['Space', 'Enter', 'Text size', 'Lock or unlock joining', 'left arrow']) {
      await expect(help).toContainText(text);
    }
    await page.keyboard.press('Escape');
    await expect(help).toBeHidden();
  });

  test('the help overlay is reachable by keyboard alone, through its button', async ({ page }) => {
    await present(page, () => hostSnapshot({ roster: roster(2) }));
    const button = page.getByRole('button', { name: 'Shortcuts (?)' });
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
    // Space would advance the game; with the overlay open it does nothing.
    await page.keyboard.press('Space');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(button).toBeFocused();
  });

  test('every control is a focusable button; hiding the bar keeps it reachable by Tab', async ({
    page,
  }) => {
    const server = await present(page, () => hostSnapshot({ roster: roster(2) }));
    const bar = page.getByRole('group', { name: 'Presenter controls' });
    await expect(bar).toBeVisible();
    const names = [
      'Start',
      'Lock joining',
      /Text size/,
      /Dark screen/,
      /Full screen/,
      /Shortcuts/,
      'Hide controls',
    ];
    for (const name of names) await expect(bar.getByRole('button', { name })).toBeVisible();

    await bar.getByRole('button', { name: 'Hide controls' }).click();
    // The clicked button still holds focus, which keeps the bar showing; let go of it first.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    // A click on the stage sets where Tab starts from, as a person's would.
    await page.mouse.click(300, 300);
    await expect(bar).toHaveCSS('opacity', '0');
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => document.activeElement?.textContent);
    expect(focused).toBeTruthy();
    await expect(bar).toHaveCSS('opacity', '1'); // it shows itself while it holds focus
    await bar.getByRole('button', { name: 'Start' }).click();
    await expect.poll(() => server.clientMessages('host.next').length).toBe(1);
  });

  test('polls stats from the moment options open and closes at the deadline, once', async ({
    page,
  }) => {
    const server = new ScriptedServer();
    await server.attach(page);
    server.onClient = (msg, ws) => {
      if (msg.type === 'host.hello') {
        server.send(ws, {
          type: 'welcome',
          role: 'host',
          snapshot: questionSnap(singleQ, { openInMs: -300, limitMs: 2_600 }),
        });
      }
      if (msg.type === 'host.stats') {
        server.send(ws, {
          type: 'stats',
          questionIndex: 0,
          stats: { type: 'single', answered: 1, totalPlayers: 3, counts: {} },
        });
      }
    };
    await new HostApi().attach(page);
    await signedIn(page);
    await page.goto(`/present?s=${SESSION}`);
    await expect(page.getByTestId('answer-count')).toHaveText('1 of 3 answered');
    await expect.poll(() => server.clientMessages('host.close').length, { timeout: 6_000 }).toBe(1);
    expect(server.clientMessages('host.close')[0]).toEqual({
      type: 'host.close',
      questionIndex: 0,
      reason: 'timer',
    });
    const stats = server.clientMessages('host.stats');
    expect(stats.length).toBeGreaterThanOrEqual(2);
    expect(stats.length).toBeLessThanOrEqual(4); // once a second for about two seconds
    await page.waitForTimeout(1_500);
    expect(server.clientMessages('host.close')).toHaveLength(1);
  });

  test('closes early when everyone has answered', async ({ page }) => {
    const server = new ScriptedServer();
    await server.attach(page);
    server.onClient = (msg, ws) => {
      if (msg.type === 'host.hello') {
        server.send(ws, {
          type: 'welcome',
          role: 'host',
          snapshot: questionSnap(singleQ, { openInMs: -300, limitMs: 60_000 }),
        });
      }
      if (msg.type === 'host.stats') {
        server.send(ws, {
          type: 'stats',
          questionIndex: 0,
          stats: { type: 'single', answered: 3, totalPlayers: 3, counts: {} },
        });
      }
    };
    await new HostApi().attach(page);
    await signedIn(page);
    await page.goto(`/present?s=${SESSION}`);
    await expect.poll(() => server.clientMessages('host.close').length, { timeout: 5_000 }).toBe(1);
    expect(server.clientMessages('host.close')[0]).toEqual({
      type: 'host.close',
      questionIndex: 0,
      reason: 'all-answered',
    });
    await page.waitForTimeout(1_500);
    expect(server.clientMessages('host.close')).toHaveLength(1);
  });

  test('shows the reveal from the host state, and never the answer while the question is open', async ({
    page,
  }) => {
    const server = await present(page, () => questionSnap(singleQ, { limitMs: null }));
    await expect(
      page.getByRole('heading', { name: 'Which planet is closest to the Sun?' }),
    ).toBeVisible();
    // The host snapshot that arrived does contain the answer; the page must not render it.
    const html = await page.content();
    expect(html).not.toContain('option-mercury');
    expect(await page.getByTestId('stage').innerText()).not.toMatch(/correct/i);

    const snap = questionSnap(singleQ, { limitMs: null }) as Record<string, unknown>;
    server.send(server.last, {
      type: 'host.state',
      snapshot: {
        ...snap,
        sv: (snap.sv as number) + 1,
        phase: 'reveal',
        result: {
          type: 'single',
          answered: 3,
          totalPlayers: 3,
          correctOptionId: 'option-mercury',
          counts: { 'option-mercury': 2, 'option-venus': 1, 'option-earth': 0, 'option-mars': 0 },
        },
      },
    });
    await expect(page.locator('[class*="badge"]', { hasText: 'Correct' })).toBeVisible();
    await expect(page.getByText('A · Mercury · 2 · 67%')).toBeVisible();
  });

  test('a dropped connection shows Reconnecting and keeps the screen, then hellos again', async ({
    page,
  }) => {
    const server = await present(page, () => hostSnapshot({ roster: roster(2) }));
    await expect(page.getByTestId('pin')).toBeVisible();
    await server.last.close({ code: 1006 });
    await expect(page.getByRole('status').filter({ hasText: 'Reconnecting…' })).toBeVisible();
    await expect(page.getByTestId('pin')).toBeVisible();
    await expect
      .poll(() => server.clientMessages('host.hello').length, { timeout: 15_000 })
      .toBe(2);
    await expect(page.getByRole('status').filter({ hasText: 'Reconnecting…' })).toHaveCount(0);
  });

  test('a command sent while the socket is down says so and is not queued', async ({ page }) => {
    const server = await present(page, () => hostSnapshot({ roster: roster(2) }));
    await expect(page.getByTestId('pin')).toBeVisible();
    await page.routeWebSocket('ws://localhost:4173/ws', (ws) => ws.close({ code: 1006 }));
    await server.last.close({ code: 1006 });
    await expect(page.getByRole('status').filter({ hasText: 'Reconnecting…' })).toBeVisible();
    await page.keyboard.press('Space');
    await page.waitForTimeout(300);
    expect(server.clientMessages('host.next')).toHaveLength(0);
  });
});

test.describe('the editor', () => {
  /** The picture preview: with no description it is decoration, so it has no role to find it by. */
  const preview = (page: Page) => page.locator('[class*="picture"] img');

  async function editor(page: Page, path = '/edit?q=new') {
    const server = new ScriptedServer();
    await server.attach(page);
    const api = new HostApi();
    await api.attach(page);
    await signedIn(page);
    await page.goto(path);
    return { server, api };
  }

  async function fillFirstQuestion(page: Page) {
    await page.getByLabel('Title', { exact: true }).fill('Planets');
    await page.getByLabel('Question', { exact: true }).fill('Which planet is closest to the Sun?');
    await page.getByLabel('Answer A', { exact: true }).fill('Mercury');
    await page.getByLabel('Answer B', { exact: true }).fill('Venus');
    await page.getByLabel('Answer C', { exact: true }).fill('Earth');
    await page.getByLabel('Answer D', { exact: true }).fill('Mars');
  }

  test('creates a quiz with POST, validated first, then follows it to its own URL', async ({
    page,
  }) => {
    const { api } = await editor(page);
    await expect(page.getByRole('heading', { name: 'New quiz' })).toBeVisible();
    await fillFirstQuestion(page);
    await page.getByRole('button', { name: 'Save quiz' }).first().click();
    await expect(page).toHaveURL(/\/edit\?q=quiz-new-0001$/);
    const [post] = api.calledWith('POST', '/api/quizzes');
    expect(post?.auth).toBe(`Bearer ${TOKEN}`);
    expect(post?.body).toMatchObject({
      title: 'Planets',
      settings: { streakBonus: false, showQuestionOnDevices: true, readSeconds: 3 },
      questions: [
        {
          type: 'single',
          prompt: 'Which planet is closest to the Sun?',
          timeLimitSec: 20,
          points: 1,
          options: [{ text: 'Mercury' }, { text: 'Venus' }, { text: 'Earth' }, { text: 'Mars' }],
        },
      ],
    });
    // The ids are generated in the browser: 21 URL-safe characters.
    const question = (post?.body as { questions: Array<{ id: string; correctOptionId: string }> })
      .questions[0]!;
    expect(question.id).toMatch(/^[A-Za-z0-9_-]{21}$/);
    expect(question.correctOptionId).toMatch(/^[A-Za-z0-9_-]{21}$/);
    await expect(page.getByRole('status').filter({ hasText: 'All changes saved' })).toBeVisible();
  });

  test('a save with mistakes shows a summary that links to each field, with an inline message', async ({
    page,
  }) => {
    const { api } = await editor(page);
    await page.getByRole('button', { name: 'Save quiz' }).first().click();
    const summary = page.getByTestId('error-summary');
    await expect(summary).toBeFocused();
    await expect(summary).toContainText('Give the quiz a title.');
    await expect(summary).toContainText('Question 1: write the question.');
    await expect(summary).toContainText('Question 1, answer A: write the answer text.');
    expect(api.calledWith('POST', '/api/quizzes')).toHaveLength(0);

    // The title has its message next to it, and the link moves focus to it.
    await expect(page.locator('#f-title')).toHaveAttribute('aria-invalid', 'true');
    await summary.getByRole('link', { name: 'Give the quiz a title.' }).click();
    await expect(page.locator('#f-title')).toBeFocused();

    // A link into a closed question opens it first.
    await page.getByRole('button', { name: /Multiple choice/ }).click(); // collapse question 1
    await expect(page.getByLabel('Question', { exact: true })).toHaveCount(0);
    await summary.getByRole('link', { name: 'Question 1: write the question.' }).click();
    await expect(page.locator('#f-questions-0-prompt')).toBeFocused();

    // Fixing a field clears its message without another save.
    await page.locator('#f-questions-0-prompt').fill('Which planet?');
    await expect(summary).not.toContainText('Question 1: write the question.');
  });

  test('every question type has its own fields and saves what they hold', async ({ page }) => {
    const { api } = await editor(page);
    await fillFirstQuestion(page);
    const add = async (label: string) => {
      await page.getByLabel('New question type').selectOption({ label });
      await page.getByRole('button', { name: 'Add question' }).click();
    };
    await add('True or false');
    await page.getByLabel('Question', { exact: true }).fill('The Moon is made of rock.');
    await page.getByLabel('True', { exact: true }).check();

    await add('Poll');
    await page.getByLabel('Question', { exact: true }).fill('Where to eat?');
    await page.getByLabel('Answer A', { exact: true }).fill('Cafe');
    await page.getByLabel('Answer B', { exact: true }).fill('Park');
    await page.getByLabel('Answer C', { exact: true }).fill('Deli');
    await page.getByLabel('Answer D', { exact: true }).fill('Home');
    await page.getByRole('button', { name: 'Add answer' }).click();
    await page.getByLabel('Answer E', { exact: true }).fill('Truck');

    await add('Word cloud');
    await page.getByLabel('Question', { exact: true }).fill('One word for this week?');
    await page.getByLabel('Words per player').selectOption('4');

    await add('Open-ended');
    await page.getByLabel('Question', { exact: true }).fill('What should we do next?');
    await page.getByLabel('Responses per player').selectOption('2');
    const approval = page.getByLabel('Approve responses before they show');
    await expect(approval).toBeChecked(); // on by default
    await approval.uncheck();

    await add('Rating');
    await page.getByLabel('Question', { exact: true }).fill('How was it?');
    await page.getByLabel('Scale').selectOption('7');
    await page.getByLabel('Label for 1 (optional)').fill('Poor');
    await page.getByLabel('Label for 7 (optional)').fill('Great');
    await page.getByLabel('Time limit').selectOption('none');

    await page.getByRole('button', { name: 'Save quiz' }).first().click();
    await expect(page).toHaveURL(/q=quiz-new-0001$/);
    const questions = (
      api.calledWith('POST', '/api/quizzes')[0]?.body as {
        questions: Array<Record<string, unknown>>;
      }
    ).questions;
    expect(questions.map((q) => q.type)).toEqual([
      'single',
      'truefalse',
      'poll',
      'wordcloud',
      'open',
      'rating',
    ]);
    expect(questions[1]).toMatchObject({ correct: true, timeLimitSec: 20, points: 1 });
    expect((questions[2] as { options: unknown[] }).options).toHaveLength(5);
    expect(questions[3]).toMatchObject({ maxEntries: 4, timeLimitSec: 30 });
    expect(questions[4]).toMatchObject({ maxEntries: 2, requireApproval: false, timeLimitSec: 30 });
    expect(questions[5]).toMatchObject({
      max: 7,
      minLabel: 'Poor',
      maxLabel: 'Great',
      timeLimitSec: null,
    });
  });

  test('questions move up and down with buttons, and duplicate and delete', async ({ page }) => {
    await editor(page);
    await fillFirstQuestion(page);
    await page.getByLabel('New question type').selectOption({ label: 'Rating' });
    await page.getByRole('button', { name: 'Add question' }).click();
    await page.getByLabel('Question', { exact: true }).fill('Second question');
    const order = async () => page.locator('[data-question] [class*="preview"]').allTextContents();
    expect(await order()).toEqual(['Which planet is closest to the Sun?', 'Second question']);

    await page.getByRole('button', { name: 'Move up, question 2' }).click();
    expect(await order()).toEqual(['Second question', 'Which planet is closest to the Sun?']);
    await expect(page.getByRole('button', { name: 'Move up, question 1' })).toBeDisabled();
    await page.getByRole('button', { name: 'Move down, question 1' }).click();
    expect(await order()).toEqual(['Which planet is closest to the Sun?', 'Second question']);

    await page.getByRole('button', { name: 'Duplicate, question 1' }).click();
    expect(await order()).toEqual([
      'Which planet is closest to the Sun?',
      'Which planet is closest to the Sun?',
      'Second question',
    ]);
    await page.getByRole('button', { name: 'Delete, question 3' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete question' }).click();
    expect(await order()).toHaveLength(2);
  });

  test('saving an existing quiz sends PUT with expectedVersion; a 409 offers reload or overwrite', async ({
    page,
  }) => {
    const server = new ScriptedServer();
    await server.attach(page);
    const api = new HostApi();
    api.full.set('quiz-demo-0001', {
      id: 'quiz-demo-0001',
      ownerId: 'local:admin',
      title: 'Friday night trivia',
      version: 3,
      createdAt: 1,
      updatedAt: 2,
      settings: DEFAULT_QUIZ_SETTINGS,
      questions: [{ ...singleQ, id: 'question-planet', points: 1 }],
    });
    await api.attach(page);
    await signedIn(page);
    await page.goto('/edit?q=quiz-demo-0001');
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Friday night trivia');

    await page.getByLabel('Title', { exact: true }).fill('Friday night trivia, revised');
    await page.getByRole('status').filter({ hasText: 'Unsaved changes' }).waitFor();
    await page.getByRole('button', { name: 'Save quiz' }).first().click();
    await expect(page.getByRole('status').filter({ hasText: 'All changes saved' })).toBeVisible();
    const [put] = api.calledWith('PUT', '/api/quizzes/quiz-demo-0001');
    expect(put?.body).toMatchObject({
      expectedVersion: 3,
      quiz: { title: 'Friday night trivia, revised' },
    });

    // Someone else saved meanwhile: the server answers 409.
    api.conflictOnce = true;
    await page.getByLabel('Title', { exact: true }).fill('Mine');
    await page.getByRole('button', { name: 'Save quiz' }).first().click();
    const conflict = page.getByTestId('conflict');
    await expect(conflict).toContainText('This quiz changed elsewhere');
    // Overwrite: fetch the current version, then save on top of it.
    api.full.set('quiz-demo-0001', { ...(api.full.get('quiz-demo-0001') as object), version: 9 });
    await conflict.getByRole('button', { name: 'Overwrite with my version' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'All changes saved' })).toBeVisible();
    expect(api.calledWith('PUT', '/api/quizzes/quiz-demo-0001').at(-1)?.body).toMatchObject({
      expectedVersion: 9,
      quiz: { title: 'Mine' },
    });

    // Reload: take the server's version and drop the edits.
    api.conflictOnce = true;
    await page.getByLabel('Title', { exact: true }).fill('Lost edit');
    await page.getByRole('button', { name: 'Save quiz' }).first().click();
    await page
      .getByTestId('conflict')
      .getByRole('button', { name: 'Reload the latest version' })
      .click();
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Mine');
    await expect(page.getByTestId('conflict')).toHaveCount(0);
  });

  test('warns before leaving with unsaved changes, and not otherwise', async ({ page }) => {
    await editor(page);
    // The browser's own warning (closing the tab, reloading) is armed only while there are changes.
    const armed = () =>
      page.evaluate(() => {
        const e = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(e);
        return e.defaultPrevented;
      });
    expect(await armed()).toBe(false);
    await page.getByLabel('Title', { exact: true }).fill('Draft');
    expect(await armed()).toBe(true);

    // In-app navigation asks first.
    await page.getByRole('link', { name: 'Quizzes' }).click();
    const dialog = page.getByRole('dialog', { name: 'Leave without saving?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Keep editing' }).click();
    await expect(page).toHaveURL(/\/edit\?q=new/);
    await page.getByRole('link', { name: 'Quizzes' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Leave and lose changes' }).click();
    await expect(page).toHaveURL(/\/host$/);
  });

  test.describe('leaving with unsaved changes by other ways than a link', () => {
    const leaveDialog = (page: Page) => page.getByRole('dialog', { name: 'Leave without saving?' });
    const title = (page: Page) => page.getByLabel('Title', { exact: true });

    /** The dashboard, then a new quiz opened from its header, with `Draft` typed into the title. */
    async function draftFromDashboard(page: Page) {
      await editor(page, '/host');
      await page
        .getByRole('navigation', { name: 'Host' })
        .getByRole('link', { name: 'New quiz' })
        .click();
      await expect(page).toHaveURL(/\/edit\?q=new$/);
      await title(page).fill('Draft');
      await expect(page.getByRole('status').filter({ hasText: 'Unsaved changes' })).toBeVisible();
    }

    test('browser Back asks first; Keep editing restores the address and the edits', async ({
      page,
    }) => {
      await draftFromDashboard(page);
      await page.goBack();
      await expect(leaveDialog(page)).toBeVisible();
      await expect(page).toHaveURL(/\/edit\?q=new$/);
      await expect(page.getByRole('heading', { name: 'Your quizzes' })).toHaveCount(0);
      await leaveDialog(page).getByRole('button', { name: 'Keep editing' }).click();
      await expect(leaveDialog(page)).toBeHidden();
      await expect(page).toHaveURL(/\/edit\?q=new$/);
      await expect(title(page)).toHaveValue('Draft');
      await expect(page.getByRole('status').filter({ hasText: 'Unsaved changes' })).toBeVisible();

      // It asks every time, and never stacks history entries while doing so.
      const before = await page.evaluate(() => window.history.length);
      await page.goBack();
      await expect(leaveDialog(page)).toBeVisible();
      await leaveDialog(page).getByRole('button', { name: 'Keep editing' }).click();
      await expect(title(page)).toHaveValue('Draft');
      expect(await page.evaluate(() => window.history.length)).toBe(before);
    });

    test('browser Back with Leave and lose changes goes where Back goes; Forward finds a fresh editor', async ({
      page,
    }) => {
      await draftFromDashboard(page);
      await page.goBack();
      await leaveDialog(page).getByRole('button', { name: 'Leave and lose changes' }).click();
      await expect(page).toHaveURL(/\/host$/);
      await expect(page.getByRole('heading', { name: 'Your quizzes' })).toBeVisible();

      await page.goForward();
      await expect(page).toHaveURL(/\/edit\?q=new$/);
      await expect(title(page)).toHaveValue('');
      // Nothing to lose now, so Back does not ask.
      await page.goBack();
      await expect(page).toHaveURL(/\/host$/);
      await expect(leaveDialog(page)).toHaveCount(0);
    });

    test('browser Forward asks first, too', async ({ page }) => {
      await editor(page, '/host');
      await page
        .getByRole('navigation', { name: 'Host' })
        .getByRole('link', { name: 'New quiz' })
        .click();
      await page.getByRole('link', { name: 'Quizzes' }).click();
      await expect(page).toHaveURL(/\/host$/);
      await page.goBack();
      await expect(page).toHaveURL(/\/edit\?q=new$/);
      await title(page).fill('Forward test');

      await page.goForward();
      await expect(leaveDialog(page)).toBeVisible();
      await expect(page).toHaveURL(/\/edit\?q=new$/);
      await leaveDialog(page).getByRole('button', { name: 'Keep editing' }).click();
      await expect(title(page)).toHaveValue('Forward test');
    });

    test('Sign out asks first, and signs out only when the changes may be lost', async ({
      page,
    }) => {
      await draftFromDashboard(page);
      await page.getByRole('button', { name: 'Sign out' }).click();
      await expect(leaveDialog(page)).toBeVisible();
      await leaveDialog(page).getByRole('button', { name: 'Keep editing' }).click();
      await expect(title(page)).toHaveValue('Draft');
      expect(await page.evaluate(() => sessionStorage.getItem('zqhoot:host:auth'))).not.toBeNull();

      await page.getByRole('button', { name: 'Sign out' }).click();
      await leaveDialog(page).getByRole('button', { name: 'Leave and lose changes' }).click();
      await expect(page.getByRole('heading', { name: 'Host sign-in' })).toBeVisible();
      expect(await page.evaluate(() => sessionStorage.getItem('zqhoot:host:auth'))).toBeNull();
    });

    test('Sign out does not ask when nothing would be lost', async ({ page }) => {
      await editor(page);
      await page.getByRole('button', { name: 'Sign out' }).click();
      await expect(page.getByRole('heading', { name: 'Host sign-in' })).toBeVisible();
    });

    test('New quiz on an unsaved new quiz, confirmed, starts a blank one', async ({ page }) => {
      await editor(page);
      await title(page).fill('Draft A');
      await page.getByLabel('Question', { exact: true }).fill('A question I typed');
      // A save that is refused (the answers are empty) leaves the error list on screen.
      await page.getByRole('button', { name: 'Save quiz' }).first().click();
      await expect(page.getByTestId('error-summary')).toBeVisible();

      const link = page.getByRole('link', { name: 'New quiz' });
      await link.click();
      await expect(leaveDialog(page)).toBeVisible();
      await leaveDialog(page).getByRole('button', { name: 'Keep editing' }).click();
      await expect(title(page)).toHaveValue('Draft A');

      await link.click();
      await leaveDialog(page).getByRole('button', { name: 'Leave and lose changes' }).click();
      await expect(page).toHaveURL(/\/edit\?q=new$/);
      await expect(title(page)).toHaveValue('');
      await expect(page.getByLabel('Question', { exact: true })).toHaveValue('');
      // A fresh editor: nothing unsaved, no leftover error list, nothing to warn about.
      await expect(page.getByRole('status').filter({ hasText: 'Unsaved changes' })).toHaveCount(0);
      await expect(page.getByTestId('error-summary')).toHaveCount(0);
      await link.click();
      await expect(leaveDialog(page)).toHaveCount(0);
      await expect(title(page)).toHaveValue('');
    });
  });

  test.describe('focus stays in the editor after an action removes the control that had it', () => {
    const active = (page: Page) => page.locator(':focus');
    const focusIsOnBody = (page: Page) =>
      page.evaluate(() => document.activeElement === document.body || !document.activeElement);
    const order = (page: Page) =>
      page.locator('[data-question] [class*="preview"]').allTextContents();

    /** A quiz of three questions, each with a prompt the tests can tell apart. */
    async function threeQuestions(page: Page) {
      await editor(page);
      await fillFirstQuestion(page);
      for (const prompt of ['Second question', 'Third question']) {
        await page.getByLabel('New question type').selectOption({ label: 'Rating' });
        await page.getByRole('button', { name: 'Add question' }).click();
        await page.getByLabel('Question', { exact: true }).fill(prompt);
      }
      expect(await order(page)).toEqual([
        'Which planet is closest to the Sun?',
        'Second question',
        'Third question',
      ]);
    }

    test('Remove answer: the answer that took its place, or the one before when it was last', async ({
      page,
    }) => {
      await editor(page);
      await fillFirstQuestion(page);
      await page.getByRole('button', { name: 'Remove answer B' }).focus();
      await page.keyboard.press('Enter');
      // B is gone; what was C is B now, and holds focus.
      await expect(page.getByLabel('Answer B', { exact: true })).toHaveValue('Earth');
      await expect(page.locator('#f-questions-0-options-1-text')).toBeFocused();

      // Three answers left: removing the last one (C, which is Mars now) hands focus to the one before.
      await page.getByRole('button', { name: 'Remove answer C' }).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByLabel('Answer C', { exact: true })).toHaveCount(0);
      await expect(page.locator('#f-questions-0-options-1-text')).toBeFocused();
      // Two answers are the least, so Remove is gone; focus is on an answer, not on <body>.
      await expect(page.getByRole('button', { name: /^Remove answer/ })).toHaveCount(0);
      expect(await focusIsOnBody(page)).toBe(false);
    });

    test('Add answer: the new answer, also when it was the last one allowed', async ({ page }) => {
      await editor(page);
      await page.getByLabel('New question type').selectOption({ label: 'Poll' });
      await page.getByRole('button', { name: 'Add question' }).click();
      await page.getByRole('button', { name: 'Add answer' }).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByLabel('Answer E', { exact: true })).toBeFocused();
      await page.getByRole('button', { name: 'Add answer' }).focus();
      await page.keyboard.press('Enter');
      // Six is the most a poll takes, so Add answer is gone with its focus.
      await expect(page.getByRole('button', { name: 'Add answer' })).toHaveCount(0);
      await expect(page.getByLabel('Answer F', { exact: true })).toBeFocused();
    });

    test('Move up and Move down: focus stays on the same button of the moved card, also at either end', async ({
      page,
    }) => {
      await threeQuestions(page);
      const card = (n: number) => page.locator(`[data-question="${n}"]`);

      // Down from the top: the card is now second, and its Move down button still has focus.
      await page.getByRole('button', { name: 'Move down, question 1' }).focus();
      await page.keyboard.press('Enter');
      expect(await order(page)).toEqual([
        'Second question',
        'Which planet is closest to the Sun?',
        'Third question',
      ]);
      await expect(card(1).getByRole('button', { name: /^Move down/ })).toBeFocused();

      // Down again, to the end: it is the last card, so Move down is a no-op that keeps focus.
      await page.keyboard.press('Enter');
      expect(await order(page)).toEqual([
        'Second question',
        'Third question',
        'Which planet is closest to the Sun?',
      ]);
      const lastDown = card(2).getByRole('button', { name: /^Move down/ });
      await expect(lastDown).toBeFocused();
      await expect(lastDown).toHaveAttribute('aria-disabled', 'true');
      await page.keyboard.press('Enter');
      expect(await order(page)).toEqual([
        'Second question',
        'Third question',
        'Which planet is closest to the Sun?',
      ]);
      await expect(lastDown).toBeFocused();

      // Up, all the way to the top, on the same button.
      await card(2)
        .getByRole('button', { name: /^Move up/ })
        .focus();
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      expect(await order(page)).toEqual([
        'Which planet is closest to the Sun?',
        'Second question',
        'Third question',
      ]);
      const topUp = card(0).getByRole('button', { name: /^Move up/ });
      await expect(topUp).toBeFocused();
      await expect(topUp).toHaveAttribute('aria-disabled', 'true');
      await page.keyboard.press('Enter'); // still a no-op, and no error
      await expect(topUp).toBeFocused();
      expect(await order(page)).toHaveLength(3);
    });

    test('Delete question: the next card’s summary, or Add question after the last', async ({
      page,
    }) => {
      await threeQuestions(page);
      const confirm = async () => {
        await expect(page.getByRole('dialog', { name: 'Delete this question?' })).toBeVisible();
        await page.keyboard.press('Tab'); // Cancel has focus first, Delete question is next
        await page.keyboard.press('Enter');
      };

      // The middle one: the third question is second now, and its summary has focus.
      await page.getByRole('button', { name: 'Delete, question 2' }).focus();
      await page.keyboard.press('Enter');
      await confirm();
      expect(await order(page)).toEqual(['Which planet is closest to the Sun?', 'Third question']);
      await expect(active(page)).toHaveAttribute('data-focus', 'summary');
      await expect(active(page)).toContainText('Third question');

      // The last one has no next card: the control that adds one.
      await page.getByRole('button', { name: 'Delete, question 2' }).focus();
      await page.keyboard.press('Enter');
      await confirm();
      expect(await order(page)).toEqual(['Which planet is closest to the Sun?']);
      await expect(page.getByRole('button', { name: 'Add question' })).toBeFocused();
      expect(await focusIsOnBody(page)).toBe(false);
    });

    test('Remove image: focus goes to the file input, which stays', async ({ page }) => {
      await editor(page);
      await page.getByLabel('Image (optional)').focus();
      await page.getByLabel('Image (optional)').setInputFiles({
        name: 'planet.png',
        mimeType: 'image/png',
        buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      });
      await expect(preview(page)).toBeVisible();
      // The upload disables the input while it runs; it has focus again by now.
      await expect(page.getByLabel('Image (optional)')).toBeFocused();
      await page.getByRole('button', { name: 'Remove image' }).focus();
      await page.keyboard.press('Enter');
      await expect(preview(page)).toHaveCount(0);
      await expect(page.getByLabel('Image (optional)')).toBeFocused();
      expect(await focusIsOnBody(page)).toBe(false);
    });
  });

  test('an upload that ends after the questions were reordered lands on the question it was for', async ({
    page,
  }) => {
    const { api } = await editor(page);
    await fillFirstQuestion(page);
    await page.getByLabel('New question type').selectOption({ label: 'Rating' });
    await page.getByRole('button', { name: 'Add question' }).click();
    await page.getByLabel('Question', { exact: true }).fill('Second question');

    // Question 1 gets a picture, and while the grant is pending the host moves it down.
    await page.getByRole('button', { name: /Which planet is closest/ }).click();
    const release = api.hold('upload');
    await page.getByLabel('Image (optional)').setInputFiles({
      name: 'planet.png',
      mimeType: 'image/png',
      buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    });
    await expect.poll(() => api.calledWith('POST', '/api/media/uploads').length).toBe(1);
    await page.getByRole('button', { name: 'Move down, question 1' }).click();
    release();
    await expect(preview(page)).toBeVisible();

    await page.getByRole('button', { name: 'Save quiz' }).first().click();
    await expect(page).toHaveURL(/quiz-new-0001$/);
    const body = api.calledWith('POST', '/api/quizzes')[0]?.body as {
      questions: Array<{ prompt: string; imageKey?: string }>;
    };
    expect(body.questions.map((q) => [q.prompt, q.imageKey])).toEqual([
      ['Second question', undefined],
      ['Which planet is closest to the Sun?', 'media/host-abc/uploaded01.png'],
    ]);
  });

  test('edits typed while a save is in flight are kept, and show as unsaved', async ({ page }) => {
    const { api } = await editor(page);
    await fillFirstQuestion(page);
    const release = api.hold('save');
    await page.getByRole('button', { name: 'Save quiz' }).first().click();
    await expect.poll(() => api.calledWith('POST', '/api/quizzes').length).toBe(1);

    await page.getByLabel('Title', { exact: true }).fill('Planets, and their moons');
    release();
    await expect(page).toHaveURL(/quiz-new-0001$/);

    await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Planets, and their moons');
    await expect(page.getByRole('status').filter({ hasText: 'Unsaved changes' })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'All changes saved' })).toHaveCount(0);

    // Saving again sends the newer title on top of the version the first save created.
    await page.getByRole('button', { name: 'Save quiz' }).first().click();
    await expect(page.getByRole('status').filter({ hasText: 'All changes saved' })).toBeVisible();
    expect(api.calledWith('PUT', '/api/quizzes/quiz-new-0001').at(-1)?.body).toMatchObject({
      expectedVersion: 1,
      quiz: { title: 'Planets, and their moons' },
    });
  });

  test('moving the card above the open one keeps the same question open', async ({ page }) => {
    await editor(page);
    await fillFirstQuestion(page);
    await page.getByLabel('New question type').selectOption({ label: 'Rating' });
    await page.getByRole('button', { name: 'Add question' }).click();
    await page.getByLabel('Question', { exact: true }).fill('Second question');

    await page.getByRole('button', { name: 'Move down, question 1' }).click();
    await expect(page.getByLabel('Question', { exact: true })).toHaveValue('Second question');
    const order = await page.locator('[data-question] [class*="preview"]').allTextContents();
    expect(order).toEqual(['Second question', 'Which planet is closest to the Sun?']);
  });

  test('images: refuses SVG and oversized files before asking for a grant; uploads a PNG by PUT', async ({
    page,
  }) => {
    const { api } = await editor(page);
    const file = page.getByLabel('Image (optional)');
    await file.setInputFiles({
      name: 'evil.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from('<svg/>'),
    });
    await expect(
      page.getByRole('alert').filter({ hasText: 'PNG, JPEG, WebP or GIF' }),
    ).toBeVisible();
    await file.setInputFiles({
      name: 'big.png',
      mimeType: 'image/png',
      buffer: Buffer.alloc(5 * 1024 * 1024 + 1),
    });
    await expect(page.getByRole('alert').filter({ hasText: 'The limit is 5 MB' })).toBeVisible();
    expect(api.calledWith('POST', '/api/media/uploads')).toHaveLength(0);

    await file.setInputFiles({
      name: 'planet.png',
      mimeType: 'image/png',
      buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    });
    await expect(preview(page)).toBeVisible();
    expect(api.calledWith('POST', '/api/media/uploads')[0]?.body).toEqual({
      contentType: 'image/png',
      size: 8,
    });
    const [put] = api.calledWith('PUT', /\/api\/media\//);
    expect(put?.path).toBe('/api/media/media/host-abc/uploaded01.png');

    await fillFirstQuestion(page);
    await page.getByRole('button', { name: 'Save quiz' }).first().click();
    await expect(page).toHaveURL(/quiz-new-0001$/);
    const saved = (
      api.calledWith('POST', '/api/quizzes')[0]?.body as { questions: Array<{ imageKey?: string }> }
    ).questions[0];
    expect(saved?.imageKey).toBe('media/host-abc/uploaded01.png');

    // Remove image.
    await page.getByRole('button', { name: 'Remove image' }).click();
    await expect(preview(page)).toHaveCount(0);
  });

  test('a picture gets a description field with a counter; the preview and the saved quiz follow it', async ({
    page,
  }) => {
    const { api } = await editor(page);
    await fillFirstQuestion(page);
    // No picture, no description to write.
    await expect(page.getByLabel('Image description')).toHaveCount(0);
    await page.getByLabel('Image (optional)').setInputFiles({
      name: 'planet.png',
      mimeType: 'image/png',
      buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    });
    await expect(preview(page)).toBeVisible();
    const field = page.getByLabel('Image description');
    await expect(field).toBeVisible();
    await expect(field).toHaveAccessibleDescription(/if the question depends on it/);
    await expect(field).toHaveAccessibleDescription(/0 \/ 150/);
    // Undescribed, the preview is decoration: an empty alt, and no role to be announced by.
    await expect(preview(page)).toHaveAttribute('alt', '');

    await field.fill('A gas giant with a wide, bright ring system');
    await expect(field).toHaveAccessibleDescription(/43 \/ 150/);
    await expect(preview(page)).toHaveAttribute(
      'alt',
      'A gas giant with a wide, bright ring system',
    );

    await page.getByRole('button', { name: 'Save quiz' }).first().click();
    await expect(page).toHaveURL(/quiz-new-0001$/);
    const saved = (
      api.calledWith('POST', '/api/quizzes')[0]?.body as {
        questions: Array<{ imageKey?: string; imageAlt?: string }>;
      }
    ).questions[0];
    expect(saved).toMatchObject({
      imageKey: 'media/host-abc/uploaded01.png',
      imageAlt: 'A gas giant with a wide, bright ring system',
    });

    // Removing the picture takes the description with it, so the next save is still valid.
    await page.getByRole('button', { name: 'Remove image' }).click();
    await expect(page.getByLabel('Image description')).toHaveCount(0);
    await page.getByRole('button', { name: 'Save quiz' }).first().click();
    await expect(page.getByRole('status').filter({ hasText: 'All changes saved' })).toBeVisible();
    const put = api.calledWith('PUT', '/api/quizzes/quiz-new-0001').at(-1)?.body as {
      quiz: { questions: Array<Record<string, unknown>> };
    };
    expect(put.quiz.questions[0]).not.toHaveProperty('imageKey');
    expect(put.quiz.questions[0]).not.toHaveProperty('imageAlt');
  });

  test('a description over the limit is refused with a message on its own field', async ({
    page,
  }) => {
    const { api } = await editor(page);
    await fillFirstQuestion(page);
    await page.getByLabel('Image (optional)').setInputFiles({
      name: 'planet.png',
      mimeType: 'image/png',
      buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    });
    await page.getByLabel('Image description').fill('x'.repeat(151));
    await page.getByRole('button', { name: 'Save quiz' }).first().click();
    await expect(page.getByTestId('error-summary')).toContainText(
      'the image description can be at most 150 characters',
    );
    await expect(page.locator('#f-questions-0-imageAlt')).toHaveAttribute('aria-invalid', 'true');
    expect(api.calledWith('POST', '/api/quizzes')).toHaveLength(0);
  });
});
