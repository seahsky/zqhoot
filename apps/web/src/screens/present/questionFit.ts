import type { PresentQuestion } from '../../state/presenterView.ts';
import { CONTENT_HEIGHT_U, CONTENT_WIDTH_U, fitBy, flowedLines, linesFor } from './layout.ts';

/**
 * How the question screen shares the stage's height between the countdown, the prompt and the
 * options, in stage units (layout.ts explains the model). The text-size control raises the
 * ceilings; nothing here may end up taller than the content area, which is what the presenter
 * composition tests check at every size and setting.
 */

export const PROMPT_LINE = 1.15;
export const GAP_U = 2;
/** The countdown numeral at 100%, its bar, and the gaps between. */
const NUMERAL_U = 18;
const TIMER_EXTRAS_U = 3 + 1.2;
/** Past this many characters the cards go compact so four long answers fit beside the prompt. */
const DENSE_AFTER_CHARS = 45;
const PROMPT_FLOOR_U = 5;
const OPTION_FLOOR_U = 4.3;
/** How coarsely the countdown numeral gives way when the options need the room. */
const TIMER_STEP = 0.05;

export interface Head {
  /** Prompt size in u. */
  fs: number;
  /** Height of the head block in u. */
  heightU: number;
}

export interface OptionFit {
  fs: number;
  dense: boolean;
  /** False when even the floor size overflows the room left for the cards. */
  fits: boolean;
}

export interface QuestionFit {
  head: Head;
  options: OptionFit;
  /** Multiplier for the countdown numeral: the text size, or less when the options need room. */
  timerScale: number;
}

/**
 * The countdown floats to the right of the prompt, so the first lines are shorter than the
 * rest. The prompt takes the biggest size in 5u to 8u (times the text-size control) at which
 * that fits; 200 characters land on the 5u floor.
 */
export function headFor(
  q: PresentQuestion,
  scale: number,
  timerScale: number,
  timerLabel: boolean,
): Head {
  const digits = Math.max(2, String(q.timeLimitSec ?? 0).length);
  const floatW = Math.max(22, digits * NUMERAL_U * timerScale * 0.62) + 4;
  const floatH = NUMERAL_U * timerScale + TIMER_EXTRAS_U + (timerLabel ? 4.5 : 0);
  const heightAt = (size: number) =>
    flowedLines(q.prompt, size, CONTENT_WIDTH_U, floatW, floatH, PROMPT_LINE) * size * PROMPT_LINE;
  const fs = fitBy({ maxU: 8 * scale, minU: PROMPT_FLOOR_U, budgetU: 30, heightAt });
  return { fs, heightU: Math.max(heightAt(fs), floatH) };
}

/**
 * One size for every option, so the cards look alike: the biggest at which the grid of cards
 * fits under the head. Cards sit two to a row and a row is as tall as its taller card, so each
 * option is measured on its own; the widest text is not always the one that wraps most.
 */
export function optionFit(q: PresentQuestion, headU: number, scale: number): OptionFit {
  const longest = q.options.reduce((a, o) => (o.text.length > a ? o.text.length : a), 0);
  const dense = longest > DENSE_AFTER_CHARS;
  const gap = dense ? 1.6 : GAP_U;
  const budget = CONTENT_HEIGHT_U - headU - GAP_U;
  const pad = dense ? 2 * (1 + 0.45) : 2 * (1.6 + 0.45);
  // Glyph, letter, three gaps and the card's own side padding come off half the width.
  const overhead = dense ? 5 + 3.4 + 2 * 1.4 + 2 * 1.5 + 1 : 6.5 + 4 + 2 * 2 + 2 * 2 + 1;
  const widthU = (CONTENT_WIDTH_U - gap) / 2 - overhead;
  const lineHeight = dense ? 1.15 : 1.25;
  // The compact card has no minimum height; the roomy one is 15u (Present.module.css).
  const minCardU = dense ? 0 : 15;
  const heightAt = (size: number) => {
    let total = 0;
    let rows = 0;
    for (let i = 0; i < q.options.length; i += 2) {
      let row = minCardU;
      for (const o of q.options.slice(i, i + 2)) {
        row = Math.max(row, linesFor(o.text, size, widthU) * size * lineHeight + pad);
      }
      total += row;
      rows += 1;
    }
    return total + gap * Math.max(0, rows - 1);
  };
  const fs = fitBy({ maxU: 5 * scale, minU: OPTION_FLOOR_U, budgetU: budget, heightAt });
  return { fs, dense, fits: heightAt(fs) <= budget };
}

/**
 * The prompt and the options only ever shrink to their floors, and a long question is already
 * on them at 100%. The countdown numeral is the one thing that grows with the text size and
 * is big enough already, so it gives way: as much of the text-size step as leaves the options
 * their room, and no less than its 100% size, at which the layout fits by design.
 */
export function fitQuestion(q: PresentQuestion, scale: number, timerLabel: boolean): QuestionFit {
  for (let step = 0; scale - step * TIMER_STEP > 1; step++) {
    const timerScale = scale - step * TIMER_STEP;
    const head = headFor(q, scale, timerScale, timerLabel);
    const options = optionFit(q, head.heightU, scale);
    if (options.fits) return { head, options, timerScale };
  }
  const head = headFor(q, scale, 1, timerLabel);
  return { head, options: optionFit(q, head.heightU, scale), timerScale: 1 };
}
