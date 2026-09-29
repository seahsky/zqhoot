import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  HOST_PIN,
  hostSnapshot,
  openQ,
  openResponses,
  roster,
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
    const bar = page.getByRole('toolbar', { name: 'Presenter controls' });
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
    await expect(page.getByRole('img', { name: /Preview of this question/ })).toBeVisible();

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
    await expect(page.getByRole('img', { name: /Preview of this question/ })).toBeVisible();
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
    await expect(page.getByRole('img', { name: /Preview of this question/ })).toHaveCount(0);
  });
});
