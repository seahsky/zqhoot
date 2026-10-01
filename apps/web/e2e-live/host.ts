import { expect } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { PHASE_LABEL } from '../src/screens/host/format.ts';
import { HOST_LOGIN } from './target.ts';
import { QUESTIONS, limitSec } from './plan.ts';
import type { Q } from './plan.ts';

/** Signs in with the local form, wherever the host was sent when signed out. */
export async function signIn(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.getByLabel('Username').fill(HOST_LOGIN.username);
  await page.getByLabel('Password').fill(HOST_LOGIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // The form goes away once the token is in; the page the host asked for takes its place.
  await expect(page.getByLabel('Password')).toHaveCount(0);
}

/** A bearer token for the same account, for reading back what the pages did. */
export async function apiToken(request: APIRequestContext): Promise<string> {
  const login = await request.post('/api/auth/login', { data: HOST_LOGIN });
  expect(login.ok(), 'API login').toBe(true);
  return ((await login.json()) as { token: string }).token;
}

const letter = (i: number) => String.fromCharCode(65 + i);

async function fillQuestion(page: Page, i: number, q: Q): Promise<void> {
  const field = (path: string) => page.locator(`#f-questions-${i}-${path}`);
  await field('prompt').fill(q.prompt);

  switch (q.kind) {
    case 'single': {
      for (const [j, text] of q.options.entries()) await field(`options-${j}-text`).fill(text);
      await field('correctOptionId')
        .getByRole('radio', { name: new RegExp(`^${letter(q.correct)} ·`) })
        .check();
      break;
    }
    case 'truefalse':
      await field('correct')
        .getByRole('radio', { name: q.correct ? 'True' : 'False' })
        .check();
      break;
    case 'poll': {
      // A new poll starts with four options; this one has three.
      for (let extra = 4; extra > q.options.length; extra--) {
        await page.getByRole('button', { name: `Remove answer ${letter(extra - 1)}` }).click();
      }
      for (const [j, text] of q.options.entries()) await field(`options-${j}-text`).fill(text);
      break;
    }
    case 'wordcloud':
      await field('maxEntries').selectOption(String(q.maxEntries));
      break;
    case 'rating':
      await field('max').selectOption(String(q.max));
      await field('minLabel').fill(q.minLabel);
      await field('maxLabel').fill(q.maxLabel);
      break;
  }

  await field('timeLimitSec').selectOption(String(limitSec(q)));
  if ((q.kind === 'single' || q.kind === 'truefalse') && q.multiplier === 2) {
    await field('points').selectOption('2');
  }
}

/**
 * Builds the whole quiz in the editor, as a host would, from the dashboard's "New quiz" link to
 * the saved page. Returns the id the server gave it.
 */
export async function buildQuizInEditor(page: Page, title: string): Promise<string> {
  await page.getByRole('main').getByRole('link', { name: 'New quiz' }).click();
  await expect(page.locator('#f-title')).toBeVisible();
  await page.locator('#f-title').fill(title);
  // The shortest reading time; the server still holds the options back by its own minimum.
  await page.locator('#f-settings-readSeconds').selectOption('0');

  for (const [i, q] of QUESTIONS.entries()) {
    if (i > 0) {
      await page.getByLabel('New question type').selectOption(q.kind);
      await page.getByRole('button', { name: 'Add question' }).click();
    }
    await fillQuestion(page, i, q);
  }

  await page.getByRole('button', { name: 'Save quiz' }).first().click();
  await expect(page.getByText('All changes saved')).toBeVisible();
  // A new quiz's URL is replaced with its id once it is saved.
  await page.waitForURL(/\/edit\?q=(?!new)[\w-]+$/);
  return new URL(page.url()).searchParams.get('q') as string;
}

export type NextLabel = 'Start' | 'End question' | 'Leaderboard' | 'Next question' | 'Finish';

/** The live control page of a session. */
export class Control {
  constructor(readonly page: Page) {}

  /** The six digits players type, read off the screen. */
  async pin(): Promise<string> {
    const text = await this.page
      .locator('strong')
      .filter({ hasText: /^\d{3} \d{3}$/ })
      .innerText();
    return text.replace(/\s/g, '');
  }

  sessionId(): string {
    return new URL(this.page.url()).searchParams.get('s') as string;
  }

  async next(label: NextLabel): Promise<void> {
    await this.page.getByRole('button', { name: label, exact: true }).click();
  }

  /** The status chip the host reads to see where the game is. */
  async expectPhase(phase: keyof typeof PHASE_LABEL): Promise<void> {
    await expect(this.page.getByText(PHASE_LABEL[phase], { exact: true })).toBeVisible();
  }

  async kick(nickname: string): Promise<void> {
    await this.page.getByRole('button', { name: `Kick ${nickname}` }).click();
    await this.page.getByRole('button', { name: 'Remove player' }).click();
  }
}
