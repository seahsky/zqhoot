/** Most buttons that share one row on a phone: 48px each with 12px gaps fits 288px. */
const ONE_ROW_MAX = 5;

/**
 * Buttons per row when a scale wraps. Up to five stay together; beyond that it is split in
 * two, the first row taking the extra one (7 is 4 + 3, 10 is 5 + 5), so a scale never ends
 * in a lone button or two orphans.
 */
export function ratingColumns(max: number): number {
  return max <= ONE_ROW_MAX ? max : Math.ceil(max / 2);
}
