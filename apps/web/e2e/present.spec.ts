import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { SCREENS } from '../src/dev/manifest.ts';
import { names } from '../src/dev/fixtures/hostSnapshots.ts';
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
 * Text that lands in the bottom margin sits under the control bar. Nothing is skipped but
 * `position: absolute` overlays (the reconnecting pill): the running header and the answer count
 * are in the flow, inside the top safe area.
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

    test('present-lobby-400: at least 60 names are on the wall, newest first, the rest counted', async ({
      page,
    }) => {
      await openScreen(page, 'present-lobby-400');
      const chips = page.getByTestId('name-wall').locator('li');
      const texts = await chips.allInnerTexts();
      const last = texts.at(-1) ?? '';
      const more = /^\+([\d,]+) more$/.exec(last);
      expect(more, `the last chip says "${last}"`).not.toBeNull();
      const shown = texts.slice(0, -1);
      expect(shown.length, 'names on the wall').toBeGreaterThanOrEqual(60);
      expect(shown.length + Number((more as RegExpExecArray)[1]!.replace(',', ''))).toBe(400);
      // The fixture's roster is in join order; the wall starts with the newest.
      expect(shown).toEqual(names(400).reverse().slice(0, shown.length));

      // Every name is whole, on screen and inside the wall: nothing is clipped or ellipsised.
      const wall = await page.getByTestId('name-wall').boundingBox();
      const stage = await stageBox(page);
      const boxes = await chips.evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          return {
            text: el.textContent,
            right: r.right,
            bottom: r.bottom,
            clipped: el.scrollWidth > el.clientWidth,
          };
        }),
      );
      for (const box of boxes) {
        expect(box.clipped, box.text ?? '').toBe(false);
        expect(box.right, box.text ?? '').toBeLessThanOrEqual(wall!.x + wall!.width + 1);
        expect(box.bottom, box.text ?? '').toBeLessThanOrEqual(stage.y + stage.height + 1);
      }
      await page.screenshot({
        path: `e2e/screenshots/present-lobby-400/${size.width}x${size.height}.png`,
      });
    });

    test('present-lobby: a room of 22 shows everyone in the biggest type', async ({ page }) => {
      await openScreen(page, 'present-lobby');
      const chips = page.getByTestId('name-wall').locator('li');
      await expect(chips).toHaveCount(22);
      expect(await chips.allInnerTexts()).toEqual(names(22).reverse());
      const fontU = await chips
        .first()
        .evaluate(
          (el) =>
            parseFloat(getComputedStyle(el).fontSize) /
            (document.querySelector('[data-testid="stage"]')!.getBoundingClientRect().height / 100),
        );
      expect(fontU).toBeCloseTo(5, 1);
    });

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
    await expect(page.getByTestId('answer-count')).toHaveText('377 of 400 answered');
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
    await expect(page.getByText('A · Mercury · 10 · 50%')).toBeVisible();
    await expect(page.getByText('B · Venus · 6 · 30%')).toBeVisible();
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

// ---------------------------------------------------------------------------------------------
// Findings of the visual check (V1): safe area, one wording, outlines that scale, the wall's
// room, the help dialog and the control bar. Each runs at the sizes it sets itself.
// ---------------------------------------------------------------------------------------------

/** Pixels per stage unit: the stage is 100u tall. */
async function unitPx(page: Page): Promise<number> {
  return (await stageBox(page)).height / 100;
}

const COUNT_SCREENS = [
  'present-question-open',
  'present-question-image',
  'present-question-long',
  'present-reveal-single',
  'present-reveal-truefalse',
  'present-reveal-poll',
  'present-wordcloud',
  'present-open',
  'present-rating',
];
const HEADER_SCREENS = ['present-get-ready', ...COUNT_SCREENS];
const ANSWERED = /^[\d,]+ of [\d,]+ answered$/;

const SMALL_STAGES = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1366, height: 768 },
];

