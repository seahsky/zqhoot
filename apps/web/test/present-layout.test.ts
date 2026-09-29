import { describe, expect, it } from 'vitest';
import {
  CONTENT_HEIGHT_U,
  charEm,
  CONTENT_WIDTH_U,
  cloudLayout,
  fitFontUnits,
  flowedLines,
  WALL_FONTS_U,
  linesFor,
  lobbyWallHeightU,
  nameWall,
  paginateCards,
  textWidthEm,
  wallMetrics,
} from '../src/screens/present/layout.ts';
import { formatPin, joinLink, percentOf, sizeWords, wordUnits } from '../src/state/charts.ts';
import { names } from '../src/dev/fixtures/hostSnapshots.ts';

describe('stage geometry', () => {
  it('is 16:9 with 5% padding: 160u by 90u of content', () => {
    expect(CONTENT_WIDTH_U).toBeCloseTo(160, 5);
    expect(CONTENT_HEIGHT_U).toBe(90);
  });
});

describe('text measuring', () => {
  it('knows narrow, wide and capital letters apart', () => {
    expect(charEm('i')).toBeLessThan(charEm('n'));
    expect(charEm('n')).toBeLessThan(charEm('N'));
    expect(charEm('N')).toBeLessThan(charEm('m'));
    expect(textWidthEm('Amarathe Bold2')).toBeGreaterThan(textWidthEm('illicit lilies'));
    expect(textWidthEm('')).toBe(0);
  });

  it('counts fullwidth characters as a whole em', () => {
    expect(textWidthEm('日本語')).toBe(3);
    expect(textWidthEm('')).toBe(0);
  });

  it('needs more lines for longer text and never fewer than one', () => {
    expect(linesFor('', 5, 100)).toBe(1);
    expect(linesFor('x'.repeat(200), 5, 100)).toBeGreaterThan(linesFor('x'.repeat(50), 5, 100));
    expect(linesFor('x', 5, 0)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('question text fitting', () => {
  const base = { widthU: 120, heightU: 30, maxU: 8, minU: 5, lineHeight: 1.2 };

  it('a short question gets the biggest size', () => {
    expect(fitFontUnits({ ...base, text: 'Which planet is closest to the Sun?' })).toBe(8);
  });

  it('a 200-character question steps down but stays within 5u to 8u', () => {
    const size = fitFontUnits({ ...base, text: 'x'.repeat(200) });
    expect(size).toBeGreaterThanOrEqual(5);
    expect(size).toBeLessThan(8);
  });

  it('returns the floor when nothing fits, and never below it', () => {
    expect(fitFontUnits({ ...base, text: 'x'.repeat(2000) })).toBe(5);
  });

  it('is monotone: more text never gets a bigger size', () => {
    let last = Infinity;
    for (let n = 10; n <= 200; n += 10) {
      const s = fitFontUnits({ ...base, text: 'x'.repeat(n) });
      expect(s).toBeLessThanOrEqual(last);
      last = s;
    }
  });

  it('a larger text-size setting raises the ceiling but the result still fits', () => {
    const scaled = fitFontUnits({ ...base, text: 'A short one', maxU: 8 * 1.5 });
    expect(scaled).toBeGreaterThan(8);
    const size = fitFontUnits({ ...base, text: 'x'.repeat(100), maxU: 12 });
    expect(
      linesFor('x'.repeat(100), size, base.widthU) * size * base.lineHeight,
    ).toBeLessThanOrEqual(base.heightU);
  });
});

describe('the nickname wall', () => {
  const W = CONTENT_WIDTH_U;
  // What the lobby really gives it: a QR code, a short quiz title, 100% text size.
  const H = lobbyWallHeightU({
    title: 'Friday night trivia',
    joinUrl: 'zqhoot.example.com/join',
    scale: 1,
    hasQr: true,
  });

  /** Rows `chips` take at `fontU`, packed left to right the way the browser wraps them. */
  function rowsNeeded(nameList: readonly string[], fontU: number, moreEm = 0): number {
    const m = wallMetrics(fontU);
    const widths = nameList.map(
      (n) => textWidthEm(Array.from(n).slice(0, 16).join('')) * fontU * 1.08 + 2 * m.padXU,
    );
    if (moreEm > 0) widths.push(moreEm * fontU * 1.15 + 2 * m.padXU + 1);
    let rows = widths.length > 0 ? 1 : 0;
    let x = 0;
    for (const w of widths) {
      if (x > 0 && x + m.gapXU + w > W) {
        rows += 1;
        x = 0;
      }
      x += (x > 0 ? m.gapXU : 0) + w;
    }
    return rows;
  }

  const rowsAvailable = (fontU: number) => {
    const m = wallMetrics(fontU);
    return Math.floor((H + m.gapYU) / (m.rowHeightU + m.gapYU));
  };

  const everyoneFitsAt = (nameList: readonly string[], fontU: number) =>
    rowsNeeded(nameList, fontU) <= rowsAvailable(fontU);

  it('a small room gets the biggest name size and shows everyone', () => {
    const wall = nameWall(names(12), W, H);
    expect(wall.fontU).toBe(5);
    expect(wall.more).toBe(0);
    expect(wall.shown).toBe(12);
  });

  it('steps from 5u down to the 3.5u floor as the room grows', () => {
    expect(WALL_FONTS_U[0]).toBe(5);
    expect(WALL_FONTS_U.at(-1)).toBe(3.5);
    let last = Infinity;
    const sizes = new Set<number>();
    for (const n of [5, 20, 40, 60, 80, 100, 150, 250, 400]) {
      const wall = nameWall(names(n), W, H);
      expect(wall.fontU).toBeLessThanOrEqual(last);
      expect(wall.fontU).toBeGreaterThanOrEqual(3.5);
      last = wall.fontU;
      sizes.add(wall.fontU);
    }
    // The whole scale is used: it is not one jump from big to small.
    expect(sizes.size).toBeGreaterThanOrEqual(4);
    expect(last).toBe(3.5);
  });

  it('fits more names to a row as the type shrinks', () => {
    const perRow = (fontU: number) => {
      const m = wallMetrics(fontU);
      return W / (textWidthEm('Amara') * fontU * 1.08 + 2 * m.padXU + m.gapXU);
    };
    for (let i = 1; i < WALL_FONTS_U.length; i++) {
      expect(perRow(WALL_FONTS_U[i] as number)).toBeGreaterThan(
        perRow(WALL_FONTS_U[i - 1] as number),
      );
    }
  });

  it('400 names: at least 60 are drawn, at the floor, and the rest becomes "+N more"', () => {
    const wall = nameWall(names(400), W, H);
    expect(wall.fontU).toBe(3.5);
    expect(wall.shown).toBeGreaterThanOrEqual(60);
    expect(wall.more).toBe(400 - wall.shown);
  });

  it('what is drawn, and the "+N more" chip, fit the rows the box has', () => {
    for (const n of [12, 60, 130, 250, 400, 1000]) {
      const all = names(n);
      const wall = nameWall(all, W, H);
      const moreEm = wall.more > 0 ? textWidthEm(`+${wall.more} more`) : 0;
      expect(
        rowsNeeded(all.slice(0, wall.shown), wall.fontU, moreEm),
        `${n} names`,
      ).toBeLessThanOrEqual(wall.rows);
      expect(wall.rows).toBe(rowsAvailable(wall.fontU));
      expect(wall.rows * (wall.rowHeightU + wall.gapYU) - wall.gapYU).toBeLessThanOrEqual(H + 1e-6);
    }
  });

  it('"+N more" appears only when even the smallest size overflows', () => {
    for (const n of [5, 20, 60, 100, 150, 200, 300, 400, 800]) {
      const all = names(n);
      const wall = nameWall(all, W, H);
      if (wall.more > 0) {
        expect(wall.fontU).toBe(3.5);
        expect(everyoneFitsAt(all, 3.5), `${n} names at the floor`).toBe(false);
      } else {
        expect(wall.shown).toBe(n);
        expect(everyoneFitsAt(all, wall.fontU), `${n} names at ${wall.fontU}u`).toBe(true);
      }
    }
  });

  it('takes the largest size at which everyone fits', () => {
    for (const n of [5, 20, 60, 100, 150, 200, 300]) {
      const all = names(n);
      const wall = nameWall(all, W, H);
      if (wall.more > 0) continue;
      const next = WALL_FONTS_U[WALL_FONTS_U.indexOf(wall.fontU) - 1];
      if (next !== undefined) {
        expect(everyoneFitsAt(all, next), `${n} names at ${next}u`).toBe(false);
      }
    }
  });

  it('more room, or shorter names, never shrink the type', () => {
    const all = names(150);
    expect(nameWall(all, W, H + 10).fontU).toBeGreaterThanOrEqual(nameWall(all, W, H).fontU);
    const short = all.map((n) => n.slice(0, 4));
    expect(nameWall(short, W, H).fontU).toBeGreaterThanOrEqual(nameWall(all, W, H).fontU);
  });

  it('wide characters take more room', () => {
    const wide = nameWall(
      Array.from({ length: 200 }, () => '日本語日本語日本語日本語'),
      W,
      H,
    );
    const narrow = nameWall(
      Array.from({ length: 200 }, () => 'abcdefgh'),
      W,
      H,
    );
    expect(wide.shown).toBeLessThan(narrow.shown);
  });

  it('a name is measured at no more than 16 characters, like the limit', () => {
    const long = nameWall(['x'.repeat(200)], W, H);
    expect(long).toMatchObject({ shown: 1, more: 0, fontU: 5 });
  });

  it('an empty room is an empty wall', () => {
    expect(nameWall([], W, H)).toMatchObject({ shown: 0, more: 0 });
  });
});

describe('the height the lobby leaves the wall', () => {
  const base = { title: 'Friday night trivia', joinUrl: 'zqhoot.example.com/join', hasQr: true };

  it('is about 58u at 100% text size: the join block, a gap and a little slack', () => {
    const h = lobbyWallHeightU({ ...base, scale: 1 });
    expect(h).toBeGreaterThan(55);
    expect(h).toBeLessThan(60);
  });

  it('shrinks as the text-size control grows the PIN and the join line', () => {
    const heights = [1, 1.25, 1.5].map((scale) => lobbyWallHeightU({ ...base, scale }));
    expect(heights[1]).toBeLessThan(heights[0] as number);
    expect(heights[2]).toBeLessThan(heights[1] as number);
  });

  it('gives up a line for a long title, but never more than the two lines it is cut to', () => {
    const one = lobbyWallHeightU({ ...base, scale: 1 });
    const two = lobbyWallHeightU({ ...base, title: 'A long title '.repeat(6), scale: 1 });
    const many = lobbyWallHeightU({ ...base, title: 'A long title '.repeat(9), scale: 1 });
    expect(two).toBeLessThan(one);
    expect(many).toBe(two);
    expect(one - two).toBeCloseTo(5.75, 1);
  });

  it('gives up a line for a join address that wraps', () => {
    const address = `${'sub.'.repeat(30)}example.com`;
    expect(lobbyWallHeightU({ ...base, joinUrl: address, scale: 1 })).toBeLessThan(
      lobbyWallHeightU({ ...base, scale: 1 }),
    );
  });

  it('gives up a line when joining is locked and the badge sits under the count', () => {
    const open = lobbyWallHeightU({ ...base, scale: 1 });
    const locked = lobbyWallHeightU({ ...base, scale: 1, locked: true });
    expect(locked).toBeLessThan(open);
    // At 150% the PIN is taller than the count and its badge, which then cost nothing.
    expect(lobbyWallHeightU({ ...base, scale: 1.5, locked: true })).toBe(
      lobbyWallHeightU({ ...base, scale: 1.5 }),
    );
  });

  it('never leaves the wall more than the QR code and the gap allow', () => {
    const withQr = lobbyWallHeightU({ ...base, scale: 1 });
    expect(withQr).toBeLessThanOrEqual(CONTENT_HEIGHT_U - 27 - 2);
    expect(lobbyWallHeightU({ ...base, hasQr: false, scale: 1 })).toBeGreaterThanOrEqual(withQr);
  });
});

describe('the word cloud', () => {
  const words = (n: number) =>
    sizeWords(Array.from({ length: n }, (_, i) => ({ text: `word${i}`, count: n - i })));

  it('sizes are monotone in count and clamped to 4.3u to 12u', () => {
    let last = 0;
    for (let count = 1; count <= 30; count++) {
      const u = wordUnits(count, 1, 30);
      expect(u).toBeGreaterThanOrEqual(last);
      expect(u).toBeGreaterThanOrEqual(4.3);
      expect(u).toBeLessThanOrEqual(12);
      last = u;
    }
    expect(wordUnits(1, 1, 30)).toBe(4.3);
    expect(wordUnits(30, 1, 30)).toBe(12);
    expect(wordUnits(5, 5, 5)).toBe(7);
  });

  it('the same votes always give the same order: count descending, then text', () => {
    const a = sizeWords([
      { text: 'b', count: 2 },
      { text: 'a', count: 2 },
      { text: 'c', count: 5 },
    ]);
    const b = sizeWords([
      { text: 'c', count: 5 },
      { text: 'a', count: 2 },
      { text: 'b', count: 2 },
    ]);
    expect(a.map((w) => w.text)).toEqual(['c', 'a', 'b']);
    expect(b).toEqual(a);
  });

  it('a few words are drawn at full size', () => {
    const layout = cloudLayout(words(6), 160, 50);
    expect(layout.hidden).toBe(0);
    expect(layout.words.every((w) => w.drawnUnits === w.units)).toBe(true);
  });

  it('a big cloud shrinks, then drops the least-voted words, never the most-voted', () => {
    const many = words(60);
    const layout = cloudLayout(many, 160, 50);
    expect(layout.hidden).toBeGreaterThanOrEqual(0);
    expect(layout.words.length + layout.hidden).toBe(60);
    expect(layout.words[0]?.text).toBe('word0');
    for (const w of layout.words) expect(w.drawnUnits).toBeGreaterThanOrEqual(4.3);
    // What was kept is a prefix of the ordered list.
    expect(layout.words.map((w) => w.text)).toEqual(
      many.slice(0, layout.words.length).map((w) => w.text),
    );
  });

  it('an empty cloud is empty', () => {
    expect(cloudLayout([], 160, 50)).toEqual({ words: [], hidden: 0 });
  });
});

describe('the open-ended wall', () => {
  const W = 160;
  const H = 60;
  const indexes = (pages: number[][][]) => pages.flatMap((page) => page.flat());

  it('short responses share three columns on one page, newest first, dealt to the shortest column', () => {
    const texts = Array.from({ length: 6 }, (_, i) => `Idea number ${i}`);
    const wall = paginateCards(texts, W, H);
    expect(wall.cols).toBe(3);
    expect(wall.pages).toHaveLength(1);
    expect(wall.pages[0]).toEqual([
      [0, 3],
      [1, 4],
      [2, 5],
    ]);
  });

  it('a long response does not leave a hole: the next ones go into the shorter columns', () => {
    const texts = [
      'a very long response '.repeat(5).trim(),
      'short one',
      'another short',
      'third short',
    ];
    const [page] = paginateCards(texts, W, H).pages;
    expect(page?.[0]).toEqual([0]);
    expect(page?.[1]).toEqual([1, 3]);
    expect(page?.[2]).toEqual([2]);
  });

  it('a very long response gets fewer, wider columns so it fits a card', () => {
    const texts = ['x '.repeat(100).trim(), 'short'];
    expect(paginateCards(texts, W, H).cols).toBeLessThan(3);
  });

  it('too many responses are split into pages that cover every one exactly once', () => {
    const texts = Array.from(
      { length: 40 },
      (_, i) => `A reasonably long response, number ${i}, about the offsite`,
    );
    const { pages } = paginateCards(texts, W, H);
    expect(pages.length).toBeGreaterThan(1);
    expect([...indexes(pages)].sort((a, b) => a - b)).toEqual(texts.map((_, i) => i));
    // Earlier pages hold newer responses.
    expect(Math.max(...(pages[0] ?? []).flat())).toBeLessThan(Math.max(...(pages[1] ?? []).flat()));
  });

  it('no responses, no pages', () => {
    expect(paginateCards([], W, H).pages).toEqual([]);
  });
});

describe('text flowing beside the countdown', () => {
  it('lines beside the float are shorter, so the paragraph needs more lines than without one', () => {
    const text = 'x'.repeat(200);
    const plain = linesFor(text, 5, 160);
    const beside = flowedLines(text, 5, 160, 30, 22, 1.15);
    expect(beside).toBeGreaterThanOrEqual(plain);
    expect(beside).toBeLessThanOrEqual(linesFor(text, 5, 130));
  });

  it('a short paragraph beside a tall float stays beside it', () => {
    expect(flowedLines('Which planet is closest to the Sun?', 8, 160, 30, 22, 1.15)).toBe(2);
  });

  it('is never below one line', () => {
    expect(flowedLines('', 5, 160, 30, 22, 1.15)).toBe(1);
  });
});

describe('small helpers', () => {
  it('groups a PIN in threes', () => {
    expect(formatPin('482915')).toBe('482 915');
    expect(formatPin('123')).toBe('123');
  });

  it('builds the join link with the PIN, keeping any query the URL already has', () => {
    expect(joinLink('https://quiz.example.test/join', '482915')).toBe(
      'https://quiz.example.test/join?pin=482915',
    );
    expect(joinLink('https://quiz.example.test/join?room=a', '482915')).toBe(
      'https://quiz.example.test/join?room=a&pin=482915',
    );
    expect(joinLink('/join', '482915')).toBe('/join?pin=482915');
  });

  it('percentages are whole numbers of the players who answered', () => {
    expect(percentOf(14, 30)).toBe(47);
    expect(percentOf(0, 0)).toBe(0);
    expect(percentOf(1, 3)).toBe(33);
  });
});
