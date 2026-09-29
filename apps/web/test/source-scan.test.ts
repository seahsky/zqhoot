import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const files = [...walk(join(webRoot, 'src')), join(webRoot, 'index.html')].filter((f) =>
  /\.(ts|tsx|css|html)$/.test(f),
);

/** ADR-0013: no HTML injection or dynamic code; ADR-0016: no CDN, font or network asset. */
const FORBIDDEN: Array<[string, RegExp]> = [
  ['dangerouslySetInnerHTML', /dangerouslySetInnerHTML/],
  ['eval(', /\beval\s*\(/],
  ['new Function(', /new\s+Function\s*\(/],
  ['innerHTML', /\.(inner|outer)HTML\b/],
  ['document.write', /document\.write/],
  ['a plain http:// URL', /http:\/\//],
  ['an external https:// URL', /https:\/\//],
  ['protocol-relative URL', /["'(]\/\/[a-z0-9.-]+\.[a-z]{2,}/i],
  ['maximum-scale / user-scalable=no', /maximum-scale|user-scalable\s*=\s*no/],
  ['@import url', /@import\s+url/],
];

/**
 * Requirement 6 and ADR-0016: no string, name or domain from the do-not-copy lists of
 * docs/research/kahoot.md section 11 and docs/research/mentimeter.md section 9. Each entry is
 * the string and a sample the pattern must match, so a pattern that stops matching fails
 * `matches its own sample` instead of quietly passing.
 */
const DO_NOT_COPY: Array<[string, RegExp, string]> = [
  ['Game over', /game\s+over/i, 'Game over'],
  ['Play again', /play\s+again/i, 'Play Again'],
  ['Spin!', /\bspin!/i, 'Spin!'],
  ['Team talk', /team\s+talk/i, 'Team talk'],
  ['Lock game joining', /lock\s+game\s+joining/i, 'Lock game joining'],
  ['Host live', /\bhost\s+live\b/i, 'Host live'],
  [
    'Please wait for the presenter',
    /please\s+wait\s+for\s+the\s+presenter/i,
    'Please wait for the presenter',
  ],
  ['Presentation is closed', /presentation\s+is\s+closed/i, 'Presentation is closed'],
  ['Open Q and A', /open\s+q\s+and\s+a\b/i, 'Open Q and A'],
  ['Show question!', /show\s+question!/i, 'Show question!'],
  ['Participate again', /participate\s+again/i, 'Participate again'],
  ['Go to slide', /go\s+to\s+slide/i, 'Go to slide'],
  ['game pin', /game\s+pin/i, 'Game PIN'],
  [
    "See questions on participant's screen",
    /see\s+questions\s+on\s+participant/i,
    "See questions on participant's screen",
  ],
  ['Set correct area', /set\s+correct\s+area/i, 'Set correct area'],
  ['kahoot', /kahoot/i, 'kahoot.it'],
  ['mentimeter', /mentimeter/i, 'Mentimeter'],
  ['menti', /\bmenti\b|\bmentimote\b/i, 'Menti Live'],
];

describe('source scan', () => {
  it('finds the source it is meant to scan', () => {
    expect(files.length).toBeGreaterThan(40);
    expect(files.some((f) => f.endsWith('index.html'))).toBe(true);
  });

  for (const [name, pattern] of FORBIDDEN) {
    it(`contains no ${name}`, () => {
      const hits = files.filter((f) => pattern.test(readFileSync(f, 'utf8')));
      expect(hits.map((f) => relative(webRoot, f))).toEqual([]);
    });
  }

  for (const [name, pattern, sample] of DO_NOT_COPY) {
    it(`matches its own sample: ${name}`, () => {
      expect(pattern.test(sample)).toBe(true);
      expect(pattern.test(sample.toUpperCase())).toBe(true);
      expect(pattern.test(sample.toLowerCase())).toBe(true);
    });

    it(`contains no "${name}" (do-not-copy copy)`, () => {
      const hits = files.filter((f) => pattern.test(readFileSync(f, 'utf8')));
      expect(hits.map((f) => relative(webRoot, f))).toEqual([]);
    });
  }

  it('does not flag ordinary words that merely contain a brand name', () => {
    const menti = DO_NOT_COPY.find(([name]) => name === 'menti')?.[1] as RegExp;
    for (const word of ['mention', 'sentiment', 'augmented', 'comments', 'documentation']) {
      expect(menti.test(word), word).toBe(false);
    }
  });

  it('sets the viewport meta the design requires', () => {
    const html = readFileSync(join(webRoot, 'index.html'), 'utf8');
    expect(html).toContain('width=device-width, initial-scale=1, viewport-fit=cover');
    expect(html).toContain('<html lang="en">');
    expect(html).toMatch(/<meta name="theme-color"/);
  });
});
