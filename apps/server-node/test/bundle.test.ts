import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bundle } from '../scripts/bundle.ts';
import {
  ADMIN_PASSWORD,
  ADMIN_USER,
  JWT_SECRET,
  PUBLIC_URL,
  createWorkspace,
} from './helpers/server.ts';
import type { Workspace } from './helpers/server.ts';

let out: string;
let workspace: Workspace;

beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), 'zqhoot-bundle-'));
  workspace = await createWorkspace();
  await bundle(join(out, 'dist'), 'silent');
}, 60_000);

afterAll(async () => {
  await rm(out, { recursive: true, force: true });
  await workspace.cleanup();
});

describe('the esbuild bundle', () => {
  it('produces the two entry files with source maps and needs no node_modules', async () => {
    expect((await readdir(join(out, 'dist'))).sort()).toEqual([
      'hash-password.mjs',
      'hash-password.mjs.map',
      'server.mjs',
      'server.mjs.map',
    ]);
    const server = await readFile(join(out, 'dist', 'server.mjs'), 'utf8');
    // Workspace packages and npm dependencies are inlined: the only imports left are Node built-ins.
    const imported = [...server.matchAll(/^import\b[^;]*?\bfrom\s+["']([^"']+)["']/gm)].map(
      (m) => m[1],
    );
    expect(imported.length).toBeGreaterThan(0);
    expect(imported.filter((specifier) => !specifier?.startsWith('node:'))).toEqual([]);
    expect(server).toContain('createRequire');
  });

  it('starts from the bundle alone, serves /api/health and stops on SIGTERM', async () => {
    let child: ChildProcess | undefined;
    try {
      child = spawn(process.execPath, ['--enable-source-maps', join(out, 'dist', 'server.mjs')], {
        cwd: out,
        env: {
          PATH: process.env.PATH ?? '',
          ZQ_PORT: '0',
          ZQ_HOST: '127.0.0.1',
          ZQ_PUBLIC_URL: PUBLIC_URL,
          ZQ_DATA_DIR: workspace.dataDir,
          ZQ_WEB_DIST: workspace.webDist,
          ZQ_ADMIN_USER: ADMIN_USER,
          ZQ_ADMIN_PASSWORD: ADMIN_PASSWORD,
          ZQ_JWT_SECRET: JWT_SECRET,
        },
      });
      let output = '';
      let errors = '';
      child.stdout?.on('data', (d: Buffer) => (output += d.toString()));
      child.stderr?.on('data', (d: Buffer) => (errors += d.toString()));
      const exited = new Promise<number | null>((resolve) => child?.on('close', resolve));

      const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`no listening line\n${output}\n${errors}`)),
          15_000,
        );
        const check = (): void => {
          const line = output.split('\n').find((l) => l.includes('zqhoot server listening'));
          if (line === undefined) return;
          clearTimeout(timer);
          resolve((JSON.parse(line) as { port: number }).port);
        };
        child?.stdout?.on('data', check);
        check();
      });
      const health = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(await health.json()).toMatchObject({ ok: true, target: 'vm' });

      child.kill('SIGTERM');
      expect(await exited).toBe(0);
      expect(errors).not.toMatch(/Error|Cannot find|not supported/);
    } finally {
      child?.kill('SIGKILL');
    }
  });

  it('bundles the hash-password CLI', async () => {
    const hash = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [join(out, 'dist', 'hash-password.mjs')], { cwd: out });
      let stdout = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0 ? resolve(stdout) : reject(new Error(`exit ${code}`)),
      );
      child.stdin.end('a password for the bundle test\n');
    });
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$/);
  });
});