for (const size of SIZES) {
  test.describe(`the running header at ${size.width}x${size.height}`, () => {
    test.use({ viewport: size });

    for (const id of HEADER_SCREENS) {
      test(`${id}: question number and answer count sit inside the top safe area`, async ({
        page,
      }) => {
        await openScreen(page, id);
        const stage = await stageBox(page);
        const u = stage.height / 100;
        const eyebrow = await page.locator('[class*="_eyebrow_"]').boundingBox();
        expect(eyebrow, 'eyebrow').not.toBeNull();
        // The stage pads its top by 5u, like the side gutter; the lobby and the boards start there.
        expect(eyebrow!.y - stage.y, 'eyebrow, from the top edge').toBeGreaterThanOrEqual(4.9 * u);
        expect(eyebrow!.x - stage.x, 'eyebrow, from the left edge').toBeGreaterThanOrEqual(8.8 * u);
        const counts = page.getByTestId('answer-count');
        if (id === 'present-get-ready') {
          await expect(counts).toHaveCount(0);
          return;
        }
        const count = await counts.boundingBox();
        expect(count!.y - stage.y, 'count, from the top edge').toBeGreaterThanOrEqual(4.9 * u);
        expect(
          stage.x + stage.width - (count!.x + count!.width),
          'count, from the right edge',
        ).toBeGreaterThanOrEqual(8.8 * u);
      });
    }
  });
}

test.describe('the running header does not move when the answer count appears', () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test('the question number is where it was in the get-ready count-in', async ({ page }) => {
    const tops: number[] = [];
    for (const id of ['present-get-ready', 'present-question-open']) {
      await openScreen(page, id);
      tops.push((await page.locator('[class*="_eyebrow_"]').boundingBox())!.y);
    }
    expect(Math.abs(tops[0]! - tops[1]!)).toBeLessThan(0.5);
  });
});

test.describe('the answer count reads and sits the same on every screen that has one', () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test('"N of M answered", top right, in one size and ink', async ({ page }) => {
    const seen = new Set<string>();
    for (const id of COUNT_SCREENS) {
      await openScreen(page, id);
      const count = page.getByTestId('answer-count');
      await expect(count, id).toHaveText(ANSWERED);
      seen.add(
        JSON.stringify(
          await count.evaluate((el) => {
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            return {
              top: Math.round(r.top),
              right: Math.round(r.right),
              size: cs.fontSize,
              weight: cs.fontWeight,
              color: cs.color,
            };
          }),
        ),
      );
    }
    expect([...seen], 'one position, size and colour').toHaveLength(1);
  });
});

test.describe('outlines scale with the stage', () => {
  test('1366x768 keeps its outlines; 320x568 gets hairlines that leave the fills showing', async ({
    page,
  }) => {
    const stroke = () =>
      page
        .locator('svg path')
        .first()
        .evaluate((el) => parseFloat(getComputedStyle(el).strokeWidth));

    await page.setViewportSize({ width: 1366, height: 768 });
    await openScreen(page, 'present-reveal-single');
    expect(await stroke()).toBeCloseTo(0.45 * (await unitPx(page)), 1);
    const fillBorder = await page
      .locator('[class*="_fill_"]')
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).borderTopWidth));
    expect(fillBorder).toBeGreaterThanOrEqual(3);

    await page.setViewportSize({ width: 320, height: 568 });
    await openScreen(page, 'present-reveal-single');
    const u = await unitPx(page);
    expect(u).toBeCloseTo(1.8, 1);
    // Proportional to the stage and never under 1 px.
    const width = await stroke();
    expect(width).toBeCloseTo(Math.max(1, 0.45 * u), 1);
    const glyph = await page.locator('svg').first().boundingBox();
    expect(width * 2, 'the outline leaves most of the glyph to its colour').toBeLessThan(
      glyph!.height * 0.3,
    );

    const bars = await page.locator('li:has([class*="_track_"])').evaluateAll((items) =>
      items.map((el) => {
        const track = el.querySelector('[class*="_track_"]') as HTMLElement;
        const fill = el.querySelector('[class*="_fill_"]') as HTMLElement | null;
        return fill
          ? {
              track: track.getBoundingClientRect().height,
              inner: fill.clientHeight,
              color: getComputedStyle(fill).backgroundColor,
            }
          : null;
      }),
    );
    expect(bars).toHaveLength(4);
    for (const bar of bars) {
      expect(bar, 'every bar has a fill on this screen').not.toBeNull();
      expect(bar!.inner, 'the colour shows inside the outline').toBeGreaterThanOrEqual(
        bar!.track * 0.4,
      );
      expect(bar!.color, 'a slot colour, not ink').not.toBe('rgb(11, 16, 32)');
    }
  });

  test('the correct bar keeps its colour at every size: its outline is capped', async ({
    page,
  }) => {
    for (const size of SMALL_STAGES) {
      await page.setViewportSize(size);
      await openScreen(page, 'present-reveal-single');
      const u = await unitPx(page);
      const m = await page.locator('li[class*="_correct_"] [class*="_fill_"]').evaluate((el) => ({
        border: parseFloat(getComputedStyle(el).borderTopWidth),
        inner: el.clientHeight,
      }));
      const label = `${size.width}x${size.height}`;
      expect(m.border, label).toBeLessThanOrEqual(1.2 * u + 0.01);
      expect(m.inner, `${label}: colour left inside`).toBeGreaterThan(0);
    }
  });

  test('320x568: the countdown bar shows a filled and an empty part', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await openScreen(page, 'present-question-open');
    const m = await page.getByTestId('stage-countdown-bar').evaluate((el) => {
      const fill = el.firstElementChild as HTMLElement;
      return {
        border: parseFloat(getComputedStyle(el).borderTopWidth),
        height: el.getBoundingClientRect().height,
        innerWidth: el.clientWidth,
        fillWidth: fill.getBoundingClientRect().width,
        fillColor: getComputedStyle(fill).backgroundColor,
        trackColor: getComputedStyle(el).backgroundColor,
      };
    });
    expect(m.border * 2, 'the outline leaves room inside the bar').toBeLessThan(m.height * 0.7);
    expect(m.fillWidth, 'some of the bar is filled').toBeGreaterThan(m.innerWidth * 0.1);
    expect(m.fillWidth, 'some of it is empty').toBeLessThan(m.innerWidth * 0.9);
    expect(m.fillColor).not.toBe(m.trackColor);
  });

  test('"+N more" keeps a legible label at 320x568 and 768x1024', async ({ page }) => {
    for (const size of [SMALL_STAGES[0]!, SMALL_STAGES[2]!]) {
      await page.setViewportSize(size);
      await openScreen(page, 'present-lobby-400');
      const chip = page.getByTestId('name-wall').locator('li').last();
      const m = await chip.evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          text: el.textContent,
          border: parseFloat(cs.borderTopWidth),
          height: el.getBoundingClientRect().height,
          fontSize: parseFloat(cs.fontSize),
          clipped: el.scrollWidth > el.clientWidth,
        };
      });
      const label = `${size.width}x${size.height}`;
      expect(m.text).toMatch(/^\+[\d,]+ more$/);
      expect(m.clipped, label).toBe(false);
      // Both borders and the letters fit in the chip, so the label is not covered.
      expect(m.height - 2 * m.border, label).toBeGreaterThan(m.fontSize);
    }
  });
});

