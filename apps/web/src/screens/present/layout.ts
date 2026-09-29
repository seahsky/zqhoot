import { groupDigits } from '../../state/charts.ts';
import type { SizedWord } from '../../state/charts.ts';

/**
 * Text fitting for the presenter stage, in stage units (1u = 1% of the stage height). CSS
 * cannot size text to its box, and an overflowing projector screen is a failure the room
 * sees, so every list and paragraph is measured here with a deliberately pessimistic model of
 * a bold system font (`charEm`) plus slack for ragged word wrapping. Real fonts are narrower,
 * so the estimate errs towards a smaller, safe size.
 */

/** Stage 16:9 in units: 177.8u wide, 100u tall. Padding is 5cqh top and bottom, 5cqw at the sides. */
export const STAGE_WIDTH_U = (100 * 16) / 9;
export const STAGE_PAD_Y_U = 5;
export const STAGE_PAD_X_U = STAGE_WIDTH_U * 0.05;
export const CONTENT_WIDTH_U = STAGE_WIDTH_U - 2 * STAGE_PAD_X_U;
export const CONTENT_HEIGHT_U = 100 - 2 * STAGE_PAD_Y_U;

/** Word wrapping leaves ragged lines, so a paragraph needs more lines than its length suggests. */
const WRAP_SLACK = 1.18;

const NARROW = new Set(['i', 'l', 'j', 't', 'f', 'r', 'I', '.', ',', ':', ';', '!', '|', "'", '"']);
const WIDE_LOWER = new Set(['m', 'w']);
const WIDE_UPPER = new Set(['M', 'W']);

/**
 * Width of one character in ems, for a bold system font. Deliberately DejaVu Sans Bold-like,
 * the widest common face (a lowercase letter is about 0.65 em, a capital 0.78, "m" and "w" a
 * full em, "i" and "l" a third), so what fits here fits in Segoe UI, San Francisco or Roboto
 * too, which are all narrower. Fullwidth scripts and emoji are one em.
 */
export function charEm(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp >= 0x1100) return 1;
  if (ch === ' ') return 0.35;
  if (NARROW.has(ch)) return 0.4;
  if (WIDE_LOWER.has(ch)) return 1;
  if (WIDE_UPPER.has(ch)) return 1.05;
  if (ch >= 'A' && ch <= 'Z') return 0.78;
  if (ch >= '0' && ch <= '9') return 0.7;
  return 0.66;
}

/** Width of `text` in ems. */
export function textWidthEm(text: string): number {
  let em = 0;
  for (const ch of text) em += charEm(ch);
  return em;
}

export function linesFor(text: string, fontU: number, widthU: number): number {
  if (widthU <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.ceil((textWidthEm(text) * fontU * WRAP_SLACK) / widthU));
}

export interface FitOptions {
  text: string;
  widthU: number;
  heightU: number;
  /** Largest size to try, already multiplied by the text-size control. */
  maxU: number;
  /** Smallest size; returned when even that does not fit. */
  minU: number;
  lineHeight: number;
  stepU?: number;
}

/** The largest size in [minU, maxU] whose `heightAt` fits `budgetU`; `minU` when none does. */
export function fitBy(o: {
  maxU: number;
  minU: number;
  budgetU: number;
  heightAt: (sizeU: number) => number;
  stepU?: number;
}): number {
  const step = o.stepU ?? 0.25;
  for (let size = o.maxU; size > o.minU; size -= step) {
    if (o.heightAt(size) <= o.budgetU) return size;
  }
  return o.minU;
}

/** The largest size in [minU, maxU] at which the paragraph fits its box. */
export function fitFontUnits(o: FitOptions): number {
  return fitBy({
    maxU: o.maxU,
    minU: o.minU,
    budgetU: o.heightU,
    ...(o.stepU !== undefined ? { stepU: o.stepU } : {}),
    heightAt: (size) => linesFor(o.text, size, o.widthU) * size * o.lineHeight,
  });
}

/**
 * Lines a paragraph needs when a box floated to its right shortens the first lines: the ones
 * that start above the bottom of the float have `widthU - floatW`, the rest the full width.
 */
export function flowedLines(
  text: string,
  fontU: number,
  widthU: number,
  floatW: number,
  floatH: number,
  lineHeight: number,
): number {
  const total = textWidthEm(text) * fontU * WRAP_SLACK;
  const narrow = Math.max(1, widthU - floatW);
  const narrowLines = Math.max(1, Math.ceil(floatH / (fontU * lineHeight)));
  if (total <= narrow * narrowLines) return Math.max(1, Math.ceil(total / narrow));
  return narrowLines + Math.ceil((total - narrow * narrowLines) / widthU);
}

// ---------------------------------------------------------------------------
// Nickname wall
// ---------------------------------------------------------------------------

export interface WallLayout {
  fontU: number;
  /** Height of one name, and the padding and gaps around it, all in u. */
  rowHeightU: number;
  padXU: number;
  gapXU: number;
  gapYU: number;
  /** Rows the box holds at this size. */
  rows: number;
  /** Names drawn. When some are left out the last chip says "+N more". */
  shown: number;
  more: number;
}

