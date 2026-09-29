import { expect, test } from '@playwright/test';
import type { Page, WebSocketRoute } from '@playwright/test';

/**
 * The join and play containers against a scripted server, in a real browser: real
 * WebSocket, real sessionStorage, real timers. No server exists yet, so the network is
 * mocked with Playwright's route and routeWebSocket.
 */

const SESSION = 'session-demo-01';
const PLAYER = 'player-riley-01';
const TOKEN = 'T'.repeat(43);
const PLANET = {
  id: 'question-planet',
  type: 'single',
  prompt: 'Which planet is closest to the Sun?',
  timeLimitSec: 20,
  points: 1,
  options: [
    { id: 'option-mercury', text: 'Mercury' },
    { id: 'option-venus', text: 'Venus' },
  ],
} as const;

type Msg = Record<string, unknown> & { type: string };

class ScriptedServer {
  readonly sockets: WebSocketRoute[] = [];
  readonly received: Msg[] = [];
  /** Called for every client message; reply with `send`. */
  onClient: (msg: Msg, ws: WebSocketRoute) => void = () => undefined;

  async attach(page: Page) {
    await page.route('**/config.json', (route) =>
      route.fulfill({
        json: {
          target: 'vm',
          apiBaseUrl: '',
          wsUrl: 'ws://localhost:4173/ws',
          mediaBaseUrl: '/',
          joinUrl: 'http://localhost:4173/join',
          auth: { mode: 'local' },
        },
      }),
    );
    await page.routeWebSocket('ws://localhost:4173/ws', (ws) => {
      this.sockets.push(ws);
      ws.onMessage((raw) => {
        const msg = JSON.parse(String(raw)) as Msg;
        this.received.push(msg);
        this.onClient(msg, ws);
      });
    });
  }

  /** Every server message carries the server's clock, stamped as it is sent. */
  send(ws: WebSocketRoute, msg: Record<string, unknown>) {
    ws.send(JSON.stringify({ ts: Date.now(), ...msg }));
  }

  get last(): WebSocketRoute {
    const ws = this.sockets.at(-1);
    if (!ws) throw new Error('no socket yet');
    return ws;
  }

  clientMessages(type: string) {
    return this.received.filter((m) => m.type === type);
  }
}

function snapshot(over: Record<string, unknown> = {}) {
  return {
    sv: 1,
    sessionId: SESSION,
    quizTitle: 'Friday night trivia',
    phase: 'lobby',
    questionIndex: -1,
    totalQuestions: 5,
    you: { playerId: PLAYER, nickname: 'Riley', score: 0, rank: null, streak: 0 },
    ...over,
  };
}

async function mockLookup(page: Page, body: Record<string, unknown> | number = {}) {
  await page.route('**/api/join/*', (route) =>
    typeof body === 'number'
      ? route.fulfill({ status: body, json: { error: 'not-found', message: 'No such game.' } })
      : route.fulfill({
          json: { sessionId: SESSION, quizTitle: 'Friday night trivia', joinable: true, ...body },
        }),
  );
}

/** Answers `join` with credentials and `resume` with a snapshot. */
function playerServer(server: ScriptedServer, phaseSnapshot: () => Record<string, unknown>) {
  server.onClient = (msg, ws) => {
    if (msg.type === 'join') {
      server.send(ws, {
        type: 'welcome',
        role: 'player',
        credentials: { sessionId: SESSION, playerId: PLAYER, token: TOKEN },
        snapshot: snapshot(),
      });
    } else if (msg.type === 'resume') {
      server.send(ws, { type: 'welcome', role: 'player', snapshot: phaseSnapshot() });
    }
  };
}

/** A device that already joined: sessionStorage holds the credentials, as after `/join`. */
async function withCredentials(page: Page) {
  await page.addInitScript(
    ([session, player, token]) => {
      if (!sessionStorage.getItem('zqhoot:session')) {
        sessionStorage.setItem(
          'zqhoot:session',
          JSON.stringify({ sessionId: session, playerId: player, token, savedAt: Date.now() }),
        );
      }
    },
    [SESSION, PLAYER, TOKEN],
  );
}

const ESSAY = {
  id: 'question-essay',
  type: 'open',
  prompt: 'What would you change about the office?',
  timeLimitSec: 120,
  maxEntries: 1,
} as const;

