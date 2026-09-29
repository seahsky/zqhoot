import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openScreen } from './helpers.ts';

/**
 * Regressions from the phase 5 visual check of the host and editor screens. They read the
 * gallery fixtures at every viewport, so what a screenshot showed is asserted here too:
 * layout facts (alignment, line breaks, sizes), not pixels.
 */

/** From this width the editor's answer rows have room for the button beside the input. */
const wide = (page: Page) => (page.viewportSize()?.width ?? 0) >= 700;

/** 16 characters each: the longest nickname allowed, with spaces and as a single wide word. */
const SIXTEEN = ['Dmitri the Bold2', 'MAXIMILIANWAGNER', 'WOLFGANG_AMADEUS'];

/** How many lines a nickname takes in the host's roster: its height over its line height. */
async function rosterNameLines(page: Page, nickname: string) {
  const name = page.getByTestId('roster').getByText(nickname, { exact: true });
  return name.evaluate((el) =>
    Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)),
  );
}

test.describe('live control', () => {
  test('the join URL breaks only after a slash or a dot', async ({ page }) => {
    await openScreen(page, 'host-live-lobby');
    const url = await page.evaluate(() => {
      const el = document.querySelector('strong[class*="joinUrl"]');
      if (!el) throw new Error('the join URL is missing');
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      const breaksAfter: string[] = [];
      let top: number | null = null;
      let last = '';
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent ?? '';
        for (let i = 0; i < text.length; i++) {
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const rect = range.getBoundingClientRect();
          if (rect.width === 0) continue;
          if (top !== null && rect.top > top + 4) breaksAfter.push(last);
          top = rect.top;
          last = text.charAt(i);
        }
      }
      return { text: el.textContent, display: getComputedStyle(el).display, breaksAfter };
    });
    expect(url.text).toBe('https://quiz.example.test/join');
    expect(url.display).toBe('block');
    for (const c of url.breaksAfter) expect(['/', '.']).toContain(c);
  });

  test('a 16-character nickname sits on one line in the roster', async ({ page }) => {
    await openScreen(page, 'host-live-lobby');
    for (const nickname of SIXTEEN) {
      expect(await rosterNameLines(page, nickname), nickname).toBe(1);
    }
  });

  test('and so does one at every width, never narrower than at 320', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'laptop-1366', 'sets its own viewports, so once is enough');
    // Between the six projects' widths: the phones a little wider than 320, and the desktop
    // widths where the Players column is at its narrowest, either side of the point where the
    // row changes layout (a list 19.75rem wide, which is a 408 px screen).
    const widths = [320, 360, 375, 390, 400, 405, 408, 412, 480, 768, 1023, 1024, 1100, 1200, 1280];
    let atNarrowest = 0;
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      await openScreen(page, 'host-live-lobby');
      const room = await page
        .getByTestId('roster')
        .locator('[class*="rosterName"]')
        .first()
        .boundingBox();
      if (width === widths[0]) atNarrowest = room?.width ?? 0;
      expect(room?.width, `name column at ${width}`).toBeGreaterThanOrEqual(atNarrowest - 1);
      for (const nickname of SIXTEEN) {
        expect(await rosterNameLines(page, nickname), `${nickname} at ${width}`).toBe(1);
      }
    }
    expect(atNarrowest).toBeGreaterThan(200);
  });

  test('Control and Players are panels whose headings start on the same line', async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) < 1024, 'the columns stack below 64rem');
    await openScreen(page, 'host-live-question');
    const control = await page.getByRole('heading', { name: 'Control' }).boundingBox();
    const players = await page.getByRole('heading', { name: 'Players' }).boundingBox();
    expect(control && players && Math.abs(control.y - players.y)).toBeLessThan(2);
  });

  test('status chips are not drawn as buttons', async ({ page }) => {
    await openScreen(page, 'host-live-question');
    const chip = page.getByText('Question open', { exact: true });
    const style = await chip.evaluate((el) => {
      const s = getComputedStyle(el);
      return { border: s.borderTopWidth, radius: s.borderTopLeftRadius };
    });
    expect(style).toEqual({ border: '0px', radius: '0px' });
  });

  test('result bars carry their answer colour and keep their length in forced colours', async ({
    page,
  }) => {
    await openScreen(page, 'host-live-question');
    const fills = page.locator('[class*="barFill"]');
    expect(
      await fills.evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor)),
    ).toEqual(['rgb(0, 114, 178)', 'rgb(213, 94, 0)', 'rgb(240, 228, 66)', 'rgb(0, 158, 115)']);

    await page.emulateMedia({ forcedColors: 'active' });
    const bars = await fills.evaluateAll((els) =>
      els.map((el) => {
        const track = el.parentElement as HTMLElement;
        return {
          share: (el as HTMLElement).offsetWidth / track.clientWidth,
          filled: getComputedStyle(el).backgroundColor !== getComputedStyle(track).backgroundColor,
        };
      }),
    );
    // 7, 4, 2 and 1 of the 14 who answered.
    [0.5, 0.29, 0.14, 0.07].forEach((share, i) => {
      expect(bars[i]?.share, `bar ${i}`).toBeGreaterThan(share - 0.02);
      expect(bars[i]?.share, `bar ${i}`).toBeLessThan(share + 0.02);
      expect(bars[i]?.filled, `bar ${i} is drawn`).toBe(true);
    });
  });
});

