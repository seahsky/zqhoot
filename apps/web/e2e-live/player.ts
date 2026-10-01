import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { revealHeadline } from '../src/state/format.ts';
import type { Actor } from './cast.ts';
import { limitSec } from './plan.ts';
import type { Move, Q, Slot } from './plan.ts';

/**
 * The headlines the phone shows after a reveal, taken from the app's own copy function so a
 * change of wording cannot silently break the assertions. The score in "correct" is the only
 * part that varies, so it is read back from the text after this prefix.
 */
const headline = (variant: 'correct' | 'incorrect' | 'unscored' | 'no-answer', gained = 0) =>
  revealHeadline({ variant, gained } as unknown as Parameters<typeof revealHeadline>[0]);

export const REVEAL_COPY = {
  correctPrefix: headline('correct').replace(/0$/, ''),
  incorrect: headline('incorrect'),
  unscored: headline('unscored'),
  noAnswer: headline('no-answer'),
} as const;

export type RevealVariant = 'correct' | 'incorrect' | 'unscored' | 'no-answer';

export interface RevealRead {
  variant: RevealVariant;
  /** Points this question added, from the headline; 0 unless the answer was right. */
  gained: number;
  /** Running total, from the line under the headline (scored questions only). */
  total: number | null;
  /** Place, from the same line. */
  place: number | null;
  /** Everything on the screen, for the assertions that look for the right answer. */
  text: string;
}

const num = (s: string) => Number(s.replace(/[^\d]/g, ''));

export class Player {
  constructor(
    readonly actor: Actor,
    readonly slot: Slot,
    readonly nickname: string,
  ) {}

  get page(): Page {
    return this.actor.page;
  }

  /** A tap on a touch screen, a click elsewhere. */
  async press(target: Locator): Promise<void> {
    if (this.actor.touch) await target.tap();
    else await target.click();
  }

  // --- joining ---------------------------------------------------------------------------

  /** Gets to the nickname step by the link a QR code holds, or by typing the PIN. */
  async openJoin(pin: string, how: 'link' | 'typed'): Promise<void> {
    if (how === 'link') {
      await this.page.goto(`/join?pin=${pin}`);
    } else {
      await this.page.goto('/join');
      await this.page.locator('input[name="pin"]').fill(pin);
    }
    await expect(this.page.locator('input[name="pin"]')).toHaveValue(pin);
    await this.press(this.page.getByRole('button', { name: 'Continue' }));
    await expect(this.page.locator('input[name="nickname"]')).toBeVisible();
  }

  async submitNickname(name: string): Promise<void> {
    await this.page.locator('input[name="nickname"]').fill(name);
    await this.press(this.page.getByRole('button', { name: 'Join', exact: true }));
  }

  async expectJoined(): Promise<void> {
    await this.page.waitForURL(/\/play\?s=/);
    await expect(this.header().getByText(this.nickname, { exact: true })).toBeVisible();
  }

  // --- what is on the phone ----------------------------------------------------------------

  header(): Locator {
    return this.page.locator('header');
  }

  /** The score in the strip under the nickname. */
  async headerScore(): Promise<number> {
    const text = await this.header()
      .getByText(/^[\d,]+ pts$/)
      .innerText();
    return num(text);
  }

  private timer(): Locator {
    return this.page.getByRole('timer');
  }

  async expectQuestion(q: Q, index: number, total: number): Promise<void> {
    await expect(this.page.getByRole('heading', { level: 1, name: q.prompt })).toBeVisible();
    await expect(this.page.getByText(`Question ${index + 1} of ${total}`)).toBeVisible();
  }

  /** The options are live: the get-ready count-in is over and a button will take a tap. */
  async expectOptionsOpen(q: Q): Promise<void> {
    await expect(this.timer()).toBeVisible();
    if (q.kind === 'wordcloud') {
      await expect(this.page.getByRole('textbox')).toBeEnabled();
    } else {
      await expect(this.page.getByRole('button', { name: /\S/ }).first()).toBeEnabled();
    }
  }