/**
 * Name sizes, from the biggest to the ADR-0016 floor for non-essential text (a player only has
 * to spot their own name). The wall takes the largest one at which every name fits.
 */
export const WALL_FONTS_U = [5, 4.6, 4.3, 4, 3.75, 3.5];
const WALL_LINE = 1.15;
/** Longest nickname in graphemes; the wall never has to fit more than this of a name. */
const MAX_NAME_GRAPHEMES = 16;
/** The model is already pessimistic (`charEm`); this covers hinting and kerning. */
const WALL_WIDTH_SLACK = 1.08;

/** Chip metrics scale with the type: a smaller name needs less air around it. */
export function wallMetrics(fontU: number) {
  return {
    padXU: fontU * 0.3,
    rowHeightU: fontU * (WALL_LINE + 0.18),
    gapXU: fontU * 0.2,
    gapYU: fontU * 0.16,
  };
}

/** Chips placed left to right, wrapping to a new row when the next one would not fit. */
class Shelf {
  #row = 0;
  #x = 0;

  constructor(
    private readonly widthU: number,
    private readonly gapU: number,
  ) {}

  /** The row a chip of width `w` would land in; nothing is placed. */
  rowFor(w: number): number {
    return this.#x > 0 && this.#x + this.gapU + w > this.widthU ? this.#row + 1 : this.#row;
  }

  add(w: number): void {
    const row = this.rowFor(w);
    this.#x = row === this.#row && this.#x > 0 ? this.#x + this.gapU + w : w;
    this.#row = row;
  }
}

/**
 * Names are laid out as flowing chips, left to right and row after row, newest first (`names`
 * arrive that way), so a short name costs its own width rather than a column's. The browser does
 * the same with `flex-wrap`, and the widths here are pessimistic, so it never needs more rows
 * than this predicts.
 *
 * The largest size at which every name fits is used. Only when even the floor overflows are the
 * oldest names left out and counted in "+N more", which takes the place of the last chip.
 */
export function nameWall(names: readonly string[], widthU: number, heightU: number): WallLayout {
  const ems = names.map((n) => textWidthEm(Array.from(n).slice(0, MAX_NAME_GRAPHEMES).join('')));
  const moreEm = textWidthEm(`+${groupDigits(names.length)} more`);
  let last: WallLayout | null = null;
  for (const fontU of WALL_FONTS_U) {
    const m = wallMetrics(fontU);
    const rows = Math.max(1, Math.floor((heightU + m.gapYU) / (m.rowHeightU + m.gapYU)));
    const widths = ems.map((em) => em * fontU * WALL_WIDTH_SLACK + 2 * m.padXU);
    // The "+N more" chip is heavier and outlined, so it gets a little more than its text.
    const moreWidth = moreEm * fontU * 1.15 + 2 * m.padXU + 1;

    const shelf = new Shelf(widthU, m.gapXU);
    let fitting = 0;
    let beforeMore = 0;
    for (const w of widths) {
      if (shelf.rowFor(moreWidth) < rows) beforeMore = fitting;
      if (shelf.rowFor(w) >= rows) break;
      shelf.add(w);
      fitting += 1;
    }
    if (fitting === names.length) return { fontU, ...m, rows, shown: fitting, more: 0 };
    last = { fontU, ...m, rows, shown: beforeMore, more: names.length - beforeMore };
  }
  return last as WallLayout;
}

/** The QR code and the gap between it and the join block (Present.module.css). */
const QR_U = 27;
const QR_GAP_U = 4;
/** Gap between the join block and the wall (`.screen`). */
const SCREEN_GAP_U = 2;
/** Room kept in hand: real glyphs and line boxes are never exactly what the model says. */
const WALL_SLACK_U = 1.5;
/** A long quiz title is cut to this many lines so it cannot squeeze the wall. */
export const TITLE_MAX_LINES = 2;

/**
 * Height in u the name wall can use under the join block: the stage's content height less the
 * block and a little slack. The block is the quiz title (5u, clamped to two lines), the join
 * line (4.5u, may wrap) and the row of PIN (label and 10u digits) with the room's count beside
 * it. The heights are measured from the rendered page at 100%, 125% and 150%: the join line and
 * the PIN grow with `scale`, the count does not, and the QR code sets a floor.
 */
export function lobbyWallHeightU(o: {
  title: string;
  joinUrl: string;
  scale: number;
  hasQr: boolean;
  /** "Joining locked" adds a line to the count. */
  locked?: boolean;
}): number {
  const joinWidthU = CONTENT_WIDTH_U - (o.hasQr ? QR_U + QR_GAP_U : 0);
  const titleLines = Math.min(TITLE_MAX_LINES, linesFor(o.title, 5, joinWidthU));
  const urlLines = linesFor(`Join at ${o.joinUrl}`, 4.5 * o.scale, joinWidthU);
  const pinRow = Math.max(4.8 + 10.5 * o.scale, 10.4 + (o.locked ? 6.1 : 0));
  const block = Math.max(
    o.hasQr ? QR_U : 0,
    5.75 * titleLines + 0.6 + 5.4 * o.scale * urlLines + 0.6 + pinRow,
  );
  return CONTENT_HEIGHT_U - block - SCREEN_GAP_U - WALL_SLACK_U;
}