test.describe('the open-ended wall gets only the room above its pager', () => {
  for (const size of SMALL_STAGES) {
    for (const percent of [100, 150] as const) {
      test(`${size.width}x${size.height} at ${percent}%: cards, pager and label never overlap`, async ({
        page,
      }) => {
        await page.setViewportSize(size);
        await openScreen(page, 'present-open');
        await setTextSize(page, percent);
        for (let pages = 0; pages < 4; pages++) {
          const g = await page.evaluate(() => {
            const box = (el: Element) => {
              const r = el.getBoundingClientRect();
              return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
            };
            const label = [...document.querySelectorAll('span')].find((el) =>
              /^Page \d+ of \d+$/.test(el.textContent ?? ''),
            );
            return {
              cards: [...document.querySelectorAll('[class*="_card_"]')].map(box),
              buttons: [...document.querySelectorAll('[class*="_pageButton_"]')].map(box),
              label: label ? box(label) : null,
            };
          });
          expect(g.cards.length, 'cards on the page').toBeGreaterThan(0);
          if (g.buttons.length === 0) break;
          const pagerTop = Math.min(...g.buttons.map((b) => b.top));
          for (const c of g.cards) expect(c.bottom).toBeLessThanOrEqual(pagerTop - 1);
          const [prev, next] = g.buttons as [(typeof g.buttons)[0], (typeof g.buttons)[0]];
          expect(g.label).not.toBeNull();
          expect(prev.right + 4, 'gap before the label').toBeLessThanOrEqual(g.label!.left);
          expect(g.label!.right + 4, 'gap after the label').toBeLessThanOrEqual(next.left);
          expect(await outsideStage(page)).toEqual([]);
          const nextPage = page.getByRole('button', { name: 'Next page' });
          if (await nextPage.isDisabled()) break;
          await nextPage.click();
        }
      });
    }
  }
});

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
  height: number;
  width: number;
}

interface HelpSnapshot {
  first: Box;
  lastDd: Box;
  title: Box;
  close: Box;
}

