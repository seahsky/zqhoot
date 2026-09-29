import { createHash, createHmac, createSign, generateKeyPairSync, scryptSync } from 'node:crypto';
import { InvokeCommand } from '@aws-sdk/client-lambda';
import { S3Client } from '@aws-sdk/client-s3';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { FetchError, JwtExpiredError } from 'aws-jwt-verify/error';
import { describe, expect, it } from 'vitest';
import { LIMITS, MediaKey, UploadGrant } from '@zqhoot/protocol';
import { CognitoHostAuth } from '../src/ports/cognito-host-auth.ts';
import type { IdTokenVerifier } from '../src/ports/cognito-host-auth.ts';
import { createIds } from '../src/ports/ids.ts';
import { LambdaWarmer } from '../src/ports/lambda-warmer.ts';
import { LocalAuth } from '../src/ports/local-auth.ts';
import { S3Media, hostSlug } from '../src/ports/s3-media.ts';

const b64url = (value: string | Buffer): string => Buffer.from(value).toString('base64url');

describe('CognitoHostAuth', () => {
  const region = 'us-east-1';
  const userPoolId = 'us-east-1_TestPool1';
  const clientId = 'client-abc';
  const issuer = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;

  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const otherKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = {
    ...keys.publicKey.export({ format: 'jwk' }),
    kid: 'key-1',
    alg: 'RS256',
    use: 'sig',
  };

  function sign(claims: Record<string, unknown>, privateKey = keys.privateKey): string {
    const header = b64url(JSON.stringify({ alg: 'RS256', kid: 'key-1', typ: 'JWT' }));
    const now = Math.floor(Date.now() / 1000);
    const payload = b64url(
      JSON.stringify({
        sub: 'sub-1234',
        iss: issuer,
        aud: clientId,
        token_use: 'id',
        iat: now,
        exp: now + 600,
        ...claims,
      }),
    );
    const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKey);
    return `${header}.${payload}.${b64url(signature)}`;
  }

  // The same call the Lambda makes, with the pool's JWKS put in the cache so no network is used.
  const verifier = CognitoJwtVerifier.create({ userPoolId, tokenUse: 'id', clientId });
  verifier.cacheJwks({ keys: [jwk as never] });
  const auth = new CognitoHostAuth(verifier);

  it('maps sub to hostId and email to displayName', async () => {
    const identity = await auth.verify(sign({ email: 'host@example.com' }));
    expect(identity).toEqual({ hostId: 'sub-1234', displayName: 'host@example.com' });
  });

  it('falls back to sub when the token has no email', async () => {
    expect(await auth.verify(sign({}))).toEqual({ hostId: 'sub-1234', displayName: 'sub-1234' });
    expect(await auth.verify(sign({ email: '' }))).toEqual({
      hostId: 'sub-1234',
      displayName: 'sub-1234',
    });
  });

  it('rejects a token for another client', async () => {
    expect(await auth.verify(sign({ aud: 'someone-else' }))).toBeNull();
  });

  it('rejects an access token: the ID token is the bearer (ADR-0009)', async () => {
    expect(await auth.verify(sign({ token_use: 'access' }))).toBeNull();
  });

  it('rejects an expired token', async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    expect(await auth.verify(sign({ iat: past - 600, exp: past }))).toBeNull();
  });

  it('rejects a token from another issuer', async () => {
    expect(await auth.verify(sign({ iss: `${issuer}X` }))).toBeNull();
  });

  it('rejects a token signed with another key', async () => {
    expect(await auth.verify(sign({}, otherKeys.privateKey))).toBeNull();
  });

  it('rejects garbage', async () => {
    expect(await auth.verify('not a token')).toBeNull();
    expect(await auth.verify('a.b.c')).toBeNull();
    expect(await auth.verify('')).toBeNull();
  });

  it('logs a failed JWKS download as a warning and an expired token only as debug', async () => {
    const levels: string[] = [];
    const logger = {
      debug: () => levels.push('debug'),
      info: () => levels.push('info'),
      warn: () => levels.push('warn'),
      error: () => levels.push('error'),
    };
    const failing = (error: Error): IdTokenVerifier => ({
      verify: async () => {
        throw error;
      },
    });
    await new CognitoHostAuth(failing(new JwtExpiredError('expired', 1)), logger).verify('t');
    await new CognitoHostAuth(failing(new FetchError('https://jwks', 'ECONNRESET')), logger).verify(
      't',
    );
    await new CognitoHostAuth(failing(new Error('surprise')), logger).verify('t');
    expect(levels).toEqual(['debug', 'warn', 'warn']);
  });
});

