import { expect, test } from '@playwright/test';
import { SCREENS } from '../src/dev/manifest.ts';
import { checkScreen } from './helpers.ts';

/**
 * Every registered gallery screen, in every project: axe (WCAG 2.0 A/AA through 2.2 AA),
 * no horizontal scroll, and a full-page screenshot for humans to look at.
 */
test.describe('gallery matrix', () => {
  for (const { id } of SCREENS) {
    test(id, async ({ page }, testInfo) => {
      await checkScreen(page, id, testInfo.project.name);
    });
  }
});

test.describe('gallery index', () => {
  test('lists every screen', async ({ page }) => {
    await page.goto('/dev/gallery');
    for (const { id } of SCREENS) {
      await expect(page.locator(`[data-screen-link="${id}"]`)).toBeVisible();
    }
  });
});
