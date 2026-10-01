import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/** Parameters `hash-password` writes (ADR-0009): N = 2^15, r = 8, p = 1, 16-byte salt, 32-byte key. */
export const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1, saltBytes: 16, keyBytes: 32 } as const;

/** A stored `scrypt$N$r$p$saltB64$hashB64` value, decoded. */
export interface PasswordHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

// Bounds on what a configured hash may ask of the server: a typo in `N` must not make every login
// allocate gigabytes.
const MAX_N = 2 ** 20;
const MAX_R = 32;
const MAX_P = 16;
const MAX_MEMORY_BYTES = 512 * 1024 * 1024;
const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

/** Null when `value` is not a well-formed, in-bounds scrypt hash. */
export function parsePasswordHash(value: string): PasswordHash | null {
  const parts = value.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [, n, r, p, salt, hash] = parts as [string, string, string, string, string, string];
  if (![n, r, p].every((v) => /^[1-9]\d{0,9}$/.test(v))) return null;
  if (!BASE64.test(salt) || !BASE64.test(hash)) return null;
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  if (params.N < 2 || (params.N & (params.N - 1)) !== 0 || params.N > MAX_N) return null;
  if (params.r > MAX_R || params.p > MAX_P) return null;
  if (128 * params.N * params.r > MAX_MEMORY_BYTES) return null;
  const saltBytes = Buffer.from(salt, 'base64');
  const hashBytes = Buffer.from(hash, 'base64');
  if (saltBytes.length < 8 || hashBytes.length < 16 || hashBytes.length > 128) return null;
  return { ...params, salt: saltBytes, hash: hashBytes };
}

function deriveKey(
  password: string,
  salt: Buffer,
  keyLength: number,
  params: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Node's default `maxmem` (32 MiB) is exactly what N = 2^15, r = 8 needs, and it rejects at the limit.
    const maxmem = 256 * params.N * params.r;
    scrypt(password, salt, keyLength, { ...params, maxmem }, (err, key) =>
      err === null ? resolve(key) : reject(err),
    );
  });
}

/** Hashes the UTF-8 bytes of `password` with a fresh salt. */
export async function hashPassword(
  password: string,
  params: { N: number; r: number; p: number } = SCRYPT_PARAMS,
): Promise<string> {
  const salt = randomBytes(SCRYPT_PARAMS.saltBytes);
  const key = await deriveKey(password, salt, SCRYPT_PARAMS.keyBytes, params);
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
  const key = await deriveKey(password, stored.salt, stored.hash.length, stored);
  return timingSafeEqual(key, stored.hash);
}
