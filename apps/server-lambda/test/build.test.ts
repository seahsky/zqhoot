import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDirs: string[] = [];

/** Runs the real build script into a scratch directory, leaving dist/ alone. */
function build(env: Record<string, string> = {}) {
  const outDir = mkdtempSync(join(tmpdir(), 'zqhoot-build-'));
  outDirs.push(outDir);
  const result = spawnSync(process.execPath, [join(root, 'scripts/build.mjs')], {
    cwd: root,
    env: { ...process.env, ZQ_BUILD_OUT_DIR: outDir, ...env },
    encoding: 'utf8',
  });
  return { outDir, ...result };
}

afterAll(() => {
  for (const dir of outDirs) rmSync(dir, { recursive: true, force: true });
});

describe('scripts/build.mjs', () => {
  it('fails the build, naming the bundle, when a zip is over the size limit', () => {
    const result = build({ ZQ_BUILD_MAX_ZIP_BYTES: '100000' });
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/ws: index\.mjs [\d.]+ MB, ws\.zip [\d.]+ MB .*FAIL/);
    expect(result.stdout).toMatch(/http: .*FAIL/);
    expect(result.stderr).toContain('build failed');
  });

  it('prints both bundle sizes and passes under the real 5 MB limit', () => {
    const result = build();
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/ws: index\.mjs [\d.]+ MB, ws\.zip [\d.]+ MB/);
    expect(result.stdout).toMatch(/http: index\.mjs [\d.]+ MB, http\.zip [\d.]+ MB/);
    expect(result.stdout).not.toContain('FAIL');
  });

  it('produces byte-identical zips on every build, so Terraform sees no change', () => {
    const first = build();
    const second = build();
    for (const name of ['ws.zip', 'http.zip']) {
      const a = readFileSync(join(first.outDir, name));
      const b = readFileSync(join(second.outDir, name));
      expect(a.equals(b), name).toBe(true);
    }
  });
});
