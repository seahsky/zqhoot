import { fileURLToPath } from 'node:url';
import { devices, test as base } from '@playwright/test';
import type { Browser, BrowserContext, Page, TestInfo } from '@playwright/test';
import { BASE_URL, TARGET } from './target.ts';

/**
 * One browser context per person in the room, each with its own viewport (and, for the phones,
 * touch and a mobile user agent). A context has its own cookies and storage, so two players
 * never share credentials the way two tabs would.
 */

export interface Actor {
  name: string;
  context: BrowserContext;
  page: Page;
  /** Taps on touch devices, clicks elsewhere. */
  touch: boolean;
  /** Uncaught exceptions of the page, for the end of the test to assert on. */
  errors: string[];
  /** Every WebSocket frame the pages exchanged, oldest first, kept for a failure report. */
  frames: string[];
}

export interface ActorOptions {
  viewport: { width: number; height: number };
  device?: 'iPhone SE' | 'iPhone 14';
}

/** The descriptors name WebKit as their default browser; only Chromium is installed here. */
function withoutBrowser(descriptor: (typeof devices)[string]) {
  const { defaultBrowserType: _webkit, ...options } = descriptor;
  return options;
}

export class Cast {
  private readonly actors: Actor[] = [];

  constructor(private readonly browser: Browser) {}

  async open(name: string, o: ActorOptions): Promise<Actor> {
    const phone = o.device ? withoutBrowser(devices[o.device]) : {};
    const context = await this.browser.newContext({
      baseURL: BASE_URL,
      ...phone,
      viewport: o.viewport,
    });
    const page = await context.newPage();
    const actor: Actor = {
      name,
      context,
      page,
      touch: o.device !== undefined,
      errors: [],
      frames: [],
    };
    const started = Date.now();
    const log = (arrow: string, payload: string | Buffer) =>
      actor.frames.push(
        `${String(Date.now() - started).padStart(7)} ${arrow} ${String(payload).slice(0, 400)}`,
      );
    // A popup (the presenter opened from the host page) is watched like any other page.
    const watch = (p: Page) => {
      p.on('pageerror', (e) => actor.errors.push(`${name}: ${e.message}`));
      p.on('websocket', (ws) => {
        ws.on('framesent', (f) => log('>', f.payload));
        ws.on('framereceived', (f) => log('<', f.payload));
        ws.on('close', () => log('x', 'closed'));
      });
    };
    watch(page);
    context.on('page', watch);
    this.actors.push(actor);
    return actor;
  }

  /** Every uncaught page error of every actor so far. */
  pageErrors(): string[] {
    return this.actors.flatMap((a) => a.errors);
  }

  async snapshotAll(info: TestInfo): Promise<void> {
    for (const a of this.actors) {
      await info.attach(`frames-${a.name}.log`, {
        body: a.frames.join('\n'),
        contentType: 'text/plain',
      });
      for (const [i, page] of a.context.pages().entries()) {
        await page
          .screenshot({ path: info.outputPath(`failure-${a.name}-${i}.png`), timeout: 5000 })
          .catch(() => undefined);
      }
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all(this.actors.map((a) => a.context.close().catch(() => undefined)));
  }
}

export const test = base.extend<{ cast: Cast }>({
  cast: async ({ browser }, use, testInfo) => {
    const cast = new Cast(browser);
    await use(cast);
    if (testInfo.status !== testInfo.expectedStatus) await cast.snapshotAll(testInfo);
    await cast.closeAll();
  },
});

export { expect } from '@playwright/test';

/** `screenshots/{target}/`, next to this file. */
const SHOT_ROOT = fileURLToPath(new URL(`./screenshots/${TARGET}/`, import.meta.url));

/** A picture of one page at a key moment, once its finite animations have run out. */
export async function shot(page: Page, name: string): Promise<void> {
  await page.evaluate(() =>
    Promise.race([
      Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))),
      new Promise((done) => setTimeout(done, 2000)),
    ]),
  );
  await page.screenshot({ path: `${SHOT_ROOT}${name}.png` });
}
