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
  rows: number;
  cols: number;
  colWidthU: number;
  rowHeightU: number;
  /** Names drawn. When some are left out the last cell says "+N more". */
  shown: number;
  more: number;
}

/** Steps from the biggest legible size to the ADR-0016 floor for essential text. */
const WALL_FONTS_U = [6.5, 6, 5.5, 5, 4.6, 4.3];
const WALL_PAD_X_U = 2.4;
const WALL_GAP_X_U = 1.4;
const WALL_ROW_GAP_U = 0.8;
const WALL_LINE = 1.2;
const WALL_PAD_Y_U = 0.9;
const MAX_NAME_GRAPHEMES = 16;

function nameEm(names: readonly string[]): number {
  let widest = 0;
  for (const name of names) {
    widest = Math.max(widest, textWidthEm(Array.from(name).slice(0, MAX_NAME_GRAPHEMES).join('')));
  }
  return widest;
}

/**
 * Flowing columns, largest font first: the biggest step at which every name fits, else the
 * smallest step with as many names as fit and the rest counted in "+N more" (which takes one
 * cell). `names` are newest first, so the ones dropped are the oldest.
 */
export function nameWall(names: readonly string[], widthU: number, heightU: number): WallLayout {
  const widestEm = nameEm(names);
  let last: WallLayout | null = null;
  for (const fontU of WALL_FONTS_U) {
    // 8% over the model: hinting and kerning move real glyphs by a pixel or two.
    const colWidthU = widestEm * fontU * 1.08 + 2 * WALL_PAD_X_U;
    const rowHeightU = fontU * WALL_LINE + 2 * WALL_PAD_Y_U;
    const cols = Math.max(1, Math.floor((widthU + WALL_GAP_X_U) / (colWidthU + WALL_GAP_X_U)));
    const rows = Math.max(
      1,
      Math.floor((heightU + WALL_ROW_GAP_U) / (rowHeightU + WALL_ROW_GAP_U)),
    );
    const capacity = rows * cols;
    const fits = names.length <= capacity;
    const shown = fits ? names.length : Math.max(0, capacity - 1);
    last = {
      fontU,
      rows,
      cols,
      colWidthU: Math.min(colWidthU, (widthU - (cols - 1) * WALL_GAP_X_U) / cols),
      rowHeightU,
      shown,
      more: names.length - shown,
    };
    if (fits) return last;
  }
  return last as WallLayout;
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
