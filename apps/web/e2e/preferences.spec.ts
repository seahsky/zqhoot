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

/**
 * A field in error is drawn with one heavier border. It used to be the normal border plus an
 * inset shadow, and two anti-aliased rounded edges beside each other show as a double line at
 * the corners, most of all with more contrast. The padding gives back what the border takes,
 * so the text does not move when a field becomes invalid.
 */
test.describe('an invalid field is drawn with one border', () => {
  const MEDIA: Array<[string, Parameters<Page['emulateMedia']>[0]]> = [
    ['normal', {}],
    ['high-contrast', { contrast: 'more' }],
    ['forced-colors', { forcedColors: 'active' }],
  ];

  /** Gets each screen into the state with an invalid field. */
  const SCREENS: Array<[string, (page: Page) => Promise<void>]> = [
    ['join-pin-error', async () => undefined],
    ['join-nickname-error', async () => undefined],
    ['host-login-error', async () => undefined],
    ['edit-errors', async () => undefined],
    [
      'play-answer-wordcloud',
      async (page) => {
        await page.getByRole('button', { name: 'Send' }).click();
        await expect(page.locator('input[aria-invalid="true"]')).toBeVisible();
      },
    ],
    [
      'play-answer-open',
      async (page) => {
        await page.getByRole('button', { name: 'Send' }).click();
        await expect(page.locator('textarea[aria-invalid="true"]')).toBeVisible();
      },
    ],
  ];

  for (const [medium, media] of MEDIA) {
    for (const [id, reach] of SCREENS) {
      test(`${id}, ${medium}`, async ({ page }, testInfo) => {
        await page.emulateMedia(media);
        await openScreen(page, id);
        await reach(page);
        const fields = await page.evaluate(() => {
          const root = getComputedStyle(document.documentElement);
          const outline = parseFloat(root.getPropertyValue('--outline-w'));
          const rem = parseFloat(root.fontSize);
          return [
            ...document.querySelectorAll<HTMLElement>(
              'input[aria-invalid="true"], textarea[aria-invalid="true"], select[aria-invalid="true"]',
            ),
          ].map((el) => {
            const s = getComputedStyle(el);
            const px = (v: string) => parseFloat(v);
            return {
              tag: el.tagName.toLowerCase(),
              shadow: s.boxShadow,
              // The four borders, then border + padding on each axis.
              borders: [
                s.borderTopWidth,
                s.borderRightWidth,
                s.borderBottomWidth,
                s.borderLeftWidth,
              ].map(px),
              outline,
              vertical: px(s.borderTopWidth) + px(s.paddingTop),
              horizontal: px(s.borderLeftWidth) + px(s.paddingLeft),
              rem,
            };
          });
        });
        expect(fields.length, `${id} has a field in error`).toBeGreaterThan(0);
        for (const f of fields) {
          expect(f.shadow, `${f.tag}: no inset shadow beside the border`).toBe('none');
          // One border, three pixels heavier than a field's normal one, on every side.
          expect(f.borders, f.tag).toEqual([
            f.outline + 3,
            f.outline + 3,
            f.outline + 3,
            f.outline + 3,
          ]);
          // Border plus padding is what a normal field has, so the text stays where it was.
          expect(f.vertical, `${f.tag}: vertical`).toBeCloseTo(f.outline + 0.75 * f.rem, 1);
          expect(f.horizontal, `${f.tag}: horizontal`).toBeCloseTo(f.outline + f.rem, 1);
        }
        await page.screenshot({
          path: `e2e/screenshots/${testInfo.project.name}-invalid-${medium}/${id}.png`,
          fullPage: true,
        });
      });
    }
  }

  test('a field does not change size when it becomes invalid', async ({ page }) => {
    await openScreen(page, 'play-answer-wordcloud');
    const field = page.getByLabel('Your word or short phrase');
    const before = await field.boundingBox();
    const inner = () =>
      field.evaluate((el) => {
        const s = getComputedStyle(el as HTMLElement);
        return el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
      });
    const contentBefore = await inner();
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    const after = await field.boundingBox();
    expect(after?.width).toBe(before?.width);
    expect(after?.height).toBe(before?.height);
    // Content width only shrinks by the extra 3 px of border on each side, given back by padding.
    expect(await inner()).toBeCloseTo(contentBefore, 0);
  });
});
