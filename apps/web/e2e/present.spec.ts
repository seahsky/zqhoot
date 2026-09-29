import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { SCREENS } from '../src/dev/manifest.ts';
import { OPEN_QUESTION_COUNTS } from '../src/dev/fixtures/present.ts';
import { openScreen } from './helpers.ts';

/**
 * The presenter's stage (ADR-0016): the same composition at every size, nothing outside the
 * 16:9 box, no text spilling out of its container, and no answer before the reveal. Runs on one
 * project (playwright.config.ts) and sets its own viewports.
 */

const PRESENT = SCREENS.filter((s) => s.group === 'present').map((s) => s.id as string);
const SIZES = [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
  { width: 3840, height: 2160 },
];

/** Elements a person cannot see (clipped to a pixel, or `display: none`) cannot overflow. */
const HIDDEN_HELPERS = `
  const hidden = (el) => {
    for (let a = el; a; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.display === 'none' || cs.visibility === 'hidden') return true;
      const b = a.getBoundingClientRect();
      if (b.width <= 1 && b.height <= 1 && cs.overflow === 'hidden') return true;
    }
    return false;
  };
`;

async function stageBox(page: Page) {
  return page.locator('[data-testid="stage"]').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
}

/** Elements inside the stage whose box leaves the stage's. */
async function outsideStage(page: Page): Promise<string[]> {
  return page.evaluate(`(() => {
    ${HIDDEN_HELPERS}
    const stage = document.querySelector('[data-testid="stage"]');
    const r = stage.getBoundingClientRect();
    const out = [];
    for (const el of stage.querySelectorAll('*')) {
      if (el.closest('dialog:not([open])') || hidden(el)) continue;
      const b = el.getBoundingClientRect();
      if (b.width === 0 && b.height === 0) continue;
      const tol = 1;
      if (b.left < r.left - tol || b.top < r.top - tol || b.right > r.right + tol || b.bottom > r.bottom + tol) {
        out.push(el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0] + ' ' +
          JSON.stringify({ l: Math.round(b.left - r.left), t: Math.round(b.top - r.top), r: Math.round(b.right - r.right), b: Math.round(b.bottom - r.bottom) }) +
          ' "' + (el.textContent || '').trim().slice(0, 30) + '"');
      }
    }
    return out;
  })()`);
}

/**
 * Elements of the screen that leave the stage's content area, the stage minus its 5% padding.
 * Text that lands in the bottom margin sits under the control bar. The running header and the
 * answer count live in the top margin on purpose (`position: absolute`), so they are skipped.
 */
async function outsideContent(page: Page): Promise<string[]> {
  return page.evaluate(`(() => {
    ${HIDDEN_HELPERS}
    const stage = document.querySelector('[data-testid="stage"]');
    const r = stage.getBoundingClientRect();
    const u = r.height / 100;
    const box = { l: r.left + 8.889 * u, r: r.right - 8.889 * u, t: r.top + 5 * u, b: r.bottom - 5 * u };
    const out = [];
    for (const el of stage.querySelector('main').querySelectorAll('*')) {
      if (getComputedStyle(el).position === 'absolute' || hidden(el)) continue;
      const b = el.getBoundingClientRect();
      if (b.width === 0 && b.height === 0) continue;
      const tol = 1.5;
      if (b.left < box.l - tol || b.top < box.t - tol || b.right > box.r + tol || b.bottom > box.b + tol) {
        out.push(el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0] + ' ' +
          JSON.stringify({ l: Math.round(b.left - box.l), t: Math.round(b.top - box.t), r: Math.round(b.right - box.r), b: Math.round(b.bottom - box.b) }) +
          ' "' + (el.textContent || '').trim().slice(0, 30) + '"');
      }
    }
    return out;
  })()`);
}

/** The control bar's "Text size" button steps 100%, 125%, 150% and round again. */
async function setTextSize(page: Page, percent: 100 | 125 | 150) {
  const button = page.getByRole('button', { name: /^Text size/ });
  for (let i = 0; i < 3 && !(await button.innerText()).includes(`${percent}%`); i++) {
    await button.click();
  }
  await expect(button).toHaveText(`Text size ${percent}%`);
  // The layout follows on the next frame.
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done(null))));
}

/**
 * Text that does not fit where it was put: a text node whose box leaves an ancestor's box
 * sideways, or an element that scrolls or clips its own text (ellipsis included).
 */
