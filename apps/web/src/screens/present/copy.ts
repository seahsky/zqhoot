/** Wording shared by the presenter screens, as pure functions so it is unit-tested. */

import { groupDigits } from '../../state/charts.ts';

/** The one wording of the answer count, on every presenter screen: "377 of 1,200 answered". */
export function answeredText(answered: number, totalPlayers: number): string {
  return `${groupDigits(answered)} of ${groupDigits(totalPlayers)} answered`;
}

/** The running header's left side: "Question 3 of 10", with " · Results" once the question is closed. */
export function eyebrowText(index: number, total: number, results: boolean): string {
  return `Question ${index + 1} of ${total}${results ? ' · Results' : ''}`;
}

/** Points gained on the last question, "+0" included: an empty cell reads as missing data. */
export function gainText(delta: number): string {
  return `+${groupDigits(delta > 0 ? delta : 0)}`;
}
