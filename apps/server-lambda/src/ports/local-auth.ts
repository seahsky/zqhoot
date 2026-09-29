import { createHash, createHmac, scrypt, timingSafeEqual } from 'node:crypto';
import type { HostAuth, HostIdentity, LocalLogin } from '@zqhoot/service';

/** Same claims as the VM's login (ADR-0009), so a token from one verifies on the other. */
const ISSUER = 'zqhoot';
const TOKEN_LIFETIME_SECONDS = 12 * 3600;
const HOST_PREFIX = 'local:';

export interface LocalAuthOptions {
  adminUser: string;
  /** `scrypt$N$r$p$saltB64$hashB64` (ADR-0009). */
  adminPasswordHash?: string | undefined;
  /** Development only. Ignored when a hash is given. */
  adminPassword?: string | undefined;
  jwtSecret: string;
  now?: () => number;
}

const b64url = (value: string | Buffer): string => Buffer.from(value).toString('base64url');
const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
const constantTimeEqual = (a: string, b: string): boolean => timingSafeEqual(digest(a), digest(b));

const HEADER = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

interface ScryptHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

export function parseScryptHash(encoded: string): ScryptHash | null {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [N, r, p] = [parts[1], parts[2], parts[3]].map(Number);
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const key = Buffer.from(parts[5] ?? '', 'base64');
  if (![N, r, p].every((n) => Number.isInteger(n) && (n as number) > 0)) return null;
  if (salt.length === 0 || key.length === 0) return null;
  return { N: N as number, r: r as number, p: p as number, salt, key };
}

function deriveKey(password: string, hash: ScryptHash): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      hash.salt,
      hash.key.length,
      // Node's default limit is 32 MiB, which N=2^15, r=8 already reaches.
      { N: hash.N, r: hash.r, p: hash.p, maxmem: 256 * hash.N * hash.r },
      (error, derived) => (error === null ? resolve(derived) : reject(error)),
    );
  });
}

/**
 * The emulator's stand-in for Cognito: a single admin with an scrypt (or, for development, plain)
 * password and an HS256 token. Only built when `localAuthAllowed` says so.
 */
export class LocalAuth implements HostAuth, LocalLogin {
  readonly #user: string;
  readonly #hash: ScryptHash | null;
  readonly #password: string | undefined;
  readonly #secret: string;
  readonly #now: () => number;

  constructor(opts: LocalAuthOptions) {
    this.#user = opts.adminUser;
    this.#hash =
      opts.adminPasswordHash === undefined ? null : parseScryptHash(opts.adminPasswordHash);
    if (opts.adminPasswordHash !== undefined && this.#hash === null) {
      throw new Error('ZQ_ADMIN_PASSWORD_HASH is not in the form scrypt$N$r$p$salt$hash');
    }
    this.#password = opts.adminPassword;
    this.#secret = opts.jwtSecret;
    this.#now = opts.now ?? Date.now;
  }

  async login(
    username: string,
    password: string,
  ): Promise<{ token: string; expiresAt: number } | null> {
    // Both checks always run, so the response time does not say which one failed.
    const userOk = constantTimeEqual(username, this.#user);
    const passwordOk = await this.#checkPassword(password);
    if (!userOk || !passwordOk) return null;
    const issuedAt = Math.floor(this.#now() / 1000);
    const expiresAt = issuedAt + TOKEN_LIFETIME_SECONDS;
    const payload = b64url(
      JSON.stringify({
        iss: ISSUER,
        sub: `${HOST_PREFIX}${this.#user}`,
        iat: issuedAt,
        exp: expiresAt,
      }),
    );
    return {
      token: `${HEADER}.${payload}.${this.#sign(`${HEADER}.${payload}`)}`,
      expiresAt: expiresAt * 1000,
    };
  }

  async verify(token: string): Promise<HostIdentity | null> {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, payload, signature] = parts as [string, string, string];
    if (header !== HEADER) return null;
    const expected = Buffer.from(this.#sign(`${header}.${payload}`));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    let claims: { iss?: unknown; sub?: unknown; exp?: unknown };
    try {
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as typeof claims;
    } catch {
      return null;
    }
    if (claims.iss !== ISSUER || typeof claims.sub !== 'string') return null;
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= this.#now()) return null;
    if (!claims.sub.startsWith(HOST_PREFIX)) return null;
    return { hostId: claims.sub, displayName: claims.sub.slice(HOST_PREFIX.length) };
  }

  async #checkPassword(password: string): Promise<boolean> {
    if (this.#hash !== null) {
      const derived = await deriveKey(password, this.#hash);
      return timingSafeEqual(derived, this.#hash.key);
    }
    return this.#password !== undefined && constantTimeEqual(password, this.#password);
  }

  #sign(input: string): string {
    return createHmac('sha256', this.#secret).update(input).digest('base64url');
  }
}