async function overflowingText(page: Page): Promise<string[]> {
  return page.evaluate(`(() => {
    ${HIDDEN_HELPERS}
    const stage = document.querySelector('[data-testid="stage"]');
    const out = [];
    const walker = document.createTreeWalker(stage, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.textContent || '').trim();
      const el = node.parentElement;
      if (!text || !el || el.closest('dialog:not([open])') || hidden(el)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const t = range.getBoundingClientRect();
      for (let a = el; a && a !== stage.parentElement; a = a.parentElement) {
        const b = a.getBoundingClientRect();
        if (t.left < b.left - 1.5 || t.right > b.right + 1.5) {
          out.push('sideways: "' + text.slice(0, 40) + '" leaves <' + a.tagName.toLowerCase() + ' class="' + a.className + '">');
          break;
        }
      }
      if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
        out.push('scrolls sideways: "' + text.slice(0, 40) + '"');
      }
      // A line box can be a little shorter than its glyphs (line-height 1); a quarter of the font
      // size of slack keeps that from counting as text spilling out.
      const slack = 0.25 * parseFloat(getComputedStyle(el).fontSize);
      if (el.scrollHeight > el.clientHeight + slack && el.clientHeight > 0) {
        out.push('scrolls down: "' + text.slice(0, 40) + '"');
      }
    }
    return out;
  })()`);
}

for (const size of SIZES) {
  test.describe(`the stage at ${size.width}x${size.height}`, () => {
    test.use({ viewport: size });

    for (const id of PRESENT) {
      test(`${id}: 16:9, centred, and everything inside it`, async ({ page }) => {
        await openScreen(page, id);
        const box = await stageBox(page);
        expect(Math.abs(box.width / box.height - 16 / 9), 'aspect ratio').toBeLessThan(0.005);
        expect(Math.abs(box.x + box.width / 2 - size.width / 2), 'horizontal centre').toBeLessThan(
          1.5,
        );
        expect(Math.abs(box.y + box.height / 2 - size.height / 2), 'vertical centre').toBeLessThan(
          1.5,
        );
        expect(await outsideStage(page)).toEqual([]);
      });
    }

    for (const id of ['present-lobby-400', 'present-question-long']) {
      test(`${id}: no text overflows its container`, async ({ page }) => {
        await openScreen(page, id);
        expect(await overflowingText(page)).toEqual([]);
      });

      // The dense layouts sit on their size floors at 100%, so the text-size control has to
      // give room from somewhere else, not push the content into the bottom margin.
      for (const percent of [125, 150] as const) {
        test(`${id} at ${percent}%: inside the content area, and no text overflows`, async ({
          page,
        }) => {
          await openScreen(page, id);
          await setTextSize(page, percent);
          expect(await outsideStage(page)).toEqual([]);
          expect(await outsideContent(page)).toEqual([]);
          expect(await overflowingText(page)).toEqual([]);
        });
      }
    }
  });
}

// Every other screen at every text size, on the two sizes that are cheap to render; the
// dense pair above also runs at 3840.
for (const size of SIZES.slice(0, 2)) {
  test.describe(`text size on the stage at ${size.width}x${size.height}`, () => {
    test.use({ viewport: size });

    for (const id of PRESENT.filter((p) => p !== 'present-help')) {
      test(`${id}: nothing leaves the content area at 100%, 125% and 150%`, async ({ page }) => {
        await openScreen(page, id);
        for (const percent of [100, 125, 150] as const) {
          await setTextSize(page, percent);
          expect(await outsideContent(page), `${percent}%`).toEqual([]);
        }
      });
    }
  });
}

test.describe('the stage in a window that is not 16:9', () => {
  test('is letterboxed and centred in a tall and in a wide window', async ({ page }) => {
    for (const size of [
      { width: 1000, height: 1000 },
      { width: 2400, height: 800 },
    ]) {
      await page.setViewportSize(size);
      await openScreen(page, 'present-lobby');
      const box = await stageBox(page);
      expect(Math.abs(box.width / box.height - 16 / 9)).toBeLessThan(0.005);
      expect(box.width).toBeLessThanOrEqual(size.width + 0.5);
      expect(box.height).toBeLessThanOrEqual(size.height + 0.5);
      expect(Math.abs(box.x + box.width / 2 - size.width / 2)).toBeLessThan(1.5);
      expect(Math.abs(box.y + box.height / 2 - size.height / 2)).toBeLessThan(1.5);
    }
  });

  test('uses the same composition at every size: text is a fixed share of the stage height', async ({
    page,
  }) => {
    const shares: number[] = [];
    for (const size of SIZES) {
      await page.setViewportSize(size);
      await openScreen(page, 'present-lobby');
      const pin = await page.getByTestId('pin').evaluate((el) => el.getBoundingClientRect().height);
      const box = await stageBox(page);
      shares.push(pin / box.height);
    }
    expect(Math.max(...shares) - Math.min(...shares)).toBeLessThan(0.01);
    // The PIN is 10u: about a tenth of the stage.
    expect(shares[0]).toBeGreaterThan(0.09);
    expect(shares[0]).toBeLessThan(0.13);
  });
});