interface HelpMeasure {
  viewport: { width: number; height: number };
  dialog: Box;
  border: number;
  scrolls: boolean;
  note: Box;
  top: HelpSnapshot;
  bottom: HelpSnapshot;
  dts: Box[];
  dds: Array<Box & { fontSize: number; text: string }>;
}

/** The open help dialog's parts, scrolled to its top and to its bottom. */
async function measureHelp(page: Page): Promise<HelpMeasure> {
  return page.evaluate(() => {
    const d = document.querySelector('[data-testid="help-overlay"]') as HTMLElement;
    const rect = (el: Element): Box => {
      const r = el.getBoundingClientRect();
      return {
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        height: r.height,
        width: r.width,
      };
    };
    const title = d.querySelector('h2')!;
    const close = [...d.querySelectorAll('button')].find((b) => b.textContent === 'Close')!;
    const note = d.querySelector('p')!;
    const dts = [...d.querySelectorAll('dt')];
    const dds = [...d.querySelectorAll('dd')];
    const at = (scrollTop: number): HelpSnapshot => {
      d.scrollTop = scrollTop;
      return {
        first: rect(dts[0]!),
        lastDd: rect(dds[dds.length - 1]!),
        title: rect(title),
        close: rect(close),
      };
    };
    const scrolls = d.scrollHeight > d.clientHeight + 1;
    const top = at(0);
    const bottom = at(d.scrollHeight);
    d.scrollTop = 0;
    return {
      viewport: { width: innerWidth, height: innerHeight },
      dialog: rect(d),
      border: parseFloat(getComputedStyle(d).borderBottomWidth),
      scrolls,
      note: rect(note),
      top,
      bottom,
      dts: dts.map(rect),
      dds: dds.map((el) => ({
        ...rect(el),
        fontSize: parseFloat(getComputedStyle(el).fontSize),
        text: el.textContent ?? '',
      })),
    };
  });
}

test.describe('the keyboard help', () => {
  const HELP_SIZES = [...SMALL_STAGES, { width: 1920, height: 1080 }, { width: 1366, height: 260 }];

  for (const size of HELP_SIZES) {
    test(`${size.width}x${size.height}: fits the window or scrolls inside itself, with the title, rows and Close in reach`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await openScreen(page, 'present-help');
      const m = await measureHelp(page);
      const label = `${size.width}x${size.height}`;
      // Sized to the window, whatever the stage looks like.
      expect(m.dialog.top, label).toBeGreaterThanOrEqual(0);
      expect(m.dialog.bottom, label).toBeLessThanOrEqual(m.viewport.height);
      expect(m.dialog.left, label).toBeGreaterThanOrEqual(0);
      expect(m.dialog.right, label).toBeLessThanOrEqual(m.viewport.width);
      expect(m.scrolls, `${label}: scrolls inside itself only when the window is short`).toBe(
        size.height < 500,
      );

      for (const snap of [m.top, m.bottom]) {
        // The title and Close stay inside the dialog at every scroll position.
        expect(snap.title.top, label).toBeGreaterThanOrEqual(m.dialog.top);
        expect(snap.title.bottom, label).toBeLessThanOrEqual(m.dialog.bottom);
        expect(snap.close.top, label).toBeGreaterThanOrEqual(m.dialog.top);
        expect(snap.close.bottom, label).toBeLessThanOrEqual(m.dialog.bottom);
      }
      // Scrolled to the top the first row is under the title; to the bottom the last is above Close.
      expect(m.top.first.top, label).toBeGreaterThanOrEqual(m.top.title.bottom - 1);
      expect(m.bottom.lastDd.bottom, label).toBeLessThanOrEqual(m.bottom.close.top + 1);
    });
  }

  for (const size of [
    { width: 1366, height: 768 },
    { width: 1920, height: 1080 },
  ]) {
    test(`${size.width}x${size.height}: the key column is as wide as its keys and descriptions fit a line`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await openScreen(page, 'present-help');
      const u = await unitPx(page);
      const m = await measureHelp(page);
      // A key cell is at most 30u, and the descriptions start together in one column.
      for (const dt of m.dts) expect(dt.width).toBeLessThanOrEqual(30 * u + 1);
      expect(new Set(m.dds.map((d) => Math.round(d.left))).size).toBe(1);
      for (const dd of m.dds) {
        if (dd.text.startsWith('Next:')) continue;
        expect(dd.height, dd.text).toBeLessThan(dd.fontSize * 1.2 * 1.5);
      }
      // A description lines up with the first row of its keys.
      m.dds.forEach((dd, i) =>
        expect(Math.abs(dd.top - m.dts[i]!.top), dd.text).toBeLessThan(1.5 * u),
      );
      // The focus ring of Close has room above it (the note) and below it (the dialog's border).
      const reach = 4 + 3;
      expect(m.top.close.top - m.note.bottom).toBeGreaterThanOrEqual(reach);
      expect(m.dialog.bottom - m.border - m.top.close.bottom).toBeGreaterThanOrEqual(reach);
    });
  }

  test('Close shows one focus ring, and the dialog itself none', async ({ page }) => {
    await openScreen(page, 'present-help');
    // A key press first, so the focus that follows is a keyboard focus (`:focus-visible`).
    await page.keyboard.press('Shift');
    await page.getByRole('button', { name: 'Close' }).focus();
    const rings = await page.evaluate(() => {
      const d = document.querySelector('[data-testid="help-overlay"]') as HTMLElement;
      const close = [...d.querySelectorAll('button')].find((b) => b.textContent === 'Close')!;
      const a = getComputedStyle(close);
      return {
        focused: document.activeElement === close,
        ring: [a.outlineStyle, a.outlineWidth],
        shadow: a.boxShadow,
        dialogRing: getComputedStyle(d).outlineStyle,
      };
    });
    expect(rings.focused).toBe(true);
    expect(rings.ring).toEqual(['solid', '4px']);
    expect(rings.shadow).toBe('none');
    expect(rings.dialogRing).toBe('none');
  });
});

