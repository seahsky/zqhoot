import type { WordCount } from '@zqhoot/protocol';
import { SLOTS } from '../ui/slots.ts';

/** Data shaping for the presenter's charts: pure, so the numbers can be tested without a browser. */

export interface BarRow {
  /** 0-5: fixes the letter, glyph and colour. */
  slot: number;
  letter: string;
  label: string;
  count: number;
  /** Whole percent of the players who answered; 0 when nobody did. */
  percent: number;
  /** Only ever true in a reveal. */
  correct: boolean;
}

export function percentOf(count: number, total: number): number {
  return total > 0 ? Math.round((count / total) * 100) : 0;
}

export function barRow(
  slot: number,
  label: string,
  count: number,
  answered: number,
  correct = false,
): BarRow {
  return {
    slot,
    letter: SLOTS[slot]?.letter ?? '',
    label,
    count,
    percent: percentOf(count, answered),
    correct,
  };
}

/** ADR-0016: essential text never goes below 4.3u; the biggest word is 12u. */
export const WORD_MIN_UNITS = 4.3;
export const WORD_MAX_UNITS = 12;
/** Size of every word when they all have the same count. */
const WORD_EVEN_UNITS = 7;

/**
 * Word size in stage units. Monotone in `count` (more votes never means smaller), and a
 * square root so one runaway word does not shrink everything else to the floor.
 */
export function wordUnits(count: number, min: number, max: number): number {
  if (max <= min) return WORD_EVEN_UNITS;
  const t = Math.min(1, Math.max(0, (count - min) / (max - min)));
  return WORD_MIN_UNITS + (WORD_MAX_UNITS - WORD_MIN_UNITS) * Math.sqrt(t);
}

export interface SizedWord {
  text: string;
  count: number;
  units: number;
}

const compareCodePoints = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Most votes first, ties by text, so the same votes always draw the same cloud. */
export function sizeWords(words: readonly WordCount[]): SizedWord[] {
  if (words.length === 0) return [];
  const counts = words.map((w) => w.count);
  const min = Math.min(...counts);
  const max = Math.max(...counts);
  return [...words]
    .sort((a, b) => b.count - a.count || compareCodePoints(a.text, b.text))
    .map((w) => ({ text: w.text, count: w.count, units: wordUnits(w.count, min, max) }));
}

export interface RatingBar {
  value: number;
  count: number;
  /** 0-1 of the tallest bar, so the tallest always reaches the top. */
  height: number;
}

export function ratingBars(histogram: readonly number[]): RatingBar[] {
  const tallest = Math.max(0, ...histogram);
  return histogram.map((count, i) => ({
    value: i + 1,
    count,
    height: tallest > 0 ? count / tallest : 0,
  }));
}

export function formatAverage(average: number | null): string {
  return average === null ? 'No ratings yet' : average.toFixed(1);
}

/** "12" -> "12", 1234 -> "1,234": the same digits on the big screen and on phones. */
export function groupDigits(n: number): string {
  return n.toLocaleString('en-US');
}

/** "482915" -> "482 915", the way a PIN is read out. */
export function formatPin(pin: string): string {
  return pin.length === 6 ? `${pin.slice(0, 3)} ${pin.slice(3)}` : pin;
}

/**
 * Where a phone goes to join with the PIN filled in. `joinUrl` may already carry a query.
 * Falls back to plain concatenation for a URL the browser cannot parse.
 */
export function joinLink(joinUrl: string, pin: string): string {
  try {
    const url = new URL(joinUrl);
    url.searchParams.set('pin', pin);
    return url.toString();
  } catch {
    return `${joinUrl}${joinUrl.includes('?') ? '&' : '?'}pin=${pin}`;
  }
}
