import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { MATRIX_SCREENS } from '../src/dev/manifest.ts';
import { checkScreen, openScreen } from './helpers.ts';

/**
 * User-preference passes. They run on the phone-390 project only (playwright.config.ts):
 * the rules are about the person's settings, not the viewport, so one phone width is enough
 * to catch a regression.
 *
 * The settings are applied with page.emulateMedia(). Setting reducedMotion, forcedColors or
 * contrast through test.use() is silently ignored by Playwright 1.56 here (matchMedia stays
 * false), so each pass also asserts that its media query really matches.
 */
interface Pass {
  name: string;
  media: Parameters<Page['emulateMedia']>[0];
  query: string;
}

const PASSES: Pass[] = [
  {
    name: 'reduced-motion',
    media: { reducedMotion: 'reduce' },
    query: '(prefers-reduced-motion: reduce)',
  },
  { name: 'dark', media: { colorScheme: 'dark' }, query: '(prefers-color-scheme: dark)' },
  { name: 'forced-colors', media: { forcedColors: 'active' }, query: '(forced-colors: active)' },
  { name: 'high-contrast', media: { contrast: 'more' }, query: '(prefers-contrast: more)' },
];

for (const pass of PASSES) {
  test.describe(`preference: ${pass.name}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia(pass.media);
    });

    for (const { id } of MATRIX_SCREENS) {
      test(id, async ({ page }, testInfo) => {
        await checkScreen(page, id, `${testInfo.project.name}-${pass.name}`);
        const active = await page.evaluate((q) => matchMedia(q).matches, pass.query);
        expect(active, `${pass.query} should match`).toBe(true);
      });
    }
  });
}

test.describe('preferences change the design, not just the media query', () => {
  const rootVar = (page: Page, name: string) =>
    page.evaluate(
      (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
      name,
    );

  test('reduced motion hides the countdown bar and removes its transition', async ({ page }) => {
    await openScreen(page, 'play-answer-single');
    await expect(page.getByTestId('countdown-bar')).toBeVisible();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.getByTestId('countdown-bar')).toBeHidden();
    await expect(page.getByRole('timer')).toHaveText('14'); // the numeral remains
  });

  test('high contrast makes secondary text ink and thickens outlines', async ({ page }) => {
    await openScreen(page, 'play-answer-single');
    expect(await rootVar(page, '--ink-2')).toBe('#3a4258');
    expect(await rootVar(page, '--outline-w')).toBe('3px');
    await page.emulateMedia({ contrast: 'more' });
    expect(await rootVar(page, '--ink-2')).toBe(await rootVar(page, '--ink'));
    expect(await rootVar(page, '--surface')).toBe(await rootVar(page, '--bg'));
    expect(await rootVar(page, '--outline-w')).toBe('4px');
  });

  test('the dark stage follows the phone, and ?theme= pins it either way', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await openScreen(page, 'play-lobby');
    expect(await rootVar(page, '--bg')).toBe('#0b1020');

    await page.goto('/dev/gallery?screen=play-lobby&theme=light');
    await page.locator('[data-gallery-screen]').waitFor();
    expect(await rootVar(page, '--bg')).toMatch(/^#(fff|ffffff)$/);

    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/dev/gallery?screen=play-lobby&theme=dark');
    await page.locator('[data-gallery-screen]').waitFor();
    expect(await rootVar(page, '--bg')).toBe('#0b1020');
  });

  test('every answer option is at least 72px tall and every control 48px', async ({ page }) => {
    for (const id of ['play-answer-single', 'play-answer-poll-6', 'play-answer-rating']) {
      await openScreen(page, id);
      const small = await page.evaluate(() =>
        [...document.querySelectorAll('button, a[href], input, textarea')]
          .map((el) => ({ el: el as HTMLElement, box: el.getBoundingClientRect() }))
          .filter(({ box }) => box.width < 48 || box.height < 48)
          .map(({ el }) => el.outerHTML.slice(0, 80)),
      );
      expect(small, id).toEqual([]);
    }
    await openScreen(page, 'play-answer-single-long');
    const rows = await page
      .locator('button:has(svg)')
      .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
    expect(rows).toHaveLength(4);
    for (const h of rows) expect(h).toBeGreaterThanOrEqual(72);
  });
});