test.describe('the leaderboard', () => {
  test('a player who gained nothing shows "+0" in the same secondary ink as the others', async ({
    page,
  }) => {
    await openScreen(page, 'present-leaderboard');
    const cells = page.getByTestId('leaderboard').locator('td[class*="_delta_"]');
    const texts = await cells.allInnerTexts();
    expect(texts.length).toBeGreaterThanOrEqual(5);
    for (const t of texts) expect(t).toMatch(/^\+[\d,]+$/);
    expect(texts).toContain('+0');
    const colors = await cells.evaluateAll((els) => els.map((el) => getComputedStyle(el).color));
    const ink2 = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--ink-2)';
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    expect([...new Set(colors)]).toEqual([ink2]);
  });
});

test.describe('the control bar', () => {
  test('320x568: the buttons never touch, in a row or between rows, and stay in the window', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await openScreen(page, 'present-leaderboard');
    const boxes = await page
      .getByRole('group', { name: 'Presenter controls' })
      .getByRole('button')
      .evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        }),
      );
    expect(boxes.length).toBeGreaterThanOrEqual(6);
    for (const b of boxes) {
      expect(b.left).toBeGreaterThanOrEqual(0);
      expect(b.right).toBeLessThanOrEqual(320);
    }
    for (const a of boxes) {
      for (const b of boxes) {
        if (a === b) continue;
        const sameRow = Math.abs(a.top - b.top) < 2;
        if (sameRow && a.left < b.left) expect(b.left - a.right).toBeGreaterThanOrEqual(5.5);
        if (!sameRow && a.top < b.top) expect(b.top - a.bottom).toBeGreaterThanOrEqual(5.5);
      }
    }
  });

  test('the buttons follow the game, as they do for a real host', async ({ page }) => {
    const ended = [/^Next/, /^Finish/, /^Start$/, /lock joining/i, /^End question$/];
    const cases: Array<[string, RegExp[], RegExp[]]> = [
      ['present-lobby', [/^Start$/, /^Lock joining$/], [/^Next/]],
      ['present-question-open', [/^End question$/, /^Lock joining$/], [/^Next/, /^Start$/]],
      ['present-reveal-single', [/^Leaderboard$/, /^Lock joining$/], [/^Next$/]],
      ['present-leaderboard', [/^Next question$/, /^Lock joining$/], [/^Next$/]],
      ['present-podium', [/^Text size/], ended],
      ['present-ended-unscored', [/^Text size/], ended],
    ];
    for (const [id, present, absent] of cases) {
      await openScreen(page, id);
      const names = await page
        .getByRole('group', { name: 'Presenter controls' })
        .getByRole('button')
        .allInnerTexts();
      for (const re of present)
        expect(
          names.some((n) => re.test(n)),
          `${id}: ${re}`,
        ).toBe(true);
      for (const re of absent)
        expect(
          names.some((n) => re.test(n)),
          `${id}: no ${re}`,
        ).toBe(false);
    }
  });
});
