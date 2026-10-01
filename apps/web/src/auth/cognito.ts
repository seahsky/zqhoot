import type { RuntimeConfig } from '@zqhoot/protocol';
import { buildAuthorizeUrl, buildRefreshRequest, buildTokenRequest } from './pkce.ts';
import type { TokenRequest } from './pkce.ts';

/**
 * The Cognito managed-login pieces of ADR-0009 that need no browser: URLs, request bodies and
 * the token response. `pkce.ts` holds the RFC 7636 primitives; this file fixes the redirect
 * URI and the logout URL, which both point back at `{origin}/host`.
 */

export type CognitoAuth = Extract<RuntimeConfig['auth'], { mode: 'cognito' }>;

/** Where Cognito sends the browser back to, for sign-in and after sign-out. */
export const redirectUriFor = (origin: string): string => `${origin.replace(/\/+$/, '')}/host`;

export function authorizeUrl(
  cfg: CognitoAuth,
  origin: string,
  challenge: string,
  state: string,
): string {
  return buildAuthorizeUrl({
    domain: cfg.domain,
    clientId: cfg.clientId,
    redirectUri: redirectUriFor(origin),
    challenge,
    state,
    scope: 'openid email profile',
  });
}

export function tokenRequest(
  cfg: CognitoAuth,
  origin: string,
  code: string,
  verifier: string,
): TokenRequest {
  return buildTokenRequest({
    domain: cfg.domain,
    clientId: cfg.clientId,
    redirectUri: redirectUriFor(origin),
    code,
    verifier,
  });
}

export function refreshRequest(cfg: CognitoAuth, refreshToken: string): TokenRequest {
  return buildRefreshRequest({ domain: cfg.domain, clientId: cfg.clientId, refreshToken });
}

/** `{domain}/logout?client_id=…&logout_uri={origin}/host`: ends the managed-login session too. */
export function logoutUrl(cfg: CognitoAuth, origin: string): string {
  const query = new URLSearchParams({
    client_id: cfg.clientId,
    logout_uri: redirectUriFor(origin),
  });
  return `${cfg.domain.replace(/\/+$/, '')}/logout?${query.toString()}`;
}

export interface Tokens {
  /** Sent as the bearer: it carries `email` for display (ADR-0009). */
  idToken: string;
  refreshToken: string | null;
  /** Local epoch ms. */
  expiresAt: number;
}

/**
 * Reads the token endpoint's JSON. A refresh reply carries no new refresh token, so the one
 * we hold stays. Null when the reply is not a usable token response.
 */
export function parseTokenResponse(
  json: unknown,
  now: number,
  previousRefreshToken: string | null = null,
): Tokens | null {
  if (typeof json !== 'object' || json === null) return null;
  const r = json as Record<string, unknown>;
  if (typeof r.id_token !== 'string' || r.id_token === '') return null;
  const seconds = typeof r.expires_in === 'number' && r.expires_in > 0 ? r.expires_in : 3600;
  return {
    idToken: r.id_token,
    refreshToken: typeof r.refresh_token === 'string' ? r.refresh_token : previousRefreshToken,
    expiresAt: now + seconds * 1000,
  };
}

/** Refresh this long before the token runs out, so a request never leaves with a stale one. */
export const REFRESH_LEAD_MS = 60_000;

export function refreshDelayMs(expiresAt: number, now: number): number {
  return Math.max(0, expiresAt - now - REFRESH_LEAD_MS);
}
