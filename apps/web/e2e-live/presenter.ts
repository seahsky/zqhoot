import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

export interface BarRow {
  letter: string;
  label: string;
  count: number;
  percent: number;
  /** The row carries the "Correct" badge. */
  marked: boolean;
}

export interface BoardRow {
  rank: string;
  nickname: string;
  score: number;
  delta: number;
}

const digits = (s: string) => Number(s.replace(/[^\d]/g, '') || '0');

/** The projector view, as the room sees it. */
export class Presenter {
  constructor(readonly page: Page) {}

  /** Space, the way a clicker or the host at the keyboard would. */
  async pressSpace(): Promise<void> {
    await this.page.keyboard.press('Space');
  }

  async pin(): Promise<string> {
    return (await this.page.getByTestId('pin').innerText()).replace(/\s/g, '');
  }

  async lobbyNames(): Promise<string[]> {
    const items = await this.page.getByTestId('name-wall').locator('li').allInnerTexts();
    return items.map((t) => t.trim()).filter((t) => !/^\+[\d,]+ more$/.test(t));
  }

  /** The prompt is on screen: the question is up, though its options may not be open yet. */
  async expectPrompt(prompt: string): Promise<void> {
    await expect(this.page.getByRole('heading', { level: 1, name: prompt })).toBeVisible();
  }

  /** The count on the projector has reached at least this many, while the question is open. */
  async expectAnsweredAtLeast(n: number, of: number): Promise<void> {
    const count = this.page.getByTestId('answer-count');
    await expect
      .poll(async () => {
        const m = /^([\d,]+) of ([\d,]+) answered$/.exec((await count.innerText()).trim());
        return m && Number(m[2]?.replace(/,/g, '')) === of ? Number(m[1]?.replace(/,/g, '')) : -1;
      })
      .toBeGreaterThanOrEqual(n);
  }

  /** "3 of 5 answered" appears once the options are open and moves as answers come in. */
  async expectAnswered(n: number, of: number): Promise<void> {
    await expect(this.page.getByTestId('answer-count')).toHaveText(`${n} of ${of} answered`);
  }

  /** The reveal screen for a question, whichever way it was closed. */
  async expectReveal(index: number, total: number): Promise<void> {
    await expect(
      this.page.getByText(new RegExp(`^Question ${index + 1} of ${total} · Results$`)),
    ).toBeVisible();
  }

  /**
   * Watches the page for the rest of the question: every change to its DOM is checked for the
   * answer marker, until the reveal screen (which shows it on purpose) takes over. Checking on
   * each mutation, not now and then, leaves no gap for a marker to flash by unseen.
   */
  async watchForLeaks(): Promise<void> {
    await this.page.evaluate(() => {
      const w = window as unknown as { leaks?: string[]; leakWatch?: MutationObserver };
      w.leaks = [];
      w.leakWatch?.disconnect();
      const marker = /correct/i;
      const check = () => {
        const text = document.body.textContent ?? '';
        // The reveal, the leaderboard and the podium may name the answer.
        if (/·\s*Results/.test(text)) return;
        if (document.querySelector('[data-testid="leaderboard"], [data-testid="podium"]')) return;
        const hit = marker.exec(text) ?? marker.exec(document.body.outerHTML);
        if (hit) w.leaks?.push(`"${hit[0]}" after ${text.slice(0, 80)}`);
      };
      w.leakWatch = new MutationObserver(check);
      w.leakWatch.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
      check();
    });
  }

  /** What `watchForLeaks` caught, empty if nothing. */
  async stopWatchingForLeaks(): Promise<string[]> {
    return this.page.evaluate(() => {
      const w = window as unknown as { leaks?: string[]; leakWatch?: MutationObserver };
      w.leakWatch?.disconnect();
      return w.leaks ?? [];
    });
  }

  /** Everything a person or a screen reader could pick up that hints at the right answer. */
  private async markerHits(): Promise<string[]> {
    return this.page.evaluate(() => {
      const hits: string[] = [];
      const marker = /correct/i;
      const body = document.body;
      if (marker.test(body.textContent ?? '')) hits.push('text');
      // Class names too: the badge's row gets a class of its own, and it is part of the DOM.
      if (marker.test(body.outerHTML)) hits.push('markup');
      return hits;
    });
  }