describe('S3Media', () => {
  const client = new S3Client({
    region: 'us-east-1',
    credentials: { accessKeyId: 'AKIATESTKEY', secretAccessKey: 'secret' },
  });
  const media = new S3Media({
    client,
    bucket: 'zqhoot-media-bucket',
    ids: { ...createIds(), mediaId: () => 'media_abc-123' },
  });
  const host = { hostId: 'us-east-1:aaaa-bbbb', displayName: 'Host' };
  const now = 1_800_000_000_000;

  const policyOf = (fields: Record<string, string>) =>
    JSON.parse(Buffer.from(fields.Policy as string, 'base64').toString('utf8')) as {
      expiration: string;
      conditions: unknown[];
    };

  it('grants a presigned POST under media/{hostSlug}/ with S3-enforced conditions', async () => {
    const grant = await media.createUpload(host, { contentType: 'image/png', size: 1000 }, now);

    const slug = createHash('sha256').update(host.hostId).digest('base64url').slice(0, 16);
    expect(hostSlug(host.hostId)).toBe(slug);
    expect(slug).toHaveLength(16);
    expect(grant.key).toBe(`media/${slug}/media_abc-123.png`);
    expect(grant.key).not.toContain(host.hostId);
    expect(MediaKey.safeParse(grant.key).success).toBe(true);
    expect(UploadGrant.safeParse(grant).success).toBe(true);
    expect(grant.expiresAt).toBe(now + 300_000);

    expect(grant.upload.method).toBe('POST');
    if (grant.upload.method !== 'POST') return;
    expect(grant.upload.url).toContain('zqhoot-media-bucket');
    expect(grant.upload.fields.key).toBe(grant.key);
    expect(grant.upload.fields['Content-Type']).toBe('image/png');

    const policy = policyOf(grant.upload.fields);
    expect(policy.conditions).toContainEqual(['content-length-range', 1, 5_242_880]);
    expect(policy.conditions).toContainEqual({ 'Content-Type': 'image/png' });
    expect(policy.conditions).toContainEqual({ key: grant.key });
    expect(policy.conditions).toContainEqual({ bucket: 'zqhoot-media-bucket' });
    expect(LIMITS.imageMaxBytes).toBe(5_242_880);

    // The policy expires in 300 s of real time, however the caller's clock reads.
    const seconds = (Date.parse(policy.expiration) - Date.now()) / 1000;
    expect(seconds).toBeGreaterThan(290);
    expect(seconds).toBeLessThanOrEqual(300);
  });

  it.each([
    ['image/jpeg', 'jpg'],
    ['image/webp', 'webp'],
    ['image/gif', 'gif'],
  ] as const)('derives the extension for %s from the declared type', async (contentType, ext) => {
    const grant = await media.createUpload(host, { contentType, size: 10 }, now);
    expect(grant.key.endsWith(`.${ext}`)).toBe(true);
    expect(MediaKey.safeParse(grant.key).success).toBe(true);
    if (grant.upload.method === 'POST') {
      expect(policyOf(grant.upload.fields).conditions).toContainEqual({
        'Content-Type': contentType,
      });
    }
  });

  it('has no put: bytes never pass through Lambda', () => {
    expect((media as { put?: unknown }).put).toBeUndefined();
  });

  it('gives two hosts different key prefixes', () => {
    expect(hostSlug('a')).not.toBe(hostSlug('b'));
  });
});

describe('LambdaWarmer', () => {
  const inputs = (calls: InvokeCommand[]) => calls.map((c) => c.input);

  it('issues every invocation at once, as async Event calls with the warm-up payload', async () => {
    const calls: InvokeCommand[] = [];
    const release: Array<() => void> = [];
    const warmer = new LambdaWarmer(
      {
        send: (command) => {
          calls.push(command);
          return new Promise((resolve) => release.push(() => resolve({})));
        },
      },
      'zqhoot-ws',
      4,
    );

    const done = warmer.warm();
    // All four are out before any of them has answered.
    expect(calls).toHaveLength(4);
    for (const input of inputs(calls)) {
      expect(input.FunctionName).toBe('zqhoot-ws');
      expect(input.InvocationType).toBe('Event');
      expect(JSON.parse(new TextDecoder().decode(input.Payload as Uint8Array))).toEqual({
        warmup: true,
      });
    }
    release.forEach((r) => r());
    await done;
  });

  it('waits for every call and then reports the failures', async () => {
    let finished = 0;
    let n = 0;
    const warmer = new LambdaWarmer(
      {
        send: async () => {
          const mine = n++;
          await new Promise((resolve) => setTimeout(resolve, 5 * (mine + 1)));
          finished++;
          if (mine === 0) throw new Error('throttled');
          return {};
        },
      },
      'zqhoot-ws',
      3,
    );
    await expect(warmer.warm()).rejects.toThrow(/1 of 3 warm-up invocations failed: throttled/);
    // The failure came first, yet the slower calls were not abandoned.
    expect(finished).toBe(3);
  });

  it('does nothing for a concurrency of 0', async () => {
    const warmer = new LambdaWarmer(
      {
        send: async () => {
          throw new Error('must not be called');
        },
      },
      'zqhoot-ws',
      0,
    );
    await expect(warmer.warm()).resolves.toBeUndefined();
  });
});

