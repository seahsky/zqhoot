import { expect, shot, test } from './cast.ts';
import { Control, signIn } from './host.ts';
import { Player } from './player.ts';
import { HOST_LOGIN } from './target.ts';

/** 21-character ids from the nanoid alphabet, as the editor makes them. */
const id = (tag: string) => tag.padEnd(21, 'x');

test('a kicked player sees why, and cannot get back in', async ({ cast, request }) => {
  // The quiz is not what this test is about, so it is made through the API.
  const login = await request.post('/api/auth/login', { data: HOST_LOGIN });
  const { token } = (await login.json()) as { token: string };
  const auth = { Authorization: `Bearer ${token}` };
  const quiz = await request.post('/api/quizzes', {
    headers: auth,
    data: {
      title: 'Kick suite quiz',
      settings: { streakBonus: false, showQuestionOnDevices: true, readSeconds: 0 },
      questions: [
        {
          id: id('kq1'),
          type: 'single',
          prompt: 'Pick the first one',
          options: [
            { id: id('kq1a'), text: 'First' },
            { id: id('kq1b'), text: 'Second' },
          ],
          correctOptionId: id('kq1a'),
          points: 1,
          timeLimitSec: 10,
        },
      ],
    },
  });
  expect(quiz.ok()).toBe(true);
  const { id: quizId } = (await quiz.json()) as { id: string };
  const created = await request.post('/api/sessions', { headers: auth, data: { quizId } });
  expect(created.ok()).toBe(true);
  const { sessionId, pin } = (await created.json()) as { sessionId: string; pin: string };

  const hostActor = await cast.open('host', { viewport: { width: 1366, height: 768 } });
  const kitActor = await cast.open('kit', {
    viewport: { width: 390, height: 844 },
    device: 'iPhone 14',
  });
  const louActor = await cast.open('lou', {
    viewport: { width: 390, height: 844 },
    device: 'iPhone 14',
  });
  const kit = new Player(kitActor, 'P1', 'Kit');
  const lou = new Player(louActor, 'P2', 'Lou');
  const control = new Control(hostActor.page);

  await signIn(hostActor.page, `/host/live?s=${sessionId}`);
  await expect(hostActor.page.getByText('Waiting to start', { exact: true })).toBeVisible();

  for (const p of [kit, lou]) {
    await p.openJoin(pin, 'link');
    await p.submitNickname(p.nickname);
    await p.expectJoined();
  }
  await expect(hostActor.page.getByText('2 players, 2 connected', { exact: true })).toBeVisible();

  // What the phone holds now is what a copied or restored session would try to use later.
  const stored = await kit.page.evaluate(() => sessionStorage.getItem('zqhoot:session'));
  expect(stored, 'the phone keeps its credentials').not.toBeNull();

  await control.kick('Kit');

  await test.step('the phone says the host removed the player', async () => {
    await expect(kit.page.getByRole('heading', { level: 1 })).toHaveText(/removed you/i);
    await shot(kit.page, 'kick-removed');
  });

  await test.step('the host roster no longer lists the player, and the other one stays', async () => {
    await expect(hostActor.page.getByText('1 player, 1 connected', { exact: true })).toBeVisible();
    await expect(hostActor.page.getByRole('button', { name: 'Kick Kit' })).toHaveCount(0);
    await expect(hostActor.page.getByRole('button', { name: 'Kick Lou' })).toBeVisible();
    await expect(lou.page.getByRole('heading', { level: 1 })).not.toHaveText(/removed/i);
  });

  await test.step('reloading does not bring the player back', async () => {
    await kit.page.reload();
    // The credentials were cleared with the removal, so there is nothing to resume with.
    await kit.page.waitForURL(/\/join/);
    await expect(kit.page.locator('input[name="pin"]')).toBeVisible();
    expect(await kit.page.evaluate(() => sessionStorage.getItem('zqhoot:session'))).toBeNull();
  });

  await test.step('the old credentials are refused by the server too', async () => {
    const thief = await cast.open('replay', {
      viewport: { width: 390, height: 844 },
      device: 'iPhone 14',
    });
    await thief.context.addInitScript((creds) => {
      sessionStorage.setItem('zqhoot:session', creds);
    }, stored as string);
    await thief.page.goto(`/play?s=${sessionId}`);
    await expect(thief.page.getByRole('heading', { level: 1 })).toHaveText(/removed you/i);
    await expect(hostActor.page.getByText('1 player, 1 connected', { exact: true })).toBeVisible();
  });

  expect(cast.pageErrors()).toEqual([]);
});
