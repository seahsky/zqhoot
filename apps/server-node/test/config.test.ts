import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.ts';
import type { ServerConfig } from '../src/config.ts';
import { hashPassword } from '../src/password-hash.ts';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const SECRET = 'x'.repeat(32);
const MINIMAL = {
  ZQ_PUBLIC_URL: 'https://quiz.example.com',
  ZQ_JWT_SECRET: SECRET,
  ZQ_ADMIN_PASSWORD: 'dev-only',
};
const noWebDist = { defaultWebDist: () => '/default/web' };

function ok(env: Record<string, string>, cwd = '/srv/app'): ServerConfig {
  const result = parseConfig(env, { cwd, ...noWebDist });
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.config;
}

function errors(env: Record<string, string>): string[] {
  const result = parseConfig(env, noWebDist);
  if (result.ok) throw new Error('expected the configuration to be rejected');
  return result.errors;
}

describe('parseConfig defaults', () => {
  it('needs only the public URL, the JWT secret and a password', () => {
    expect(ok(MINIMAL)).toEqual({
      port: 8080,
      host: '0.0.0.0',
      publicUrl: {
        origin: 'https://quiz.example.com',
        wsOrigin: 'wss://quiz.example.com',
        wsUrl: 'wss://quiz.example.com/ws',
        joinUrl: 'https://quiz.example.com/join',
        mediaBaseUrl: 'https://quiz.example.com/',
        secure: true,
        hostname: 'quiz.example.com',
      },
      dataDir: '/srv/app/data',
      store: { kind: 'memory' },
      admin: { user: 'admin', password: { kind: 'plain', password: 'dev-only' } },
      jwtSecret: SECRET,
      webDist: '/default/web',
      trustProxy: false,
      sessionTtlDays: 30,
      logLevel: 'info',
    });
  });

  it('reads every variable', () => {
    const hash = 'scrypt$1024$8$1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2g=';
    const config = ok(
      {
        ...MINIMAL,
        ZQ_PORT: '9000',
        ZQ_HOST: '127.0.0.1',
        ZQ_PUBLIC_URL: 'http://localhost:9000',
        ZQ_DATA_DIR: '/var/lib/zq',
        ZQ_STORE: 'dynamodb',
        ZQ_TABLE_NAME: 'zqhoot',
        ZQ_DDB_ENDPOINT: 'http://localhost:8000',
        AWS_REGION: 'eu-west-1',
        ZQ_ADMIN_USER: 'boss',
        ZQ_ADMIN_PASSWORD_HASH: hash,
        ZQ_WEB_DIST: 'public',
        ZQ_TRUST_PROXY: 'true',
        ZQ_SESSION_TTL_DAYS: '7',
        ZQ_LOG_LEVEL: 'debug',
      },
      '/srv/app',
    );
    expect(config).toMatchObject({
      port: 9000,
      host: '127.0.0.1',
      dataDir: '/var/lib/zq',
      store: {
        kind: 'dynamodb',
        tableName: 'zqhoot',
        region: 'eu-west-1',
        endpoint: 'http://localhost:8000',
      },
      admin: { user: 'boss', password: { kind: 'hash', hash } },
      webDist: resolve('/srv/app', 'public'),
      trustProxy: true,
      sessionTtlDays: 7,
      logLevel: 'debug',
    });
    expect(config.publicUrl).toMatchObject({
      origin: 'http://localhost:9000',
      wsUrl: 'ws://localhost:9000/ws',
      secure: false,
    });
  });

  it('treats empty values as unset, as a .env file with `KEY=` does', () => {
    const config = ok({ ...MINIMAL, ZQ_PORT: '', ZQ_ADMIN_PASSWORD_HASH: '', ZQ_LOG_LEVEL: '' });
    expect(config.port).toBe(8080);
    expect(config.admin.password.kind).toBe('plain');
    expect(config.logLevel).toBe('info');
  });

  it('normalises the public URL (case, default port, trailing slash)', () => {
    const config = ok({ ...MINIMAL, ZQ_PUBLIC_URL: 'HTTPS://Quiz.Example.com:443/' });
    expect(config.publicUrl.origin).toBe('https://quiz.example.com');
    expect(config.publicUrl.wsUrl).toBe('wss://quiz.example.com/ws');
  });

  it('warns about the plaintext password and about one that a hash overrides', () => {
    const plain = parseConfig(MINIMAL, noWebDist);
    expect(plain.ok && plain.warnings.join()).toMatch(/local development only/);
    const both = parseConfig(
      {
        ...MINIMAL,
        ZQ_ADMIN_PASSWORD_HASH: 'scrypt$1024$8$1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2g=',
      },
      noWebDist,
    );
    expect(both.ok && both.warnings.join()).toMatch(/ignored/);
    expect(both.ok && both.config.admin.password.kind).toBe('hash');
  });

  it('accepts a hash produced by hash-password', async () => {
    const config = ok({
      ...MINIMAL,
      ZQ_ADMIN_PASSWORD: '',
      ZQ_ADMIN_PASSWORD_HASH: await hashPassword('pw', { N: 1024, r: 8, p: 1 }),
    });
    expect(config.admin.password.kind).toBe('hash');
  });
});

