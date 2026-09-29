// Seeded PRNG (mulberry32) so a run's traffic pattern is reproducible: the same ZQ_SEED gives every
// player the same join jitter, answer delays, choices and reconnect point.

const hash = (a, b) => {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
};

/** One independent stream per (seed, stream) pair, e.g. one per player. */
export function makeRng(seed, stream) {
  let a = hash(seed, stream);
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => {
    // Box-Muller; 1 - next() keeps the argument of log() above zero.
    const u = 1 - next();
    const v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  return {
    next,
    range: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p) => next() < p,
    pick: (items) => items[Math.floor(next() * items.length)],
    normal,
    lognormal: (median, sigma) => Math.exp(Math.log(median) + sigma * normal()),
  };
}

/**
 * Evenly spreads `ratio` of the players over the index range: exactly round(ratio * n) of n
 * consecutive indices, chosen by index alone so the choice never depends on timing.
 */
export function isSelected(index, ratio) {
  return Math.floor((index + 1) * ratio + 1e-9) > Math.floor(index * ratio + 1e-9);
}
