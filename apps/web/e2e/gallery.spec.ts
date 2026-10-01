import { expect, test } from '@playwright/test';
import { MATRIX_SCREENS, SCREENS } from '../src/dev/manifest.ts';
import { checkScreen, expectNoHorizontalScroll, openScreen } from './helpers.ts';

/**
 * Every screen of the app, in every project: axe (WCAG 2.0 A/AA through 2.2 AA), no
 * horizontal scroll (presenter screens excepted), and a full-page screenshot for humans to
 * look at.
 */
test.describe('gallery matrix', () => {
  for (const { id } of MATRIX_SCREENS) {
    test(id, async ({ page }, testInfo) => {
      await checkScreen(page, id, testInfo.project.name);
    });
  }
});

/**
 * A check that cannot fail proves nothing (the first version compared with `innerWidth`,
 * which mobile emulation inflates). `test-overflow` holds an element wider than every
 * viewport, so the same check must reject it in every project, phone-320 included.
 */
test.describe('the horizontal-scroll check can fail', () => {
  test('rejects a deliberately over-wide element', async ({ page }) => {
    await openScreen(page, 'test-overflow');
    await expect(expectNoHorizontalScroll(page)).rejects.toThrow(/horizontal scroll/);
  });

  test('accepts a screen that fits, in the same project', async ({ page }) => {
    await openScreen(page, 'play-lobby');
    await expectNoHorizontalScroll(page);
  });
});

test.describe('gallery index', () => {
  test('lists every screen', async ({ page }) => {
    await page.goto('/dev/gallery');
    for (const { id } of SCREENS) {
      await expect(page.locator(`[data-screen-link="${id}"]`)).toBeVisible();
    }
  });
});