  /** Before the reveal the room must get no hint of the answer. */
  async expectNoAnswerMarker(optionCount = 0): Promise<void> {
    expect(
      await this.markerHits(),
      'the answer marker is in the presenter DOM before the reveal',
    ).toEqual([]);
    // Option cards must be indistinguishable from each other: the same elements, classes and
    // attributes. Only the letter, the glyph's shape and its colour (an answer's identity) differ.
    const cards = await this.page.locator('[data-option]').evaluateAll((els) =>
      els.map((card) =>
        [card, ...card.querySelectorAll('*')]
          .map((el) => {
            const names = el
              .getAttributeNames()
              .filter((n) => n !== 'd' && n !== 'style')
              .sort();
            return `${el.tagName}.${el.getAttribute('class') ?? ''}[${names.join(',')}]`;
          })
          .join(' '),
      ),
    );
    expect(cards.length, 'option cards on screen').toBe(optionCount);
    expect(new Set(cards).size, 'option cards differ from one another').toBeLessThanOrEqual(1);
  }

  /** The detector has to be able to fail, or the check above proves nothing. */
  async expectAnswerMarkerPresent(): Promise<void> {
    expect(await this.markerHits()).toContain('text');
  }

  /** The bar rows of a chart, in answer order. */
  async bars(): Promise<BarRow[]> {
    const texts = await this.page
      .locator('main li')
      .evaluateAll((els) => els.map((e) => e.textContent ?? ''));
    const rows: BarRow[] = [];
    for (const raw of texts) {
      const m = /^([A-F]) · (.+) · ([\d,]+) · (\d+)%(Correct)?$/.exec(raw.trim());
      if (!m) continue;
      rows.push({
        letter: m[1] as string,
        label: m[2] as string,
        count: digits(m[3] as string),
        percent: Number(m[4]),
        marked: m[5] !== undefined,
      });
    }
    return rows;
  }

  /** The table that carries a chart's numbers for screen readers. */
  async chartTable(): Promise<{ head: string[]; rows: string[][] }> {
    const table = this.page.locator('main table').first();
    const head = await table.locator('thead th').allTextContents();
    const rows = await table
      .locator('tbody tr')
      .evaluateAll((trs) =>
        trs.map((tr) => Array.from(tr.querySelectorAll('td'), (td) => td.textContent ?? '')),
      );
    return { head, rows };
  }

  /** Visible tag-cloud words, as drawn. */
  async cloudWords(): Promise<string[]> {
    const words = await this.page.locator('main ul li').allInnerTexts();
    return words.map((w) => w.trim());
  }

  async ratingAverageText(): Promise<string> {
    return (
      await this.page
        .getByText(/^Average /)
        .first()
        .innerText()
    ).trim();
  }

  async leaderboard(): Promise<BoardRow[]> {
    const rows = await this.page
      .getByTestId('leaderboard')
      .locator('tbody tr')
      .evaluateAll((trs) =>
        trs.map((tr) => Array.from(tr.querySelectorAll('td'), (td) => td.textContent ?? '')),
      );
    return rows.map(([rank, nickname, score, delta]) => ({
      rank: (rank ?? '').trim(),
      nickname: (nickname ?? '').trim(),
      score: digits(score ?? ''),
      delta: digits(delta ?? ''),
    }));
  }

  async podium(): Promise<Array<{ nickname: string; score: number; rank: number; place: number }>> {
    return this.page
      .getByTestId('podium')
      .locator('> li')
      .evaluateAll((items) =>
        items.map((li) => {
          const spans = Array.from(li.querySelectorAll(':scope > span'));
          const text = (i: number) => (spans[i]?.textContent ?? '').trim();
          return {
            nickname: text(0),
            score: Number(text(1).replace(/[^\d]/g, '')),
            rank: Number(text(2).replace(/[^\d]/g, '')),
            place: Number(li.getAttribute('data-place')),
          };
        }),
      );
  }
}
