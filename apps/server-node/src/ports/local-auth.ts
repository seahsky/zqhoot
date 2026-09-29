import { createHash, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { Clock, HostAuth, HostIdentity, LocalLogin } from '@zqhoot/service';
import { verifyPassword } from '../password-hash.ts';
import type { PasswordHash } from '../password-hash.ts';

export const JWT_ISSUER = 'zqhoot';
export const JWT_LIFETIME_SECONDS = 12 * 3600;

export interface LocalAuthOptions {
  user: string;
  password: PasswordHash;
  /** `ZQ_JWT_SECRET`: the UTF-8 bytes are the HMAC key. */
  secret: string;
  clock: Clock;
}

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/**
 * The VM's single admin account (ADR-0009): scrypt-checked login that mints an HS256 JWT, and the
 * verification of that JWT for HTTP routes and `host.hello`.
 */
export class LocalAuth implements HostAuth, LocalLogin {
  readonly #user: string;
  /** `local:{user}`, the owner id of everything the admin creates. */
  readonly hostId: string;
  readonly #password: PasswordHash;
  readonly #key: Uint8Array;
  readonly #clock: Clock;

  constructor(opts: LocalAuthOptions) {
    this.#user = opts.user;
    this.hostId = `local:${opts.user}`;
    this.#password = opts.password;
    this.#key = new TextEncoder().encode(opts.secret);
    this.#clock = opts.clock;
  }

  async login(
    username: string,
    password: string,
  ): Promise<{ token: string; expiresAt: number } | null> {
    // Both checks always run, so timing does not reveal whether the user name was right.
    const userOk = timingSafeEqual(digest(username), digest(this.#user));
    const passwordOk = await verifyPassword(password, this.#password);
    if (!userOk || !passwordOk) return null;

    const issuedAt = Math.floor(this.#clock.now() / 1000);
    const expiresAt = issuedAt + JWT_LIFETIME_SECONDS;
    const token = await new SignJWT()
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(this.hostId)
      .setIssuer(JWT_ISSUER)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .sign(this.#key);
    return { token, expiresAt: expiresAt * 1000 };
  }

  async verify(token: string): Promise<HostIdentity | null> {
    try {
      const { payload } = await jwtVerify(token, this.#key, {
        issuer: JWT_ISSUER,
        algorithms: ['HS256'],
        requiredClaims: ['sub', 'exp'],
        currentDate: new Date(this.#clock.now()),
      });
      // A token minted for another admin name (ZQ_ADMIN_USER changed) stops working with the rename.
      if (payload.sub !== this.hostId) return null;
      return { hostId: this.hostId, displayName: this.#user };
    } catch {
      return null;
    }
  }
}
