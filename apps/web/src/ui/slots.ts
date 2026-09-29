/** The six answer identities from ADR-0016: letter + shape + colour token. */
export const SLOTS = [
  { letter: 'A', shape: 'hexagon', token: '--ans-a' },
  { letter: 'B', shape: 'plus', token: '--ans-b' },
  { letter: 'C', shape: 'star', token: '--ans-c' },
  { letter: 'D', shape: 'dome', token: '--ans-d' },
  { letter: 'E', shape: 'pentagon', token: '--ans-e' },
  { letter: 'F', shape: 'cross', token: '--ans-f' },
] as const;