test.describe('join and play against a scripted server', () => {
  test('PIN, nickname, welcome, then a whole question round', async ({ page }) => {
    const server = new ScriptedServer();
    await server.attach(page);
    await mockLookup(page);
    let phase = snapshot();
    playerServer(server, () => phase);

    await page.goto('/join?pin=123456');
    await expect(page.getByLabel('Game PIN')).toHaveValue('123456');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByRole('heading', { name: 'Pick a nickname' })).toBeVisible();
    await expect(page.getByText('Friday night trivia')).toBeVisible();
    await expect(page.getByLabel('Nickname')).toBeFocused();
    await page.getByLabel('Nickname').fill('Riley');
    await page.getByRole('button', { name: 'Join' }).click();

    // join went out once, with the PIN and nickname; then the app moved to /play and resumed.
    await expect(page).toHaveURL(/\/play\?s=session-demo-01$/);
    await expect(page.getByRole('heading', { name: /You're in/ })).toBeVisible();
    expect(server.clientMessages('join')).toEqual([
      { type: 'join', v: 1, pin: '123456', nickname: 'Riley' },
    ]);
    expect(server.clientMessages('resume')).toEqual([
      { type: 'resume', v: 1, sessionId: SESSION, playerId: PLAYER, token: TOKEN },
    ]);
    const stored = await page.evaluate(() => sessionStorage.getItem('zqhoot:session'));
    expect(JSON.parse(stored!)).toMatchObject({
      sessionId: SESSION,
      playerId: PLAYER,
      token: TOKEN,
    });
    expect(
      await page.evaluate(() => localStorage.getItem('zqhoot:session:session-demo-01')),
    ).not.toBeNull();

    // A question with a short count-in: options are inert, then open at the same instant.
    const now = Date.now();
    server.send(server.last, {
      type: 'question',
      sv: 2,
      index: 0,
      total: 5,
      question: PLANET,
      openAt: now + 1_500,
      deadline: now + 1_500 + 20_000,
    });
    await expect(page.getByText(/Get ready: options open in/)).toBeVisible();
    const venus = page.getByRole('button', { name: /Venus/ });
    await expect(venus).toBeDisabled();
    await expect(venus).toBeEnabled({ timeout: 5_000 });
    await expect(page.getByRole('timer')).toBeVisible();

    server.onClient = (msg, ws) => {
      if (msg.type === 'answer')
        server.send(ws, { type: 'answer.ack', index: 0, status: 'accepted', entries: 1 });
    };
    await venus.click();
    await expect(page.getByRole('heading', { name: 'Answer locked in' })).toBeVisible();
    expect(server.clientMessages('answer')).toEqual([
      { type: 'answer', questionIndex: 0, payload: { kind: 'choice', optionId: 'option-venus' } },
    ]);
    await expect(page.getByRole('button', { name: /Venus/ })).toHaveCount(0);

    phase = snapshot({ sv: 2 });
    server.send(server.last, {
      type: 'reveal',
      sv: 3,
      index: 0,
      result: {
        type: 'single',
        answered: 4,
        totalPlayers: 5,
        correctOptionId: 'option-venus',
        counts: { 'option-mercury': 1, 'option-venus': 3 },
      },
      you: {
        answered: true,
        correct: true,
        points: 870,
        streakBonus: 0,
        score: 870,
        rank: 2,
        streak: 1,
      },
    });
    await expect(page.getByRole('heading', { name: 'Correct, +870' })).toBeVisible();
    await expect(page.getByText('2nd place')).toBeVisible();
    await expect(page.getByText('870 points', { exact: true })).toBeVisible();

    server.send(server.last, {
      type: 'leaderboard',
      sv: 4,
      index: 0,
      entries: [],
      you: { score: 870, rank: 2, behind: { nickname: 'Kim', points: 120 } },
    });
    await expect(
      page.getByRole('heading', { name: "You're 2nd, 120 points behind Kim" }),
    ).toBeVisible();

    server.send(server.last, {
      type: 'ended',
      sv: 5,
      podium: [{ playerId: 'player-ana-001', nickname: 'Ana', score: 900, rank: 1, delta: 0 }],
      totalPlayers: 5,
      you: { score: 870, rank: 2, correct: 1, answeredScored: 1, scoredQuestions: 1 },
    });
    await expect(page.getByRole('heading', { name: 'You finished 2nd' })).toBeVisible();
    // The game is over, so the credentials go (ADR-0008).
    await expect
      .poll(() => page.evaluate(() => sessionStorage.getItem('zqhoot:session')))
      .toBeNull();
    expect(
      await page.evaluate(() => localStorage.getItem('zqhoot:session:session-demo-01')),
    ).toBeNull();
  });

  test('joining still works when the browser blocks storage', async ({ page }) => {
    await page.addInitScript(() => {
      Storage.prototype.setItem = () => {
        throw new DOMException('blocked', 'QuotaExceededError');
      };
      Storage.prototype.getItem = () => null;
    });
    const server = new ScriptedServer();
    await server.attach(page);
    await mockLookup(page);
    playerServer(server, () => snapshot());

    await page.goto('/join?pin=123456');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Nickname').fill('Riley');
    await page.getByRole('button', { name: 'Join' }).click();
    await expect(page).toHaveURL(/\/play\?s=session-demo-01$/);
    await expect(page.getByRole('heading', { name: /You're in/ })).toBeVisible();
    expect(server.clientMessages('resume')).toHaveLength(1);
  });

  test('a reload mid-question resumes and shows the answer that is already locked in', async ({
    page,
  }) => {
    const server = new ScriptedServer();
    await server.attach(page);
    const now = Date.now();
    playerServer(server, () =>
      snapshot({
        sv: 7,
        phase: 'question',
        questionIndex: 0,
        question: { question: PLANET, openAt: now - 2_000, deadline: now + 60_000 },
        responses: [{ kind: 'choice', optionId: 'option-mercury' }],
      }),
    );
    await page.addInitScript(
      ([session, player, token]) => {
        if (!sessionStorage.getItem('zqhoot:session')) {
          sessionStorage.setItem(
            'zqhoot:session',
            JSON.stringify({ sessionId: session, playerId: player, token, savedAt: Date.now() }),
          );
        }
      },
      [SESSION, PLAYER, TOKEN],
    );

    await page.goto('/play?s=session-demo-01');
    await expect(page.getByRole('heading', { name: 'Answer locked in' })).toBeVisible();
    await expect(page.getByText('Mercury')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Answer locked in' })).toBeVisible();
    expect(server.clientMessages('resume')).toHaveLength(2);
    expect(server.clientMessages('answer')).toHaveLength(0);
  });

  test('a dropped connection shows Reconnecting… without losing the screen, then resumes', async ({
    page,
  }) => {
    const server = new ScriptedServer();
    await server.attach(page);
    const now = Date.now();
    playerServer(server, () =>
      snapshot({
        phase: 'question',
        questionIndex: 0,
        question: { question: PLANET, openAt: now - 1_000, deadline: now + 60_000 },
      }),
    );
    await page.addInitScript(
      ([session, player, token]) =>
        sessionStorage.setItem(
          'zqhoot:session',
          JSON.stringify({ sessionId: session, playerId: player, token, savedAt: Date.now() }),
        ),
      [SESSION, PLAYER, TOKEN],
    );
    await page.goto('/play?s=session-demo-01');
    await expect(page.getByRole('button', { name: /Mercury/ })).toBeEnabled();

    await server.last.close({ code: 1006 });
    await expect(page.getByRole('status').filter({ hasText: 'Reconnecting…' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Mercury/ })).toBeVisible(); // screen kept
    await expect.poll(() => server.clientMessages('resume').length, { timeout: 15_000 }).toBe(2);
    await expect(page.getByRole('status').filter({ hasText: 'Reconnecting…' })).toHaveCount(0);
  });

  test('word cloud entries keep the same field, until the limit closes it', async ({ page }) => {
    const server = new ScriptedServer();
    await server.attach(page);
    const now = Date.now();
    const cloud = {
      id: 'question-cloud',
      type: 'wordcloud',
      prompt: 'Describe this week in one word.',
      timeLimitSec: 60,
      maxEntries: 2,
    };
    let confirmed = 0;
    server.onClient = (msg, ws) => {
      if (msg.type === 'resume') {
        server.send(ws, {
          type: 'welcome',
          role: 'player',
          snapshot: snapshot({
            phase: 'question',
            questionIndex: 0,
            question: { question: cloud, openAt: now - 1_000, deadline: now + 60_000 },
          }),
        });
      } else if (msg.type === 'answer') {
        confirmed += 1;
        server.send(ws, { type: 'answer.ack', index: 0, status: 'accepted', entries: confirmed });
      }
    };
    await page.addInitScript(
      ([session, player, token]) =>
        sessionStorage.setItem(
          'zqhoot:session',
          JSON.stringify({ sessionId: session, playerId: player, token, savedAt: Date.now() }),
        ),
      [SESSION, PLAYER, TOKEN],
    );
    await page.goto('/play?s=session-demo-01');

    const field = page.getByLabel('Your word or short phrase');
    await field.fill('sunny');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('Thanks, your response is in.', { exact: true })).toBeVisible();
    await expect(field).toBeFocused(); // same field, ready for the next entry
    await expect(field).toHaveValue('');
    await expect(page.getByRole('list', { name: 'Your responses so far' })).toContainText('sunny');

    await field.fill('busy');
    await field.press('Enter');
    await expect(page.getByRole('heading', { name: 'Thanks, your response is in' })).toBeVisible();
    await expect(field).toHaveCount(0); // limit reached: no more entries
    expect(server.clientMessages('answer').map((m) => m.payload)).toEqual([
      { kind: 'text', text: 'sunny' },
      { kind: 'text', text: 'busy' },
    ]);
  });

  test('a tap while the socket is down is not sent and says so', async ({ page }) => {
    const server = new ScriptedServer();
    await server.attach(page);
    const now = Date.now();
    playerServer(server, () =>
      snapshot({
        phase: 'question',
        questionIndex: 0,
        question: { question: PLANET, openAt: now - 1_000, deadline: now + 60_000 },
      }),
    );
    await page.addInitScript(
      ([session, player, token]) =>
        sessionStorage.setItem(
          'zqhoot:session',
          JSON.stringify({ sessionId: session, playerId: player, token, savedAt: Date.now() }),
        ),
      [SESSION, PLAYER, TOKEN],
    );
    await page.goto('/play?s=session-demo-01');
    await expect(page.getByRole('button', { name: /Venus/ })).toBeEnabled();

    // Refuse the reconnection so the socket stays down while we tap.
    await page.routeWebSocket('ws://localhost:4173/ws', (ws) => ws.close({ code: 1006 }));
    await server.last.close({ code: 1006 });
    await expect(page.getByRole('status').filter({ hasText: 'Reconnecting…' })).toBeVisible();
    await page.getByRole('button', { name: /Venus/ }).click();
    await expect(page.getByRole('status').filter({ hasText: 'not sent' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Venus/ })).toBeEnabled();
    expect(server.clientMessages('answer')).toHaveLength(0);
  });

  test('a typed answer stays in the field when the socket is down at send time', async ({
    page,
  }) => {
    const server = new ScriptedServer();
    await server.attach(page);
    const now = Date.now();
    playerServer(server, () =>
      snapshot({
        phase: 'question',
        questionIndex: 0,
        question: { question: ESSAY, openAt: now - 1_000, deadline: now + 120_000 },
      }),
    );
    await withCredentials(page);
    await page.goto('/play?s=session-demo-01');
    const field = page.getByLabel('Your response');
    await expect(field).toBeEnabled();

    await page.routeWebSocket('ws://localhost:4173/ws', (ws) => ws.close({ code: 1006 }));
    await server.last.close({ code: 1006 });
    await expect(page.getByRole('status').filter({ hasText: 'Reconnecting…' })).toBeVisible();

    const draft = 'Quieter desks, and a window that opens.';
    await field.fill(draft);
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'not sent' })).toBeVisible();
    await expect(field).toHaveValue(draft);
    expect(server.clientMessages('answer')).toHaveLength(0);
  });

  test('an answer the server refuses comes back into the field', async ({ page }) => {
    const server = new ScriptedServer();
    await server.attach(page);
    const now = Date.now();
    let refuse = true;
    server.onClient = (msg, ws) => {
      if (msg.type === 'resume') {
        server.send(ws, {
          type: 'welcome',
          role: 'player',
          snapshot: snapshot({
            phase: 'question',
            questionIndex: 0,
            question: { question: ESSAY, openAt: now - 1_000, deadline: now + 120_000 },
          }),
        });
      } else if (msg.type === 'answer') {
        server.send(
          ws,
          refuse
            ? { type: 'answer.ack', index: 0, status: 'rejected', entries: 0, reason: 'invalid' }
            : { type: 'answer.ack', index: 0, status: 'accepted', entries: 1 },
        );
      }
    };
    await withCredentials(page);
    await page.goto('/play?s=session-demo-01');

    const draft = 'Quieter desks, and a window that opens.';
    await page.getByLabel('Your response').fill(draft);
    await page.getByRole('button', { name: 'Send' }).click();

    // One entry allowed: the screen showed "locked in" until the refusal, then the field is back.
    await expect(page.getByRole('status').filter({ hasText: "wasn't accepted" })).toBeVisible();
    await expect(page.getByLabel('Your response')).toHaveValue(draft);

    refuse = false;
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('heading', { name: 'Thanks, your response is in' })).toBeVisible();
    expect(server.clientMessages('answer').map((m) => m.payload)).toEqual([
      { kind: 'text', text: draft },
      { kind: 'text', text: draft },
    ]);
  });

  test('a protocol-version refusal stops reconnecting and asks for a reload', async ({ page }) => {
    const server = new ScriptedServer();
    await server.attach(page);
    let stale = true;
    server.onClient = (msg, ws) => {
      if (msg.type !== 'resume') return;
      if (stale) {
        server.send(ws, {
          type: 'error',
          code: 'protocol-version',
          message: 'This server needs protocol version 2.',
          ref: 'resume',
        });
        void ws.close({ code: 1002 });
      } else {
        server.send(ws, { type: 'welcome', role: 'player', snapshot: snapshot() });
      }
    };
    await withCredentials(page);
    await page.goto('/play?s=session-demo-01');

    await expect(page.getByRole('heading', { name: 'This page is out of date' })).toBeVisible();
    // A reconnect would follow within a second or so (full jitter, first attempts).
    await page.waitForTimeout(2_500);
    expect(server.clientMessages('resume')).toHaveLength(1);
    await expect(page.getByRole('status').filter({ hasText: 'Reconnecting…' })).toHaveCount(0);
    // The player is still in the game: the credentials are kept for the reload.
    expect(await page.evaluate(() => sessionStorage.getItem('zqhoot:session'))).not.toBeNull();

    stale = false;
    await page.getByRole('button', { name: 'Reload' }).click();
    await expect(page.getByRole('heading', { name: /You're in/ })).toBeVisible();
    expect(server.clientMessages('resume')).toHaveLength(2);
  });

  test('being kicked shows the notice and forgets the credentials', async ({ page }) => {
    const server = new ScriptedServer();
    await server.attach(page);
    playerServer(server, () => snapshot());
    await page.addInitScript(
      ([session, player, token]) =>
        sessionStorage.setItem(
          'zqhoot:session',
          JSON.stringify({ sessionId: session, playerId: player, token, savedAt: Date.now() }),
        ),
      [SESSION, PLAYER, TOKEN],
    );
    await page.goto('/play?s=session-demo-01');
    await expect(page.getByRole('heading', { name: /You're in/ })).toBeVisible();
    server.send(server.last, { type: 'kicked' });
    await expect(
      page.getByRole('heading', { name: 'The host removed you from this game' }),
    ).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => sessionStorage.getItem('zqhoot:session')))
      .toBeNull();
  });

  test('/play without credentials goes to /join', async ({ page }) => {
    const server = new ScriptedServer();
    await server.attach(page);
    await page.goto('/play');
    await expect(page).toHaveURL(/\/join$/);
    await expect(page.getByRole('heading', { name: 'Enter the game PIN' })).toBeVisible();
  });

  test('a taken nickname is announced inline and focus returns to the field', async ({ page }) => {
    const server = new ScriptedServer();
    await server.attach(page);
    await mockLookup(page);
    server.onClient = (msg, ws) => {
      if (msg.type === 'join') {
        server.send(ws, { type: 'error', code: 'nickname-taken', message: 'taken', ref: 'join' });
      }
    };
    await page.goto('/join?pin=123456');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Nickname').fill('Kim');
    await page.getByRole('button', { name: 'Join' }).click();

    const alert = page.getByRole('alert');
    await expect(alert).toContainText('already has that nickname');
    await expect(page.getByLabel('Nickname')).toBeFocused();
    await expect(page.getByLabel('Nickname')).toHaveAttribute('aria-invalid', 'true');
    const describedBy = await page.getByLabel('Nickname').getAttribute('aria-describedby');
    expect(describedBy).toContain((await alert.getAttribute('id'))!);
    await expect(page).toHaveURL(/\/join/);
  });

  test('an unknown PIN is announced inline, and a locked game is refused', async ({ page }) => {
    const server = new ScriptedServer();
    await server.attach(page);
    await mockLookup(page, 404);
    await page.goto('/join?pin=000000');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('alert')).toContainText('No game has that PIN');
    await expect(page.getByLabel('Game PIN')).toBeFocused();

    await page.unroute('**/api/join/*');
    await mockLookup(page, { joinable: false, reason: 'locked' });
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('alert')).toContainText("isn't letting new players in");
  });

  test('the PIN field takes digits only, at most six', async ({ page }) => {
    await new ScriptedServer().attach(page);
    await page.goto('/join');
    const pin = page.getByLabel('Game PIN');
    await expect(pin).toHaveAttribute('inputmode', 'numeric');
    await expect(pin).toHaveAttribute('autocomplete', 'off');
    await pin.fill('12ab34-5678');
    await expect(pin).toHaveValue('123456');
  });

  test('landing links go to /join and /host', async ({ page }) => {
    await new ScriptedServer().attach(page);
    await page.goto('/');
    await page.getByRole('link', { name: 'Join a game' }).click();
    await expect(page).toHaveURL(/\/join$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await page.getByRole('link', { name: 'Host a game' }).click();
    await expect(page).toHaveURL(/\/host$/);
  });
});
