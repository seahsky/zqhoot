import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { skipsHorizontalScrollCheck } from '../src/dev/manifest.ts';

/**
 * No axe rule is disabled. If one ever has to be, list it in DISABLED_RULES with the reason
 * and repeat the reason in the task report.
 */
export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
export const DISABLED_RULES: Array<{ id: string; reason: string }> = [];

export async function openScreen(page: Page, id: string) {
  await page.goto(`/dev/gallery?screen=${id}`);
  // `attached`, not visible: the presenter stage is `position: fixed`, so its wrapper has no box.
  await page.locator(`[data-gallery-screen="${id}"]`).waitFor({ state: 'attached' });
  // The system font stack needs no download, but layout must be settled before measuring.
  await page.evaluate(() => document.fonts.ready);
  // Fades and slides are finite; measure and photograph the state they end in. Images (the
  // QR code, a question picture) are data URLs, so decoding them is quick but not instant.
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
    await Promise.all([...document.images].map((img) => img.decode().catch(() => undefined)));
  });
}

/**
 * The page must not scroll sideways. The measure is the layout viewport's own width
 * (`documentElement.clientWidth`), never `window.innerWidth`: with mobile emulation an
 * over-wide page inflates `innerWidth` to fit it (1280 for a 320 px phone), so a comparison
 * against it can never fail on a phone or tablet.
 */
export async function expectNoHorizontalScroll(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  // The measure is only honest while the layout viewport is the project's own width (a scrollbar
  // may take a few pixels of it). If emulation ever widens it, fail loudly instead of passing.
  const viewport = page.viewportSize();
  if (viewport) {
    expect(clientWidth, 'the layout viewport is the width of the project viewport').toBeGreaterThan(
      viewport.width - 24,
    );
    expect(clientWidth).toBeLessThanOrEqual(viewport.width);
  }
  expect(
    scrollWidth,
    `horizontal scroll: the page is ${scrollWidth}px wide in a ${clientWidth}px viewport`,
  ).toBeLessThanOrEqual(clientWidth);
}

/** axe, horizontal scroll, and a full-page screenshot under `e2e/screenshots/{shotDir}/`. */
export async function checkScreen(page: Page, id: string, shotDir: string) {
  await openScreen(page, id);

  const results = await new AxeBuilder({ page })
    .withTags(AXE_TAGS)
    .disableRules(DISABLED_RULES.map((r) => r.id))
    .analyze();
  const report = results.violations
    .map(
      (v) =>
        `${v.id} (${v.impact}): ${v.help}\n${v.nodes.map((n) => `  ${n.target.join(' ')}`).join('\n')}`,
    )
    .join('\n');
  expect(results.violations, report).toEqual([]);

  if (!skipsHorizontalScrollCheck(id)) await expectNoHorizontalScroll(page);

  await page.screenshot({ path: `e2e/screenshots/${shotDir}/${id}.png`, fullPage: true });
}
