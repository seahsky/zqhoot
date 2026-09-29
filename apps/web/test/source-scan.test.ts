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

  it('sets the viewport meta the design requires', () => {
    const html = readFileSync(join(webRoot, 'index.html'), 'utf8');
    expect(html).toContain('width=device-width, initial-scale=1, viewport-fit=cover');
    expect(html).toContain('<html lang="en">');
    expect(html).toMatch(/<meta name="theme-color"/);
  });
});
