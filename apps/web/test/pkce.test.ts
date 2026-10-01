import { describe, expect, it } from 'vitest';
import {
  base64Url,
  buildAuthorizeUrl,
  buildRefreshRequest,
  buildTokenRequest,
  challengeS256,
  createState,
  createVerifier,
  parseCallback,
} from '../src/auth/pkce.ts';

describe('PKCE', () => {
  it('matches the RFC 7636 appendix B test vector for S256', async () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(await challengeS256(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('base64url-encodes without padding or unsafe characters', () => {
    expect(base64Url(new Uint8Array([0xfb, 0xff, 0xfe]))).toBe('-__-');
    expect(base64Url(new Uint8Array([1]))).toBe('AQ');
    expect(base64Url(new Uint8Array([]))).toBe('');
  });

  it('creates verifiers of 43 URL-safe characters from 32 random bytes', () => {
    const v = createVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createVerifier()).not.toBe(v);
  });

  it('draws the verifier from the injected random source', () => {
    const fake = ((a: Uint8Array) => {
      a.fill(0);
      return a;
    }) as Crypto['getRandomValues'];
    expect(createVerifier(fake)).toBe('A'.repeat(43));
  });

  it('creates unguessable state values', () => {
    expect(createState()).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('builds the Cognito authorize URL with every PKCE parameter', () => {
    const url = new URL(
      buildAuthorizeUrl({
        domain: 'https://zq.auth.us-east-1.amazoncognito.com/',
        clientId: 'client123',
        redirectUri: 'https://quiz.example/host',
        challenge: 'CHALLENGE',
        state: 'STATE',
      }),
    );
    expect(url.origin + url.pathname).toBe(
      'https://zq.auth.us-east-1.amazoncognito.com/oauth2/authorize',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'client123',
      redirect_uri: 'https://quiz.example/host',
      scope: 'openid email profile',
      code_challenge: 'CHALLENGE',
      code_challenge_method: 'S256',
      state: 'STATE',
    });
  });

  describe('parseCallback', () => {
    it('returns the code when the state matches', () => {
      expect(parseCallback('?code=abc&state=xyz', 'xyz')).toEqual({ kind: 'code', code: 'abc' });
    });

    it('rejects a state mismatch or a missing expected state', () => {
      expect(parseCallback('?code=abc&state=other', 'xyz')).toMatchObject({
        kind: 'error',
        error: 'state_mismatch',
      });
      expect(parseCallback('?code=abc', 'xyz')).toMatchObject({ error: 'state_mismatch' });
      expect(parseCallback('?code=abc&state=xyz', null)).toMatchObject({ error: 'state_mismatch' });
    });

    it('surfaces an error response, whatever the state', () => {
      expect(parseCallback('?error=access_denied&error_description=No+thanks', 'xyz')).toEqual({
        kind: 'error',
        error: 'access_denied',
        description: 'No thanks',
      });
    });

    it('reports "none" when the URL is not a callback', () => {
      expect(parseCallback('', 'xyz')).toEqual({ kind: 'none' });
      expect(parseCallback('?tab=quizzes', 'xyz')).toEqual({ kind: 'none' });
    });
  });

  it('builds token and refresh requests as form bodies', () => {
    const t = buildTokenRequest({
      domain: 'https://d.example',
      clientId: 'c',
      redirectUri: 'https://s.example/host',
      code: 'CODE',
      verifier: 'VERIFIER',
    });
    expect(t.url).toBe('https://d.example/oauth2/token');
    expect(Object.fromEntries(t.body)).toEqual({
      grant_type: 'authorization_code',
      client_id: 'c',
      code: 'CODE',
      redirect_uri: 'https://s.example/host',
      code_verifier: 'VERIFIER',
    });
    const r = buildRefreshRequest({
      domain: 'https://d.example',
      clientId: 'c',
      refreshToken: 'R',
    });
    expect(Object.fromEntries(r.body)).toEqual({
      grant_type: 'refresh_token',
      client_id: 'c',
      refresh_token: 'R',
    });
  });
});
