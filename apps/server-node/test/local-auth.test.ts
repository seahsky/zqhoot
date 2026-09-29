import { describe, expect, it } from 'vitest';
import { SignJWT, decodeJwt, decodeProtectedHeader } from 'jose';
import { LocalAuth, JWT_LIFETIME_SECONDS } from '../src/ports/local-auth.ts';
import {
  SCRYPT_PARAMS,
  hashPassword,
  parsePasswordHash,
  verifyPassword,
} from '../src/password-hash.ts';
import type { PasswordHash } from '../src/password-hash.ts';

const SECRET = 'a-secret-that-is-comfortably-longer-than-32-bytes';
const FAST = { N: 1024, r: 8, p: 1 };
const T0 = 1_800_000_000_000;

async function makeAuth(opts: { user?: string; secret?: string; now?: () => number } = {}) {
  const password = parsePasswordHash(await hashPassword('hunter2-hunter2', FAST)) as PasswordHash;
  const clock = { now: opts.now ?? (() => T0) };
  return new LocalAuth({
    user: opts.user ?? 'admin',
    password,
    secret: opts.secret ?? SECRET,
    clock,
  });
}

describe('password hashes', () => {
  it('uses the documented format and parameters', async () => {
    const hash = await hashPassword('secret');
    const parts = hash.split('$');
    expect(parts).toHaveLength(6);
    expect(parts.slice(0, 4)).toEqual(['scrypt', '32768', '8', '1']);
    expect(Buffer.from(parts[4] ?? '', 'base64')).toHaveLength(16);
    expect(Buffer.from(parts[5] ?? '', 'base64')).toHaveLength(32);
    expect(SCRYPT_PARAMS).toMatchObject({ N: 2 ** 15, r: 8, p: 1, saltBytes: 16, keyBytes: 32 });
  });

  it('verifies the right password and only that', async () => {
    const stored = parsePasswordHash(await hashPassword('correct', FAST)) as PasswordHash;
    expect(await verifyPassword('correct', stored)).toBe(true);
    expect(await verifyPassword('correct ', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
    expect(await verifyPassword('Correct', stored)).toBe(false);
  });

  it('salts every hash differently', async () => {
    expect(await hashPassword('same', FAST)).not.toBe(await hashPassword('same', FAST));
  });

  it('handles non-ASCII passwords by their UTF-8 bytes', async () => {
    const stored = parsePasswordHash(await hashPassword('pässwörd-日本語', FAST)) as PasswordHash;
    expect(await verifyPassword('pässwörd-日本語', stored)).toBe(true);
    expect(await verifyPassword('passwörd-日本語', stored)).toBe(false);
  });

  it.each([
    '',
    'plain',
    'scrypt$1024$8$1$c2FsdHNhbHQ=',
    'bcrypt$1024$8$1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2g=',
    'scrypt$1000$8$1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2g=',
    'scrypt$1024$8$1$c2FsdA==$aGFzaGhhc2hoYXNoaGFzaGhhc2g=',
    'scrypt$1024$8$1$c2FsdHNhbHRzYWx0$aGFzaA==',
    'scrypt$1024$8$0$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2g=',
    'scrypt$1024$1000$1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2g=',
    'scrypt$4294967296$8$1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2g=',
    'scrypt$1024$8$1$not base64!$aGFzaGhhc2hoYXNoaGFzaGhhc2g=',
  ])('rejects the malformed or out-of-bounds hash %j', (value) => {
    expect(parsePasswordHash(value)).toBeNull();
  });
});

describe('LocalAuth', () => {
  it('issues an HS256 JWT with sub local:{user}, issuer zqhoot and a 12 h lifetime', async () => {
    const auth = await makeAuth();
    const session = await auth.login('admin', 'hunter2-hunter2');
    expect(session).not.toBeNull();
    const token = session?.token ?? '';
    expect(decodeProtectedHeader(token)).toEqual({ alg: 'HS256' });
    const claims = decodeJwt(token);
    expect(claims.sub).toBe('local:admin');
    expect(claims.iss).toBe('zqhoot');
    expect(claims.iat).toBe(T0 / 1000);
    expect(claims.exp).toBe(T0 / 1000 + 12 * 3600);
    expect(JWT_LIFETIME_SECONDS).toBe(12 * 3600);
    expect(session?.expiresAt).toBe(T0 + 12 * 3600 * 1000);
    expect(await auth.verify(token)).toEqual({ hostId: 'local:admin', displayName: 'admin' });
  });

  it('refuses a wrong password and a wrong user', async () => {
    const auth = await makeAuth();
    expect(await auth.login('admin', 'nope')).toBeNull();
    expect(await auth.login('root', 'hunter2-hunter2')).toBeNull();
    expect(await auth.login('', '')).toBeNull();
  });

  it('expires the token after 12 hours', async () => {
    let now = T0;
    const auth = await makeAuth({ now: () => now });
    const token = (await auth.login('admin', 'hunter2-hunter2'))?.token ?? '';
    now = T0 + 12 * 3600_000 - 1000;
    expect(await auth.verify(token)).not.toBeNull();
    now = T0 + 12 * 3600_000 + 1000;
    expect(await auth.verify(token)).toBeNull();
  });

  it('refuses a token signed with another secret (a rotated ZQ_JWT_SECRET logs the admin out)', async () => {
    const before = await makeAuth();
    const token = (await before.login('admin', 'hunter2-hunter2'))?.token ?? '';
    const rotated = await makeAuth({ secret: `${SECRET}-rotated` });
    expect(await rotated.verify(token)).toBeNull();
  });

  it('refuses a token for another admin name', async () => {
    const token = (await (await makeAuth()).login('admin', 'hunter2-hunter2'))?.token ?? '';
    expect(await (await makeAuth({ user: 'renamed' })).verify(token)).toBeNull();
  });

  it('refuses garbage, tampered and foreign tokens', async () => {
    const auth = await makeAuth();
    const token = (await auth.login('admin', 'hunter2-hunter2'))?.token ?? '';
    const key = new TextEncoder().encode(SECRET);
    const claims = (build: SignJWT) =>
      build.setIssuedAt(T0 / 1000).setExpirationTime(T0 / 1000 + 60);

    const [header, payload, signature] = token.split('.') as [string, string, string];
    const forgedPayload = Buffer.from(
      JSON.stringify({ ...decodeJwt(token), sub: 'local:root' }),
    ).toString('base64url');
    const cases = [
      '',
      'garbage',
      'a.b.c',
      `${header}.${payload}.`,
      `${header}.${forgedPayload}.${signature}`,
      // alg none
      `${Buffer.from('{"alg":"none"}').toString('base64url')}.${payload}.`,
      // right key, wrong algorithm
      await claims(
        new SignJWT()
          .setProtectedHeader({ alg: 'HS512' })
          .setSubject('local:admin')
          .setIssuer('zqhoot'),
      ).sign(key),
      // right key, wrong issuer
      await claims(
        new SignJWT()
          .setProtectedHeader({ alg: 'HS256' })
          .setSubject('local:admin')
          .setIssuer('someone'),
      ).sign(key),
      // right key, no expiry
      await new SignJWT()
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('local:admin')
        .setIssuer('zqhoot')
        .sign(key),
      // right key, no subject
      await claims(new SignJWT().setProtectedHeader({ alg: 'HS256' }).setIssuer('zqhoot')).sign(
        key,
      ),
    ];
    for (const bad of cases) expect(await auth.verify(bad), bad.slice(0, 30)).toBeNull();
  });
});
