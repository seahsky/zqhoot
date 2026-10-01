import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'));

const stripComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Every module specifier a file imports or re-exports, static or dynamic. */
function specifiers(code: string): string[] {
  const found = [
    ...code.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/g),
    ...code.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g),
    ...code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g),
    ...code.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]/g),
  ];
  return found.map((m) => m[1] as string);
}

/**
 * ADR-0001: the service runs on Node (VM) and Lambda alike, so it may not reach for either
 * runtime directly. Adapters provide those through the ports.
 */
describe('src/ stays runtime-agnostic', () => {
  it('scans every source file', () => {
    expect(files).toEqual(
      expect.arrayContaining([
        'crypto.ts',
        'delivery.ts',
        'game-service.ts',
        'http-app.ts',
        'index.ts',
        'lru.ts',
        'ports.ts',
        'transport-util.ts',
      ]),
    );
  });

  it.each(files)('%s imports only the workspace packages, hono and sibling files', (file) => {
    const code = stripComments(readFileSync(join(SRC, file), 'utf8'));
    for (const spec of specifiers(code)) {
      const allowed =
        /^\.\/[\w-]+\.ts$/.test(spec) ||
        ['@zqhoot/protocol', '@zqhoot/engine', '@zqhoot/store', 'hono'].includes(spec) ||
        spec.startsWith('hono/');
      expect(allowed, `${file} imports ${spec}`).toBe(true);
    }
  });

  it.each(files)('%s has no node:, AWS SDK, ws or aws-jwt-verify import', (file) => {
    const code = stripComments(readFileSync(join(SRC, file), 'utf8'));
    for (const spec of specifiers(code)) {
      expect(spec, file).not.toMatch(/^node:/);
      expect(spec, file).not.toMatch(/^@aws-sdk\//);
      expect(spec, file).not.toBe('ws');
      expect(spec, file).not.toBe('aws-jwt-verify');
    }
    expect(code, file).not.toMatch(/['"]node:/);
    expect(code, file).not.toMatch(/@aws-sdk|aws-jwt-verify|from\s+['"]ws['"]/);
  });

  it.each(files)('%s uses no Node-only globals', (file) => {
    const code = stripComments(readFileSync(join(SRC, file), 'utf8'));
    expect(code, file).not.toMatch(/\bBuffer\b/);
    expect(code, file).not.toMatch(/\bprocess\s*\./);
    expect(code, file).not.toMatch(/\b__dirname\b|\b__filename\b/);
    expect(code, file).not.toMatch(/\brequire\s*\(/);
  });

  it.each(files)('%s reads no clock or randomness of its own except through ports', (file) => {
    // `Date` may format a timestamp it was given; `Date.now` and `Math.random` would bypass the ports.
    const code = stripComments(readFileSync(join(SRC, file), 'utf8'));
    expect(code, file).not.toMatch(/\bDate\s*\.\s*now\b/);
    expect(code, file).not.toMatch(/\bnew\s+Date\s*\(\s*\)/);
    expect(code, file).not.toMatch(/\bMath\s*\.\s*random\b/);
  });
});
