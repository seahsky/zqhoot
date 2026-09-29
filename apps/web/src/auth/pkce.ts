/**
 * Authorization code + PKCE helpers for the Cognito managed login (ADR-0009). Nothing
 * here stores anything: the caller keeps the verifier and state (sessionStorage) between
 * the redirect out and the callback back.
 */

export function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken(byteLength: number, getRandomValues: Crypto['getRandomValues']): string {
  return base64Url(getRandomValues(new Uint8Array(byteLength)));
}

/** 32 random bytes give a 43-character verifier, the RFC 7636 minimum length. */
export function createVerifier(
  getRandomValues: Crypto['getRandomValues'] = (a) => crypto.getRandomValues(a),
): string {
  return randomToken(32, getRandomValues);
}

/** Opaque value that ties the callback to the request that started it (CSRF defence). */
export function createState(
  getRandomValues: Crypto['getRandomValues'] = (a) => crypto.getRandomValues(a),
): string {
  return randomToken(16, getRandomValues);
}

/** `BASE64URL(SHA256(ASCII(verifier)))`, method `S256`. */
export async function challengeS256(
  verifier: string,
  subtle: Pick<SubtleCrypto, 'digest'> = crypto.subtle,
): Promise<string> {
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export interface AuthorizeParams {
  /** Managed login origin from `auth.domain` in the runtime config, without a trailing path. */
  domain: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  scope?: string;
}

const trimSlash = (s: string) => s.replace(/\/+$/, '');

export function buildAuthorizeUrl(p: AuthorizeParams): string {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    scope: p.scope ?? 'openid email profile',
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
    state: p.state,
  });
  return `${trimSlash(p.domain)}/oauth2/authorize?${query.toString()}`;
}

export type CallbackResult =
  | { kind: 'code'; code: string }
  | { kind: 'error'; error: string; description: string | null }
  /** Not a callback at all (no `code` or `error` parameter). */
  | { kind: 'none' };

/** Reads `?code=&state=` (or `?error=`) from the redirect, rejecting a state mismatch. */
export function parseCallback(search: string, expectedState: string | null): CallbackResult {
  const params = new URLSearchParams(search);
  const error = params.get('error');
  if (error) return { kind: 'error', error, description: params.get('error_description') };
  const code = params.get('code');
  if (!code) return { kind: 'none' };
  const state = params.get('state');
  if (!expectedState || state !== expectedState) {
    return { kind: 'error', error: 'state_mismatch', description: null };
  }
  return { kind: 'code', code };
}

export interface TokenRequest {
  url: string;
  body: URLSearchParams;
}

/** The `application/x-www-form-urlencoded` POST that trades the code for tokens. */
export function buildTokenRequest(p: {
  domain: string;
  clientId: string;
  redirectUri: string;
  code: string;
  verifier: string;
}): TokenRequest {
  return {
    url: `${trimSlash(p.domain)}/oauth2/token`,
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: p.clientId,
      code: p.code,
      redirect_uri: p.redirectUri,
      code_verifier: p.verifier,
    }),
  };
}

export function buildRefreshRequest(p: {
  domain: string;
  clientId: string;
  refreshToken: string;
}): TokenRequest {
  return {
    url: `${trimSlash(p.domain)}/oauth2/token`,
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: p.clientId,
      refresh_token: p.refreshToken,
    }),
  };
}