  /**
   * Waits until the phone's own countdown says this many whole seconds of the question are gone,
   * so an answer sent afterwards is worth strictly less than one sent before. The numeral is
   * `ceil(seconds left)` on the server's clock, which the phone never runs ahead of.
   */
  async waitSecondsIn(q: Q, seconds: number): Promise<void> {
    if (seconds === 0) return;
    const left = limitSec(q) - seconds;
    await expect
      .poll(async () => Number(await this.timer().innerText()), {
        message: `${this.nickname}'s countdown to reach ${left}`,
      })
      .toBeLessThanOrEqual(left);
  }

  /**
   * The tapped control is gone and nothing is left in flight. The last answer of a question that
   * closes when everyone has answered is on screen for a few milliseconds before the reveal
   * replaces it, so this asks for "no control left", which the reveal satisfies too, and not for
   * the locked-in text, which it would miss.
   */
  async expectLockedIn(q: Q, move: Move): Promise<void> {
    if ('words' in move) {
      // A word cloud only closes when the host says so, so its entries stay on screen.
      const last = move.words[move.words.length - 1] as string;
      await expect(this.page.getByText(last, { exact: true })).toBeVisible();
    } else if ('rating' in move) {
      await expect(
        this.page.getByRole('button', { name: String(move.rating), exact: true }),
      ).toHaveCount(0);
    } else if ('bool' in move) {
      await expect(
        this.page.getByRole('button', { name: move.bool ? 'True' : 'False' }),
      ).toHaveCount(0);
    } else if ('option' in move && (q.kind === 'single' || q.kind === 'poll')) {
      await expect(
        this.page.getByRole('button', { name: q.options[move.option] as string }),
      ).toHaveCount(0);
    }
    await expect(this.page.getByText('Sending…')).toHaveCount(0);
  }

  // --- answering ---------------------------------------------------------------------------

  async answer(q: Q, move: Move): Promise<void> {
    if ('skip' in move) return;
    if ('words' in move) {
      for (const word of move.words) {
        await this.page.getByRole('textbox').fill(word);
        await this.press(this.page.getByRole('button', { name: 'Send' }));
        await expect(this.page.getByText(word, { exact: true })).toBeVisible();
      }
    } else if ('rating' in move) {
      await this.press(this.page.getByRole('button', { name: String(move.rating), exact: true }));
    } else if ('bool' in move) {
      await this.press(this.page.getByRole('button', { name: move.bool ? 'True' : 'False' }));
    } else if (q.kind === 'single' || q.kind === 'poll') {
      await this.press(this.page.getByRole('button', { name: q.options[move.option] as string }));
    }
    await this.expectLockedIn(q, move);
  }

  // --- after the close ---------------------------------------------------------------------

  /** Waits for the reveal screen and reads what it says. */
  async readReveal(): Promise<RevealRead> {
    const h1 = this.page.getByRole('heading', { level: 1 });
    const known = (t: string) =>
      t.startsWith(REVEAL_COPY.correctPrefix) ||
      t === REVEAL_COPY.incorrect ||
      t === REVEAL_COPY.unscored ||
      t === REVEAL_COPY.noAnswer;
    await expect.poll(async () => known((await h1.innerText()).trim())).toBe(true);

    const title = (await h1.innerText()).trim();
    const text = await this.page.getByRole('main').innerText();
    let variant: RevealVariant = 'no-answer';
    if (title.startsWith(REVEAL_COPY.correctPrefix)) variant = 'correct';
    else if (title === REVEAL_COPY.incorrect) variant = 'incorrect';
    else if (title === REVEAL_COPY.unscored) variant = 'unscored';
    const total = /([\d,]+) points?/.exec(text);
    const place = /(\d+)(?:st|nd|rd|th) place/.exec(text);
    return {
      variant,
      gained: variant === 'correct' ? num(title.slice(REVEAL_COPY.correctPrefix.length)) : 0,
      total: total ? num(total[1] as string) : null,
      place: place ? Number(place[1]) : null,
      text,
    };
  }

  /** Reloads the page mid-question and reports what the browser did to get back in. */
  async reload(): Promise<{ sent: string[]; visited: string[] }> {
    const sent: string[] = [];
    const visited: string[] = [];
    this.page.on('websocket', (ws) => ws.on('framesent', (f) => sent.push(String(f.payload))));
    this.page.on('framenavigated', (f) => {
      if (f === this.page.mainFrame()) visited.push(f.url());
    });
    await this.page.reload();
    return { sent, visited };
  }
}
