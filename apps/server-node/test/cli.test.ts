import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LocalAuth } from '../src/ports/local-auth.ts';
import { SCRYPT_PARAMS, parsePasswordHash } from '../src/password-hash.ts';
import type { PasswordHash } from '../src/password-hash.ts';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

function hashPasswordCli(
  stdin: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'cli/hash-password.ts'], {
      cwd: packageRoot,
      env: { PATH: process.env.PATH ?? '' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

async function loginWith(hash: string, password: string): Promise<boolean> {
  const parsed = parsePasswordHash(hash) as PasswordHash;
  const auth = new LocalAuth({
    user: 'admin',
    password: parsed,
    secret: 'a-secret-that-is-comfortably-longer-than-32-bytes',
    clock: { now: () => Date.now() },
  });
  return (await auth.login('admin', password)) !== null;
}

describe('hash-password', () => {
  it('prints one scrypt line with the documented parameters that the local auth accepts', async () => {
    const { code, stdout, stderr } = await hashPasswordCli('correct horse battery staple\n');
    expect(code).toBe(0);
    expect(stdout).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*\n$/);
    const parsed = parsePasswordHash(stdout.trim());
    expect(parsed).toMatchObject({ N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p });
    expect(parsed?.salt).toHaveLength(16);
    expect(parsed?.hash).toHaveLength(32);
    expect(stderr).toBe('');

    expect(await loginWith(stdout.trim(), 'correct horse battery staple')).toBe(true);
    expect(await loginWith(stdout.trim(), 'correct horse battery stapl')).toBe(false);
  });

  it('strips exactly one trailing newline (LF or CRLF) and keeps everything else', async () => {
    const lf = await hashPasswordCli('  spaced password  \n');
    expect(await loginWith(lf.stdout.trim(), '  spaced password  ')).toBe(true);
    const crlf = await hashPasswordCli('windows password!\r\n');
    expect(await loginWith(crlf.stdout.trim(), 'windows password!')).toBe(true);
    const none = await hashPasswordCli('no newline at the end');
    expect(await loginWith(none.stdout.trim(), 'no newline at the end')).toBe(true);
    const two = await hashPasswordCli('ends with a newline\n\n');
    expect(await loginWith(two.stdout.trim(), 'ends with a newline\n')).toBe(true);
  });

  it('hashes non-ASCII passwords', async () => {
    const { stdout } = await hashPasswordCli('pässwörd-日本語-🔑\n');
    expect(await loginWith(stdout.trim(), 'pässwörd-日本語-🔑')).toBe(true);
  });

  it('uses a fresh salt every time', async () => {
    const a = await hashPasswordCli('same password, twice\n');
    const b = await hashPasswordCli('same password, twice\n');
    expect(a.stdout).not.toBe(b.stdout);
  });

  it('fails on an empty password and prints nothing on stdout', async () => {
    for (const input of ['', '\n', '\r\n']) {
      const { code, stdout, stderr } = await hashPasswordCli(input);
      expect(code).toBe(1);
      expect(stdout).toBe('');
      expect(stderr).toMatch(/password is empty/);
    }
  });

  it('warns about a short password on stderr but still prints the hash', async () => {
    const { code, stdout, stderr } = await hashPasswordCli('short\n');
    expect(code).toBe(0);
    expect(stdout).toMatch(/^scrypt\$/);
    expect(stderr).toMatch(/warning/);
  });
});
