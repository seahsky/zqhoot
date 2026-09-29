import { formatNumber } from '../../state/format.ts';

export interface Figure {
  value: string;
  label: string;
}

/** The score as a value and its unit, for a card that shows each fact on its own. */
export function scoreFigure(score: number): Figure {
  return { value: formatNumber(score), label: score === 1 ? 'point' : 'points' };
}