// ---------------------------------------------------------------------------
// Word cloud
// ---------------------------------------------------------------------------

const CLOUD_PAD_X_U = 1.2;
const CLOUD_PAD_Y_U = 0.5;
const CLOUD_GAP_U = 1.4;
const CLOUD_LINE = 1.15;

function cloudHeightU(
  words: readonly SizedWord[],
  sizes: readonly number[],
  widthU: number,
): number {
  let lineWidth = 0;
  let lineHeight = 0;
  let total = 0;
  let lines = 0;
  words.forEach((w, i) => {
    const size = sizes[i] as number;
    const boxW = textWidthEm(w.text) * size * WRAP_SLACK + 2 * CLOUD_PAD_X_U;
    const boxH = size * CLOUD_LINE + 2 * CLOUD_PAD_Y_U;
    if (lineWidth > 0 && lineWidth + CLOUD_GAP_U + boxW > widthU) {
      total += lineHeight;
      lines += 1;
      lineWidth = 0;
      lineHeight = 0;
    }
    lineWidth += (lineWidth > 0 ? CLOUD_GAP_U : 0) + boxW;
    lineHeight = Math.max(lineHeight, boxH);
  });
  if (lineHeight > 0) {
    total += lineHeight;
    lines += 1;
  }
  return total + Math.max(0, lines - 1) * CLOUD_GAP_U;
}

export interface CloudLayout {
  words: Array<SizedWord & { drawnUnits: number }>;
  /** Least-voted words left out when the cloud would not fit. */
  hidden: number;
}

/**
 * Words are already ordered and sized by vote (state/charts.ts). If the cloud is too big for
 * its box the whole scale shrinks towards the 4.3u floor, then the least-voted words drop
 * out. The order never changes, so the same votes always draw the same cloud.
 */
export function cloudLayout(
  words: readonly SizedWord[],
  widthU: number,
  heightU: number,
  floorU = 4.3,
): CloudLayout {
  let keep = words.length;
  for (;;) {
    const subset = words.slice(0, keep);
    for (const factor of [1, 0.9, 0.8, 0.7, 0.6, 0.5]) {
      const sizes = subset.map((w) => Math.max(floorU, w.units * factor));
      if (cloudHeightU(subset, sizes, widthU) <= heightU) {
        return {
          words: subset.map((w, i) => ({ ...w, drawnUnits: sizes[i] as number })),
          hidden: words.length - keep,
        };
      }
    }
    if (keep <= 1) {
      return {
        words: words.slice(0, 1).map((w) => ({ ...w, drawnUnits: floorU })),
        hidden: Math.max(0, words.length - 1),
      };
    }
    keep = Math.max(1, Math.floor(keep * 0.9));
  }
}

// ---------------------------------------------------------------------------
// Open-ended wall
// ---------------------------------------------------------------------------

const CARD_PAD_U = 1.6;
const CARD_BORDER_U = 0.6;
const CARD_GAP_U = 1.6;
const CARD_LINE = 1.3;

export interface WallPages {
  cols: number;
  fontU: number;
  /** Pages of columns of indexes into the input, newest first (reading order: down, then across). */
  pages: number[][][];
}

/**
 * Cards are dealt into columns, each next one into the shortest, so a long response does not
 * leave a hole beside it. A page is full when the shortest column cannot take the next card.
 * Fewer, wider columns are used when one long response would not fit a card in the narrower
 * layout.
 */
export function paginateCards(
  texts: readonly string[],
  widthU: number,
  heightU: number,
  fontU = 4.5,
): WallPages {
  const cardHeight = (text: string, cols: number): number => {
    const colWidth = (widthU - (cols - 1) * CARD_GAP_U) / cols;
    const inner = colWidth - 2 * CARD_PAD_U - 2 * CARD_BORDER_U;
    return linesFor(text, fontU, inner) * fontU * CARD_LINE + 2 * (CARD_PAD_U + CARD_BORDER_U);
  };
  const cols = [3, 2, 1].find((c) => texts.every((t) => cardHeight(t, c) <= heightU)) ?? 1;

  const pages: number[][][] = [];
  let columns: number[][] = Array.from({ length: cols }, () => []);
  let used: number[] = new Array<number>(cols).fill(0);
  texts.forEach((text, i) => {
    const h = cardHeight(text, cols);
    let at = used.indexOf(Math.min(...used));
    const next = (used[at] as number) + (used[at] === 0 ? 0 : CARD_GAP_U) + h;
    if (next > heightU && columns.some((c) => c.length > 0)) {
      pages.push(columns);
      columns = Array.from({ length: cols }, () => []);
      used = new Array<number>(cols).fill(0);
      at = 0;
    }
    (columns[at] as number[]).push(i);
    used[at] = (used[at] as number) === 0 ? h : (used[at] as number) + CARD_GAP_U + h;
  });
  if (texts.length > 0) pages.push(columns);
  return { cols, fontU, pages };
}
