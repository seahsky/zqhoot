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
  await page.locator(`[data-gallery-screen="${id}"]`).waitFor();
  // The system font stack needs no download, but layout must be settled before measuring.
  await page.evaluate(() => document.fonts.ready);
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

  if (!skipsHorizontalScrollCheck(id)) {
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(overflow.scrollWidth, 'horizontal scroll').toBeLessThanOrEqual(overflow.innerWidth);
  }

  await page.screenshot({ path: `e2e/screenshots/${shotDir}/${id}.png`, fullPage: true });
}
