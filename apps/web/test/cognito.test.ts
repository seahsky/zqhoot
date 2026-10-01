import { describe, expect, it } from 'vitest';
import {
  REFRESH_LEAD_MS,
  authorizeUrl,
  logoutUrl,
  parseTokenResponse,
  redirectUriFor,
  refreshDelayMs,
  refreshRequest,
  tokenRequest,
} from '../src/auth/cognito.ts';
import type { CognitoAuth } from '../src/auth/cognito.ts';

const CFG: CognitoAuth = {
  mode: 'cognito',
  region: 'us-east-1',
  userPoolId: 'us-east-1_AbCdEf',
  clientId: '3n4b5urk1ft4fl3mg5e62d9ado',
  domain: 'https://zqhoot-abc.auth.us-east-1.amazoncognito.com',
};
const ORIGIN = 'https://quiz.example.test';

describe('the authorize URL', () => {
  const url = new URL(authorizeUrl(CFG, ORIGIN, 'CHALLENGE', 'STATE'));

  it('is the managed-login endpoint of the configured domain', () => {
    expect(url.origin + url.pathname).toBe(`${CFG.domain}/oauth2/authorize`);
  });

  it('asks for an authorization code with PKCE, S256', () => {
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: CFG.clientId,
      redirect_uri: `${ORIGIN}/host`,
      scope: 'openid email profile',
      code_challenge: 'CHALLENGE',
      code_challenge_method: 'S256',
      state: 'STATE',
    });
  });

  it('a trailing slash on the origin or domain changes nothing', () => {
    expect(
      authorizeUrl({ ...CFG, domain: `${CFG.domain}/` }, `${ORIGIN}/`, 'CHALLENGE', 'STATE'),
    ).toBe(url.toString());
    expect(redirectUriFor(`${ORIGIN}/`)).toBe(`${ORIGIN}/host`);
  });
});

describe('the token requests', () => {
  it('trades the code, form-encoded, with the verifier and the same redirect URI', () => {
    const req = tokenRequest(CFG, ORIGIN, 'CODE', 'VERIFIER');
    expect(req.url).toBe(`${CFG.domain}/oauth2/token`);
    expect(req.body).toBeInstanceOf(URLSearchParams);
    expect(Object.fromEntries(req.body)).toEqual({
      grant_type: 'authorization_code',
      client_id: CFG.clientId,
      code: 'CODE',
      redirect_uri: `${ORIGIN}/host`,
      code_verifier: 'VERIFIER',
    });
    expect(req.body.toString()).toContain('redirect_uri=https%3A%2F%2Fquiz.example.test%2Fhost');
  });

  it('refreshes with the refresh token and no secret', () => {
    const req = refreshRequest(CFG, 'REFRESH');
    expect(req.url).toBe(`${CFG.domain}/oauth2/token`);
    expect(Object.fromEntries(req.body)).toEqual({
      grant_type: 'refresh_token',
      client_id: CFG.clientId,
      refresh_token: 'REFRESH',
    });
  });
});

describe('the logout URL', () => {
  it('names the client and returns to /host', () => {
    const url = new URL(logoutUrl(CFG, ORIGIN));
    expect(url.origin + url.pathname).toBe(`${CFG.domain}/logout`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CFG.clientId,
      logout_uri: `${ORIGIN}/host`,
    });
  });
});

describe('the token response', () => {
  it('uses the ID token, and expires it from expires_in', () => {
    expect(
      parseTokenResponse(
        {
          id_token: 'ID',
          access_token: 'AT',
          refresh_token: 'RT',
          expires_in: 3600,
          token_type: 'Bearer',
        },
        1_000_000,
      ),
    ).toEqual({ idToken: 'ID', refreshToken: 'RT', expiresAt: 1_000_000 + 3_600_000 });
  });

  it('keeps the refresh token it already has when a refresh reply omits one', () => {
    expect(parseTokenResponse({ id_token: 'ID2', expires_in: 60 }, 0, 'OLD')).toEqual({
      idToken: 'ID2',
      refreshToken: 'OLD',
      expiresAt: 60_000,
    });
  });

  it('rejects anything that is not a token response', () => {
    for (const bad of [
      null,
      'x',
      {},
      { id_token: '' },
      { access_token: 'only' },
      { id_token: 5 },
    ]) {
      expect(parseTokenResponse(bad, 0), JSON.stringify(bad)).toBeNull();
    }
  });

  it('refreshes a minute before expiry, or at once if that time has passed', () => {
    expect(refreshDelayMs(10 * 60_000, 0)).toBe(10 * 60_000 - REFRESH_LEAD_MS);
    expect(refreshDelayMs(30_000, 0)).toBe(0);
    expect(refreshDelayMs(0, 5_000)).toBe(0);
  });
});