describe('createIds', () => {
  const ids = createIds();

  it('mints ids that satisfy the protocol Id pattern', () => {
    for (const make of [ids.sessionId, ids.playerId, ids.quizId, ids.mediaId]) {
      for (let i = 0; i < 200; i++) expect(make()).toMatch(/^[A-Za-z0-9_-]{6,32}$/);
    }
  });

  it('mints 256-bit base64url tokens that never repeat', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => ids.token()));
    expect(tokens.size).toBe(500);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    }
  });

  it('mints six-digit PINs that do not start with 0', () => {
    for (let i = 0; i < 2000; i++) expect(ids.pin()).toMatch(/^[1-9][0-9]{5}$/);
  });
});

describe('LocalAuth', () => {
  const secret = 'x'.repeat(40);
  const t0 = 1_800_000_000_000;

  it('logs in with a plain password (development) and verifies the token it issued', async () => {
    const auth = new LocalAuth({
      adminUser: 'admin',
      adminPassword: 'pw',
      jwtSecret: secret,
      now: () => t0,
    });
    expect(await auth.login('admin', 'nope')).toBeNull();
    expect(await auth.login('root', 'pw')).toBeNull();
    const session = await auth.login('admin', 'pw');
    expect(session).not.toBeNull();
    expect(session?.expiresAt).toBe(t0 + 12 * 3600 * 1000);
    expect(await auth.verify(session?.token as string)).toEqual({
      hostId: 'local:admin',
      displayName: 'admin',
    });
  });

  it('issues a standard HS256 JWT with the VM login claims', async () => {
    const auth = new LocalAuth({
      adminUser: 'admin',
      adminPassword: 'pw',
      jwtSecret: secret,
      now: () => t0,
    });
    const token = (await auth.login('admin', 'pw'))?.token as string;
    const [header, payload, signature] = token.split('.') as [string, string, string];
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'HS256',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toEqual({
      iss: 'zqhoot',
      sub: 'local:admin',
      iat: t0 / 1000,
      exp: t0 / 1000 + 12 * 3600,
    });
    expect(signature).toBe(
      createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url'),
    );
  });

  it('checks an scrypt hash in the ADR-0009 format', async () => {
    const salt = Buffer.from('0123456789abcdef');
    const key = scryptSync('correct horse', salt, 32, { N: 1024, r: 8, p: 1 });
    const hash = `scrypt$1024$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
    const auth = new LocalAuth({ adminUser: 'admin', adminPasswordHash: hash, jwtSecret: secret });
    expect(await auth.login('admin', 'correct horse')).not.toBeNull();
    expect(await auth.login('admin', 'wrong horse')).toBeNull();
  });

  it('refuses a malformed hash at construction', () => {
    expect(
      () => new LocalAuth({ adminUser: 'a', adminPasswordHash: 'md5$abc', jwtSecret: secret }),
    ).toThrow(/scrypt/);
  });

  it('rejects expired, tampered and foreign tokens', async () => {
    let now = t0;
    const auth = new LocalAuth({
      adminUser: 'admin',
      adminPassword: 'pw',
      jwtSecret: secret,
      now: () => now,
    });
    const token = (await auth.login('admin', 'pw'))?.token as string;
    expect(await auth.verify(token)).not.toBeNull();

    now = t0 + 12 * 3600 * 1000;
    expect(await auth.verify(token)).toBeNull();
    now = t0;

    const [header, payload, signature] = token.split('.') as [string, string, string];
    const forged = b64url(
      JSON.stringify({ iss: 'zqhoot', sub: 'local:root', exp: t0 / 1000 + 999 }),
    );
    expect(await auth.verify(`${header}.${forged}.${signature}`)).toBeNull();
    expect(await auth.verify(`${header}.${payload}.`)).toBeNull();
    expect(await auth.verify('x.y')).toBeNull();

    const other = new LocalAuth({
      adminUser: 'admin',
      adminPassword: 'pw',
      jwtSecret: 'y'.repeat(40),
      now: () => t0,
    });
    expect(await other.verify(token)).toBeNull();

    // A validly signed token that is not one of ours.
    const alien = `${header}.${b64url(JSON.stringify({ iss: 'other', sub: 'local:admin', exp: t0 / 1000 + 60 }))}`;
    const alienToken = `${alien}.${createHmac('sha256', secret).update(alien).digest('base64url')}`;
    expect(await auth.verify(alienToken)).toBeNull();
  });
});
