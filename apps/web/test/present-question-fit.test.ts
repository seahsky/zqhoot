import { describe, expect, it } from 'vitest';
import { singleLongQ, singleQ } from '../src/dev/fixtures/hostSnapshots.ts';
import { presentQuestion } from '../src/state/presenterView.ts';
import type { PresentQuestion } from '../src/state/presenterView.ts';
import { fitQuestion, headFor, optionFit } from '../src/screens/present/questionFit.ts';

const SCALES = [1, 1.25, 1.5] as const;

/** Filler that wraps like prose: words of mixed width, cut to `n` characters. */
function words(n: number): string {
  const pool = 'women mowing swimming waiting drawn windows mumbling'.split(' ');
  let out = '';
  for (let i = 0; out.length < n; i++) out += (out ? ' ' : '') + pool[i % pool.length];
  return out.slice(0, n).trim();
}

function question(promptChars: number, optionChars: number): PresentQuestion {
  return {
    ...presentQuestion(singleLongQ, 0, 5),
    prompt: words(promptChars),
    options: [0, 1, 2, 3].map((slot) => ({ slot, text: words(optionChars - slot) })),
  };
}

describe('the question layout at every text size', () => {
  const long = presentQuestion(singleLongQ, 2, 10);

  it('fits the 200-character prompt and four 80-character options at 100%, 125% and 150%', () => {
    for (const scale of SCALES) {
      const fit = fitQuestion(long, scale, false);
      expect(fit.options.fits, `${scale}`).toBe(true);
      expect(fit.head.fs).toBeGreaterThanOrEqual(5);
      expect(fit.options.fs).toBeGreaterThanOrEqual(4.3);
      expect(fit.timerScale).toBeGreaterThanOrEqual(1);
      expect(fit.timerScale).toBeLessThanOrEqual(scale);
    }
  });

  it('a long question keeps its option text at or below the 100% size as the text size grows', () => {
    const at100 = fitQuestion(long, 1, false);
    for (const scale of [1.25, 1.5]) {
      expect(fitQuestion(long, scale, false).options.fs).toBeLessThanOrEqual(at100.options.fs);
    }
  });

  it('measures every option, because the widest text is not always the one that wraps most', () => {
    // All at the 80-character limit: the first option is the first longest, but the second is
    // wider and wraps to more lines, and it decides the size.
    const q: PresentQuestion = {
      ...long,
      options: [
        { slot: 0, text: 'a'.repeat(3) + ' ' + 'x'.repeat(76) },
        { slot: 1, text: 'W'.repeat(80) },
        { slot: 2, text: 'ok' },
        { slot: 3, text: 'ok' },
      ],
    };
    const alone = optionFit(
      { ...q, options: [q.options[0] as PresentQuestion['options'][0]] },
      30,
      1,
    );
    expect(optionFit(q, 30, 1).fs).toBeLessThan(alone.fs);
  });

  it('holds the countdown numeral back when the options would not fit beside it', () => {
    // Found by search: at 150% the numeral pushes the prompt to more lines, and the cards then
    // no longer fit at any size; at a smaller numeral they do.
    const q = question(120, 80);
    const full = headFor(q, 1.5, 1.5, false);
    expect(optionFit(q, full.heightU, 1.5).fits).toBe(false);

    const fit = fitQuestion(q, 1.5, false);
    expect(fit.options.fits).toBe(true);
    expect(fit.timerScale).toBeGreaterThan(1);
    expect(fit.timerScale).toBeLessThan(1.5);
  });

  it('keeps the numeral at the full text size when there is room', () => {
    const short = presentQuestion(singleQ, 0, 5);
    for (const scale of SCALES) expect(fitQuestion(short, scale, false).timerScale).toBe(scale);
  });

  it('falls back to the 100% numeral when nothing fits', () => {
    const fit = fitQuestion(question(200, 80), 1.5, false);
    expect(fit.options.fits).toBe(false);
    expect(fit.timerScale).toBe(1);
  });

  it('a question without options only sizes the prompt', () => {
    const q: PresentQuestion = { ...long, type: 'poll', options: [] };
    expect(fitQuestion(q, 1.5, true).timerScale).toBe(1.5);
  });
});
