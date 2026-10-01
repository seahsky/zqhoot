import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RuntimeConfig } from '@zqhoot/protocol';
import { rawRequest } from './helpers/http.ts';
import { INDEX_HTML, createWorkspace, startServer } from './helpers/server.ts';
import type { TestServer, Workspace } from './helpers/server.ts';

let workspace: Workspace;
let server: TestServer;

beforeAll(async () => {
  workspace = await createWorkspace();
  server = await startServer(workspace);
});

afterAll(async () => {
  await server.close();
  await workspace.cleanup();
});

describe('config.json', () => {
  it('is a valid RuntimeConfig derived from ZQ_PUBLIC_URL', async () => {
    const res = await rawRequest(server, 'GET', '/config.json');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-cache');
    const config = RuntimeConfig.parse(JSON.parse(res.text));
    expect(config).toEqual({
      target: 'vm',
      apiBaseUrl: '',
      wsUrl: 'ws://quiz.test/ws',
      mediaBaseUrl: 'http://quiz.test/',
      joinUrl: 'http://quiz.test/join',
      auth: { mode: 'local' },
    });
  });

  it('uses wss for an https public URL, keeps the port, and contains no secret', async () => {
    const secure = await startServer(workspace, {
      env: { ZQ_PUBLIC_URL: 'https://quiz.example.com:8443' },
    });
    try {
      const res = await rawRequest(secure, 'GET', '/config.json');
      const config = RuntimeConfig.parse(JSON.parse(res.text));
      expect(config.wsUrl).toBe('wss://quiz.example.com:8443/ws');
      expect(config.joinUrl).toBe('https://quiz.example.com:8443/join');
      expect(res.text).not.toContain('secret');
      expect(res.text).not.toContain('correct horse');
    } finally {
      await secure.close();
    }
  });

  it('answers HEAD without a body', async () => {
    const res = await rawRequest(server, 'HEAD', '/config.json');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
    expect(Number(res.headers['content-length'])).toBeGreaterThan(50);
  });
});