test.describe('dashboard and sign-in', () => {
  test('a date or PIN on a card never splits over two lines', async ({ page }) => {
    await openScreen(page, 'host-dashboard');
    const parts = page.locator('[class*="nowrap"]');
    expect(await parts.count()).toBeGreaterThanOrEqual(6);
    // One rectangle per text node, so it is the lines that count: every rectangle on one row.
    const rows = await parts.evaluateAll((els) =>
      els.map((el) => new Set([...el.getClientRects()].map((r) => Math.round(r.top))).size),
    );
    for (const n of rows) expect(n).toBe(1);
  });

  test('every host page has the same header, and content starts the same distance below it', async ({
    page,
  }) => {
    const measure = async (id: string) => {
      await openScreen(page, id);
      return page.evaluate(() => {
        const header = document.querySelector('header')?.getBoundingClientRect();
        const main = document.querySelector('main');
        // The empty live region is out of the flow, so it is not the first thing on the page.
        const first = [...(main?.children ?? [])].find(
          (el) => getComputedStyle(el).position !== 'absolute',
        );
        if (!header || !first) throw new Error('no header or content');
        return { header: header.height, gap: first.getBoundingClientRect().top - header.bottom };
      });
    };
    const login = await measure('host-login');
    const others = [
      await measure('host-dashboard'),
      await measure('host-live-lobby'),
      await measure('edit-quiz'),
    ];
    for (const other of others) {
      expect(other.gap).toBeCloseTo(login.gap, 0);
      // On a phone the signed-in header wraps to more lines; the sign-in one has one item.
      if (wide(page)) expect(other.header).toBeCloseTo(login.header, 0);
    }
  });
});