test.describe('the room never sees the answer before the reveal', () => {
  for (const id of ['present-question-open', 'present-question-image', 'present-question-long']) {
    test(`${id}: no answer mark, no chart, options indistinguishable`, async ({ page }) => {
      await openScreen(page, id);
      const text = await page.evaluate(() => document.body.textContent ?? '');
      expect(text).not.toMatch(/correct/i);
      expect(await page.locator('table, [role="img"]').count()).toBe(0);

      const html = (await page.content()).replace(/style="[^"]*"/g, '');
      for (const secret of [
        'option-mercury',
        'option-saturn',
        'option-long-b',
        'correctOptionId',
      ]) {
        expect(html, secret).not.toContain(secret);
      }

      // Every option card looks and is built the same: no border, badge, colour or attribute
      // singles one out.
      const signatures = await page.$$eval('[data-option]', (els) =>
        els.map((el) => {
          const cs = getComputedStyle(el);
          return JSON.stringify({
            attrs: el.getAttributeNames().sort(),
            cls: el.className,
            look: [
              cs.borderTopWidth,
              cs.borderTopStyle,
              cs.borderTopColor,
              cs.backgroundColor,
              cs.color,
              cs.fontWeight,
              cs.outlineWidth,
            ],
            inner: [...el.querySelectorAll('*')].map((c) => c.tagName + c.getAttribute('class')),
          });
        }),
      );
      expect(signatures.length).toBeGreaterThanOrEqual(4);
      expect(new Set(signatures).size).toBe(1);
    });
  }

  test('present-question-open: the live distribution in the fixture is not on screen', async ({
    page,
  }) => {
    await openScreen(page, 'present-question-open');
    const text = await page.evaluate(() => document.body.textContent ?? '');
    for (const n of Object.values(OPEN_QUESTION_COUNTS)) {
      expect(text, `count ${n}`).not.toMatch(new RegExp(`\\b${n}\\b`));
    }
    // Visible text only: the closed help dialog lists "100%, 125%, 150%" for the text-size key.
    expect(
      await page.getByTestId('stage').evaluate((el) => (el as HTMLElement).innerText),
    ).not.toContain('%');
    // What the room does see: how many have answered, out of how many.
    await expect(page.getByTestId('answer-count')).toHaveText('377 / 400 answered');
  });

  test('the reveal does show the answer, so the check above can fail', async ({ page }) => {
    await openScreen(page, 'present-reveal-single');
    await expect(page.locator('[class*="badge"]', { hasText: 'Correct' })).toBeVisible();
    expect(await page.locator('table').count()).toBe(1);
  });
});

test.describe('charts and motion', () => {
  test('every chart has a hidden table and a status line', async ({ page }) => {
    for (const id of [
      'present-reveal-single',
      'present-reveal-truefalse',
      'present-reveal-poll',
      'present-wordcloud',
      'present-open',
      'present-rating',
    ]) {
      await openScreen(page, id);
      const table = page.locator('table').first();
      await expect(table, id).toHaveCount(1);
      expect(await table.locator('caption').textContent(), id).toBeTruthy();
      const status = page.getByRole('status').filter({ hasText: /\S/ });
      expect(await status.count(), id).toBeGreaterThan(0);
    }
  });

  test('a reveal is a bar for every option: label, count, percent, correct badge, thick outline', async ({
    page,
  }) => {
    await openScreen(page, 'present-reveal-single');
    await expect(page.getByText('A · Mercury · 14 · 47%')).toBeVisible();
    await expect(page.getByText('B · Venus · 9 · 30%')).toBeVisible();
    await expect(page.locator('[class*="badge"]', { hasText: 'Correct' })).toHaveCount(1);
    const widths = await page
      .locator('li:has([class*="track"]) [class*="_fill_"]')
      .evaluateAll((els) => els.map((e) => getComputedStyle(e).borderTopWidth));
    const [correct, ...others] = widths.map(parseFloat);
    for (const w of others) expect(correct as number).toBeGreaterThan(w);
  });

  test('reduced motion hides the countdown bar and keeps the numeral', async ({ page }) => {
    await openScreen(page, 'present-question-open');
    await expect(page.getByTestId('stage-countdown-bar')).toBeVisible();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.getByTestId('stage-countdown-bar')).toBeHidden();
    await expect(page.getByText('14', { exact: true })).toBeVisible();
  });

  test('the dark stage keeps the same composition', async ({ page }) => {
    await openScreen(page, 'present-reveal-single');
    const light = await stageBox(page);
    await page.goto('/dev/gallery?screen=present-reveal-single&theme=dark');
    await page.locator('[data-gallery-screen]').waitFor({ state: 'attached' });
    expect(await stageBox(page)).toEqual(light);
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
      ),
    ).toBe('#0b1020');
  });

  test('the wall of responses pages, and a page holds only what fits', async ({ page }) => {
    await openScreen(page, 'present-open');
    await expect(page.getByText('Page 1 of 2')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(page.getByText('Page 2 of 2')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Next page' })).toBeDisabled();
    expect(await outsideStage(page)).toEqual([]);
    // Pending and hidden responses never reach the wall, on either page.
    const text = await page.evaluate(() => document.body.textContent ?? '');
    expect(text).not.toContain('Karaoke');
    expect(text).not.toContain('A long walk and a proper lunch');
  });
});