describe('parseConfig rejects', () => {
  it('a missing public URL, secret and password, all at once', () => {
    const list = errors({});
    expect(list).toEqual(
      expect.arrayContaining([
        'ZQ_PUBLIC_URL: is required',
        'ZQ_JWT_SECRET: is required',
        expect.stringContaining('ZQ_ADMIN_PASSWORD_HASH: set ZQ_ADMIN_PASSWORD_HASH'),
      ]),
    );
  });

  it('a JWT secret under 32 bytes, counted in bytes rather than characters', () => {
    expect(errors({ ...MINIMAL, ZQ_JWT_SECRET: 'x'.repeat(31) })).toEqual([
      expect.stringMatching(/^ZQ_JWT_SECRET: must be at least 32 bytes/),
    ]);
    expect(ok({ ...MINIMAL, ZQ_JWT_SECRET: 'x'.repeat(32) }).jwtSecret).toHaveLength(32);
    // 16 two-byte characters are 32 bytes.
    expect(ok({ ...MINIMAL, ZQ_JWT_SECRET: 'é'.repeat(16) }).jwtSecret).toHaveLength(16);
  });

  it('does not put a rejected secret in the message', () => {
    const list = errors({ ...MINIMAL, ZQ_JWT_SECRET: 'tooshort' });
    expect(list.join()).not.toContain('tooshort');
  });

  it.each([
    ['ZQ_PORT', 'abc', /ZQ_PORT: must be a whole number/],
    ['ZQ_PORT', '70000', /ZQ_PORT: must be at most 65535/],
    ['ZQ_PORT', '-1', /ZQ_PORT: must be a whole number/],
    ['ZQ_STORE', 'redis', /ZQ_STORE: must be memory or dynamodb/],
    ['ZQ_TRUST_PROXY', 'maybe', /ZQ_TRUST_PROXY: must be true or false/],
    ['ZQ_SESSION_TTL_DAYS', '0', /ZQ_SESSION_TTL_DAYS: must be at least 1/],
    ['ZQ_LOG_LEVEL', 'loud', /ZQ_LOG_LEVEL: must be one of/],
    ['ZQ_ADMIN_PASSWORD_HASH', 'plaintext', /ZQ_ADMIN_PASSWORD_HASH: must look like scrypt/],
    ['ZQ_ADMIN_USER', 'a\nb', /ZQ_ADMIN_USER: must not contain control characters/],
    ['ZQ_DDB_ENDPOINT', 'not a url', /ZQ_DDB_ENDPOINT: must be a URL/],
  ])('%s=%j', (name, value, message) => {
    expect(errors({ ...MINIMAL, [name]: value }).join('\n')).toMatch(message);
  });

  it.each([
    ['quiz.example.com', /absolute URL/],
    ['ftp://quiz.example.com', /http:\/\/ or https:\/\//],
    ['https://quiz.example.com/app', /without a path/],
    ['https://quiz.example.com/?x=1', /without a path/],
    ['https://user:pw@quiz.example.com', /credentials/],
  ])('ZQ_PUBLIC_URL=%s', (value, message) => {
    expect(errors({ ...MINIMAL, ZQ_PUBLIC_URL: value })).toEqual([expect.stringMatching(message)]);
  });

  it('the dynamodb store without a table or region', () => {
    expect(errors({ ...MINIMAL, ZQ_STORE: 'dynamodb' })).toEqual(
      expect.arrayContaining([
        'ZQ_TABLE_NAME: is required when ZQ_STORE=dynamodb',
        'AWS_REGION: is required when ZQ_STORE=dynamodb',
      ]),
    );
  });
});

describe('the process', () => {
  /** Runs `src/main.ts` with only the given variables and returns how it ended. */
  async function run(
    env: Record<string, string>,
  ): Promise<{ code: number | null; stderr: string; stdout: string }> {
    const dataDir = await mkdtemp(join(tmpdir(), 'zqhoot-config-'));
    try {
      return await new Promise((resolveRun, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
          cwd: packageRoot,
          env: { PATH: process.env.PATH ?? '', ZQ_DATA_DIR: dataDir, ZQ_PORT: '0', ...env },
        });
        let stderr = '';
        let stdout = '';
        child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(
            new Error(`the server neither exited nor failed within 20 s\n${stdout}\n${stderr}`),
          );
        }, 20_000);
        child.on('close', (code) => {
          clearTimeout(timer);
          resolveRun({ code, stderr, stdout });
        });
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }

  it('exits non-zero with a clear message when ZQ_JWT_SECRET is missing', async () => {
    const { code, stderr } = await run({
      ZQ_PUBLIC_URL: 'http://localhost:8080',
      ZQ_ADMIN_PASSWORD: 'x',
    });
    expect(code).toBe(1);
    expect(stderr).toContain('invalid configuration');
    expect(stderr).toContain('ZQ_JWT_SECRET: is required');
  });

  it('exits non-zero with a clear message when ZQ_JWT_SECRET is too short', async () => {
    const { code, stderr } = await run({
      ZQ_PUBLIC_URL: 'http://localhost:8080',
      ZQ_ADMIN_PASSWORD: 'x',
      ZQ_JWT_SECRET: 'short',
    });
    expect(code).toBe(1);
    expect(stderr).toMatch(/ZQ_JWT_SECRET: must be at least 32 bytes/);
    expect(stderr).not.toContain('short\n');
  });

  it('exits non-zero listing every invalid variable', async () => {
    const { code, stderr } = await run({ ZQ_PORT: 'eighty', ZQ_STORE: 'nope' });
    expect(code).toBe(1);
    for (const name of [
      'ZQ_PORT',
      'ZQ_STORE',
      'ZQ_PUBLIC_URL',
      'ZQ_JWT_SECRET',
      'ZQ_ADMIN_PASSWORD_HASH',
    ]) {
      expect(stderr).toContain(name);
    }
  });
});