test.describe('the editor', () => {
  test('each Remove button lines up with the input it removes', async ({ page }) => {
    await openScreen(page, 'edit-question-single');
    for (const letter of ['A', 'B', 'C', 'D']) {
      const button = await page
        .getByRole('button', { name: `Remove answer ${letter}` })
        .boundingBox();
      const input = await page.getByLabel(`Answer ${letter}`, { exact: true }).boundingBox();
      if (!button || !input) throw new Error(`answer ${letter} is missing`);
      if (wide(page)) {
        // Beside the input, centred on it, and not pushed down to the counter's row.
        expect(Math.abs(button.y + button.height / 2 - (input.y + input.height / 2))).toBeLessThan(
          2,
        );
        expect(button.x).toBeGreaterThan(input.x + input.width);
      } else {
        // On a phone the input keeps the full width and the button rides on the label's row.
        expect(button.y + button.height).toBeLessThanOrEqual(input.y);
      }
    }
  });

  test('the image field is a styled button of at least 48px, not a bare file control', async ({
    page,
  }) => {
    await openScreen(page, 'edit-question-single');
    await expect(page.getByText('No file chosen')).toHaveCount(0);
    for (const name of ['Replace image', 'Remove image']) {
      const box = await page.getByText(name, { exact: true }).boundingBox();
      expect(box?.height, name).toBeGreaterThanOrEqual(48);
    }
    // The input is still there for the keyboard and shows its focus on the button.
    const choose = page.getByText('Replace image', { exact: true });
    await page.locator('input[type="file"]').focus();
    expect(await choose.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
  });

  test('the question box grows to show a whole 200-character prompt', async ({ page }) => {
    await openScreen(page, 'edit-question-truefalse');
    const prompt = 'The quick brown fox jumps over the lazy dog. '.repeat(5).slice(0, 200);
    const area = page.getByLabel('Question', { exact: true });
    await area.fill(prompt);
    const [scroll, client] = await area.evaluate((el) => [el.scrollHeight, el.clientHeight]);
    expect(scroll).toBeLessThanOrEqual((client ?? 0) + 1);
  });

  test('without field-sizing, the measured height also shows the last line of the prompt', async ({
    page,
  }) => {
    // Chromium supports field-sizing, so switch it off the way an older browser lacks it: the
    // page falls back to measuring the text, and the CSS rule stops applying.
    await page.addInitScript(() => {
      const supports = CSS.supports.bind(CSS);
      CSS.supports = ((...args: [string, string?]) =>
        args[0] === 'field-sizing'
          ? false
          : supports(...(args as [string]))) as typeof CSS.supports;
      document.addEventListener('DOMContentLoaded', () => {
        const style = document.createElement('style');
        style.textContent = 'textarea { field-sizing: fixed !important; }';
        document.head.append(style);
      });
    });
    await openScreen(page, 'edit-question-truefalse');
    const area = page.getByLabel('Question', { exact: true });
    expect(await area.evaluate((el) => getComputedStyle(el).fieldSizing)).toBe('fixed');
    const prompt = 'The quick brown fox jumps over the lazy dog. '.repeat(5).slice(0, 200);
    // What is scrolled out of sight: the text's height less the padding box that shows it.
    const cutOff = () => area.evaluate((el) => el.scrollHeight - el.clientHeight);
    await area.fill(prompt);
    expect(await cutOff()).toBeLessThanOrEqual(0);
    // Narrower, the same text needs more lines; the height follows the width.
    await page.setViewportSize({ width: 320, height: 900 });
    await expect.poll(cutOff).toBeLessThanOrEqual(0);
  });

  test('a collapsed question with problems says so, and its error link opens and focuses it', async ({
    page,
  }) => {
    await openScreen(page, 'edit-errors');
    const card = page.locator('[data-question="1"]');
    const toggle = card.locator('button[aria-expanded]');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toContainText('1 problem');
    await expect(toggle).toContainText('Edit');
    await expect(card).toHaveAttribute('data-invalid', 'true');

    await page
      .getByTestId('error-summary')
      .getByRole('link', { name: 'Question 2, answer C: write the answer text.' })
      .click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toContainText('Close');
    await expect(page.locator('#f-questions-1-options-2-text')).toBeFocused();
  });

  test('every question card names what its summary button does', async ({ page }) => {
    await openScreen(page, 'edit-quiz');
    const toggles = page.locator('[data-question] button[aria-expanded]');
    expect(await toggles.count()).toBe(6);
    for (const toggle of await toggles.all()) {
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(toggle).toContainText('Edit');
    }
  });

  test('"Unsaved changes" is text with a dot, not a button-like pill', async ({ page }) => {
    await openScreen(page, 'edit-conflict');
    const status = page.getByRole('status').filter({ hasText: 'Unsaved changes' });
    const style = await status.evaluate((el) => {
      const s = getComputedStyle(el);
      return { border: s.borderTopWidth, dot: getComputedStyle(el, '::before').content };
    });
    expect(style).toEqual({ border: '0px', dot: '""' });
  });

  test('the new-question select has short names, and the description is hint text', async ({
    page,
  }) => {
    await openScreen(page, 'edit-quiz');
    const select = page.getByLabel('New question type');
    expect(await select.locator('option').allTextContents()).toEqual([
      'Multiple choice',
      'True or false',
      'Poll',
      'Word cloud',
      'Open-ended',
      'Rating',
    ]);
    await expect(page.getByText('2 to 4 answers, one is correct')).toBeVisible();
    await select.selectOption('poll');
    await expect(page.getByText('2 to 6 options, no right answer')).toBeVisible();
  });

  test('form controls use the page font', async ({ page }) => {
    await openScreen(page, 'edit-quiz');
    const fonts = await page.evaluate(() => {
      const family = (sel: string) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el).fontFamily : null;
      };
      return [family('body'), family('select'), family('#f-title')];
    });
    expect(fonts[1]).toBe(fonts[0]);
    expect(fonts[2]).toBe(fonts[0]);
  });

  test('a section heading is stronger than a field label', async ({ page }) => {
    await openScreen(page, 'edit-question-poll');
    const sizes = await page.evaluate(() => {
      const size = (el: Element | null) => (el ? parseFloat(getComputedStyle(el).fontSize) : 0);
      return {
        heading: size(document.querySelector('h4')),
        label: size(document.querySelector('label')),
      };
    });
    expect(sizes.heading).toBeGreaterThan(sizes.label);
  });
});
