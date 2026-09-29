import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { FetchError, JwtBaseError } from 'aws-jwt-verify/error';
import { noopLogger } from '@zqhoot/service';
import type { HostAuth, HostIdentity, Logger } from '@zqhoot/service';

/** What is read from a verified ID token. */
export interface IdTokenVerifier {
  verify(token: string): Promise<{ sub: string; email?: unknown }>;
}

export interface CognitoConfig {
  userPoolId: string;
  clientId: string;
}

/** Created once per container: the verifier keeps the pool's JWKS between invocations. */
export function createCognitoVerifier(cfg: CognitoConfig) {
  return CognitoJwtVerifier.create({
    userPoolId: cfg.userPoolId,
    tokenUse: 'id',
    clientId: cfg.clientId,
  });
}

/** ADR-0009: ID tokens carry `email`, which is what the host screen shows. */
export class CognitoHostAuth implements HostAuth {
  readonly #verifier: IdTokenVerifier;
  readonly #log: Logger;

  constructor(verifier: IdTokenVerifier, logger: Logger = noopLogger) {
    this.#verifier = verifier;
    this.#log = logger;
  }

  async verify(token: string): Promise<HostIdentity | null> {
    try {
      const payload = await this.#verifier.verify(token);
      const email =
        typeof payload.email === 'string' && payload.email !== '' ? payload.email : null;
      return { hostId: payload.sub, displayName: email ?? payload.sub };
    } catch (error) {
      // Expired and forged tokens are routine. A failed JWKS download is not: every host would
      // be locked out, and the token itself says nothing about it.
      const routine = error instanceof JwtBaseError && !(error instanceof FetchError);
      const record = { err: error instanceof Error ? error.message : String(error) };
      if (routine) this.#log.debug(record, 'host token rejected');
      else this.#log.warn(record, 'host token verification failed');
      return null;
    }
  }
}