describe('web app', () => {
  it('serves index.html at / with no-cache and the ADR-0013 headers', async () => {
    const res = await rawRequest(server, 'GET', '/');
    expect(res.status).toBe(200);
    expect(res.text).toBe(INDEX_HTML);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-cache');
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self' ws://quiz.test");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(res.headers['permissions-policy']).toBe('camera=(), microphone=(), geolocation=()');
    // Plain http: an HSTS header would only pin a local setup to https.
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('sends HSTS and a wss connect-src when the public URL is https', async () => {
    const secure = await startServer(workspace, {
      env: { ZQ_PUBLIC_URL: 'https://quiz.example.com' },
    });
    try {
      const res = await rawRequest(secure, 'GET', '/');
      expect(res.headers['strict-transport-security']).toBe('max-age=31536000');
      expect(String(res.headers['content-security-policy'])).toContain(
        "connect-src 'self' wss://quiz.example.com;",
      );
    } finally {
      await secure.close();
    }
  });

  it('serves hashed assets as immutable with the right type', async () => {
    const js = await rawRequest(server, 'GET', '/assets/app-abc123.js');
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(js.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(js.headers['x-content-type-options']).toBe('nosniff');
    expect(js.headers['content-security-policy']).toBeUndefined();
    const css = await rawRequest(server, 'GET', '/assets/app-abc123.css');
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8');
  });

  it('serves other static files with revalidation', async () => {
    const res = await rawRequest(server, 'GET', '/favicon.svg');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/svg+xml');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('answers 304 to a matching If-None-Match', async () => {
    const first = await rawRequest(server, 'GET', '/favicon.svg');
    const etag = String(first.headers.etag);
    expect(etag).toMatch(/^W\/"/);
    const again = await rawRequest(server, 'GET', '/favicon.svg', {
      headers: { 'If-None-Match': etag },
    });
    expect(again.status).toBe(304);
    expect(again.body).toHaveLength(0);
    const other = await rawRequest(server, 'GET', '/favicon.svg', {
      headers: { 'If-None-Match': '"nope"' },
    });
    expect(other.status).toBe(200);
  });

  it.each([
    '/host',
    '/host/session/abc',
    '/play',
    '/present',
    '/edit/quiz-1',
    '/join',
    '/no/such/page',
  ])('falls back to index.html for the extension-less route %s', async (path) => {
    const res = await rawRequest(server, 'GET', path);
    expect(res.status).toBe(200);
    expect(res.text).toBe(INDEX_HTML);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['content-security-policy']).toBeDefined();
  });

  it('falls back for a query string too, and for HEAD', async () => {
    expect((await rawRequest(server, 'GET', '/join?pin=123456')).text).toBe(INDEX_HTML);
    const head = await rawRequest(server, 'HEAD', '/host');
    expect(head.status).toBe(200);
    expect(head.body).toHaveLength(0);
  });

  it('answers 404, not the app shell, for a missing file', async () => {
    for (const path of ['/assets/app-old999.js', '/missing.css', '/robots.txt', '/assets/x.png']) {
      const res = await rawRequest(server, 'GET', path);
      expect(res.status).toBe(404);
      expect(res.text).not.toContain('app shell');
    }
  });

  it('never falls back for /api, /ws or /media', async () => {
    const api = await rawRequest(server, 'GET', '/api/nothing-here');
    expect(api.status).toBe(404);
    expect(JSON.parse(api.text)).toMatchObject({ error: 'not-found' });
    for (const path of ['/ws', '/ws/x', '/media/anything', '/media']) {
      const res = await rawRequest(server, 'GET', path);
      expect(res.status).toBe(404);
      expect(res.text).not.toContain('app shell');
    }
  });

  it('does not serve dotfiles, but does serve /.well-known', async () => {
    for (const path of ['/.env', '/.git/config', '/assets/../.env', '/.git', '/%2eenv']) {
      const res = await rawRequest(server, 'GET', path);
      expect([400, 404], path).toContain(res.status);
      expect(res.text).not.toContain('SECRET');
    }
    const wellKnown = await rawRequest(server, 'GET', '/.well-known/security.txt');
    expect(wellKnown.status).toBe(200);
    expect(wellKnown.text).toContain('Contact');
  });

  it('refuses methods other than GET and HEAD', async () => {
    const res = await rawRequest(server, 'POST', '/');
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe('GET, HEAD');
  });

  it('serves the API under /api', async () => {
    const res = await rawRequest(server, 'GET', '/api/health');
    expect(JSON.parse(res.text)).toEqual({ ok: true, version: expect.any(String), target: 'vm' });
  });
});

describe('path traversal', () => {
  const attempts = [
    '/../secret.txt',
    '/assets/../../secret.txt',
    '/%2e%2e/secret.txt',
    '/%2E%2E/%2E%2E/secret.txt',
    '/assets/%2e%2e/%2e%2e/secret.txt',
    '/..%2fsecret.txt',
    '/assets/..%2f..%2fsecret.txt',
    '/%2e%2e%2fsecret.txt',
    '/..%5csecret.txt',
    '/assets\\..\\..\\secret.txt',
    '/index.html%00.png',
    '/%00',
    '/%',
    '/%zz',
  ];

  it.each(attempts)('rejects %s', async (path) => {
    const res = await rawRequest(server, 'GET', path);
    expect(res.status).toBe(400);
    expect(res.text).not.toContain('TOP-SECRET');
  });

  it('rejects traversal towards the data directory through /media', async () => {
    for (const path of [
      '/media/../state.json',
      '/media/%2e%2e/state.json',
      '/media/x/../../state.json',
    ]) {
      const res = await rawRequest(server, 'GET', path);
      expect([400, 404]).toContain(res.status);
      expect(res.text).not.toContain('"format"');
    }
  });

  it('rejects an absolute-form request target', async () => {
    const res = await rawRequest(server, 'GET', 'http://quiz.test/');
    expect(res.status).toBe(400);
  });
});
