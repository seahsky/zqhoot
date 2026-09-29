import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const viteBin = join(
  dirname(createRequire(import.meta.url).resolve('vite/package.json')),
  'bin/vite.js',
);
const scratch = mkdtempSync(join(tmpdir(), 'zqhoot-web-build-'));

/** Strings that only exist because of the gallery, its fixtures, or its registry. */
const MARKERS = [
  'data-gallery-screen',
  'Screen gallery',
  'play-answer-poll-6',
  'Friday night trivia',
  'question-planet',
  'player-riley-01',
];

function build(name: string, galleryFlag: string | undefined): string {
  const outDir = join(scratch, name);
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production' };
  delete env.VITE_ENABLE_GALLERY;
  if (galleryFlag !== undefined) env.VITE_ENABLE_GALLERY = galleryFlag;
  execFileSync(
    process.execPath,
    [viteBin, 'build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'error'],
    { cwd: webRoot, env, stdio: 'pipe' },
  );
  return outDir;
}

function outputText(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (d: string) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) visit(path);
      else if (/\.(js|css|html|json|map)$/.test(name)) out.set(path, readFileSync(path, 'utf8'));
    }
  };
  visit(dir);
  return out;
}

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('production build', () => {
  it('contains no gallery or fixture code without VITE_ENABLE_GALLERY', () => {
    const files = outputText(build('plain', undefined));
    expect(files.size).toBeGreaterThan(2);
    for (const [path, text] of files) {
      for (const marker of MARKERS) {
        expect(text.includes(marker), `${marker} found in ${path}`).toBe(false);
      }
    }
    // No chunk is named after the gallery either: the dynamic import must be gone.
    expect([...files.keys()].some((p) => /gallery/i.test(p))).toBe(false);
  }, 120_000);

  // `pnpm build` writes dist/; the e2e server builds into dist-e2e/, so a gallery build
  // can never end up here unless somebody sets the flag by hand.
  it.skipIf(!existsSync(join(webRoot, 'dist')))('leaves no gallery code in dist/', () => {
    const files = outputText(join(webRoot, 'dist'));
    for (const [path, text] of files) {
      for (const marker of MARKERS) {
        expect(text.includes(marker), `${marker} found in ${path}`).toBe(false);
      }
    }
  });

  it('does include the gallery when the flag is 1 (so the check above can fail)', () => {
    const text = [...outputText(build('gallery', '1')).values()].join('\n');
    for (const marker of MARKERS) expect(text, marker).toContain(marker);
  }, 120_000);

  it('treats any other flag value as off', () => {
    const text = [...outputText(build('flag-0', '0')).values()].join('\n');
    expect(text).not.toContain('data-gallery-screen');
  }, 120_000);
});
