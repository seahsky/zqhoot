import { describe, expect, it } from 'vitest';
import { LIMITS, Quiz } from '@zqhoot/protocol';
import type { PinLookupResponse, QuizSummary, SessionSummary, UploadGrant } from '@zqhoot/protocol';
import { ConflictError } from '@zqhoot/store';
import { createHttpApp } from '../src/index.ts';
import type { LocalLogin } from '../src/index.ts';
import { HOST_TOKENS, describeWithStores } from './harness.ts';
import type { Harness } from './harness.ts';
import { allTypesQuiz, miniQuiz } from './fixtures.ts';
import { startGame, text, choice } from './game.ts';
import { seedSession } from './seed.ts';

const A = HOST_TOKENS.a;
const B = HOST_TOKENS.b;

const localLogin: LocalLogin = {
  async login(username, password) {
    return username === 'admin' && password === 'secret'
      ? { token: A, expiresAt: 4_102_444_800_000 + 12 * 3_600_000 }
      : null;
  },
};

/** Every response, whatever its status, carries these (ADR-0013). */
function expectSecurityHeaders(res: { headers: Headers }) {
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
}

const SITE = 'https://quiz.example.com';

/** The app as the AWS target builds it: over the harness's store, answering CORS for `origins`. */
function corsApp(h: Harness, origins: string[]) {
  return createHttpApp({
    store: h.store,
    clock: h.clock,
    ids: h.ids,
    hostAuth: h.hostAuth,
    media: h.media,
    logger: h.logger,
    engine: h.engine,
    info: { target: 'aws', version: 'test' },
    clientIp: () => h.ip,
    cors: { origins },
  });
}

const corsHeaders = (res: { headers: Headers }): string[] =>
  [...res.headers.keys()].filter((name) => name.startsWith('access-control-'));

const errorBody = (res: { json: <T>() => T }) => res.json<{ error: string; message: string }>();

/**
 * A second HTTP app over the same store and clock, as another Lambda container would be: it
 * shares nothing with `h.app` except what lives in the store.
 */
function secondInstance(h: Harness) {
  const app = createHttpApp({
    store: h.store,
    clock: h.clock,
    ids: h.ids,
    hostAuth: h.hostAuth,
    media: h.media,
    logger: h.logger,
    engine: h.engine,
    info: { target: 'aws', version: 'test' },
    clientIp: (c) => c.req.header('x-test-ip') ?? h.ip,
  });
  return async (path: string, ip: string) => {
    const res = await app.request(path, { headers: { 'x-test-ip': ip } });
    return { status: res.status, retryAfter: res.headers.get('retry-after') };
  };
}

describeWithStores('HTTP app', (make) => {
  describe('cross-cutting rules', () => {
    it('answers health without authentication and marks every response no-store/nosniff', async () => {
      const h = await make();
      const health = await h.api('GET', '/api/health');
      expect(health.status).toBe(200);
      expect(health.json()).toEqual({ ok: true, version: 'test', target: 'vm' });
      expectSecurityHeaders(health);

      const responses = [
        await h.api('GET', '/api/nothing-here'), // 404
        await h.api('GET', '/api/me'), // 401
        await h.api('POST', '/api/quizzes', { token: A, raw: '{not json' }), // 400
        await h.api('GET', '/api/join/12'), // 400
        await h.api('GET', '/api/quizzes/abcdef', { token: A }), // 404
      ];
      expect(responses.map((r) => r.status)).toEqual([404, 401, 400, 400, 404]);
      for (const res of responses) expectSecurityHeaders(res);
    });

    it('gives every request an id, keeping a sane one from the caller', async () => {
      const h = await make();
      const generated = await h.api('GET', '/api/health');
      expect(generated.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
      const kept = await h.api('GET', '/api/health', {
        headers: { 'x-request-id': 'trace-123_ab' },
      });
      expect(kept.headers.get('x-request-id')).toBe('trace-123_ab');
      for (const bad of ['bad id!', 'x'.repeat(65)]) {
        const replaced = await h.api('GET', '/api/health', { headers: { 'x-request-id': bad } });
        expect(replaced.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
      }
    });

    it('turns unexpected errors into a generic 500 and logs them with the request id', async () => {
      const h = await make();
      h.overrides.listQuizzes = async () => {
        throw new Error('connection string leaked: dynamodb://secret');
      };
      const res = await h.api('GET', '/api/quizzes', { token: A });
      expect(res.status).toBe(500);
      expect(res.json()).toEqual({ error: 'internal', message: 'internal error' });
      expect(res.text).not.toContain('secret');
      expectSecurityHeaders(res);
      const logged = h.logger.entries.error.at(-1)!;
      expect(logged.o).toMatchObject({
        requestId: res.headers.get('x-request-id'),
        method: 'GET',
        path: '/api/quizzes',
      });
      expect(JSON.stringify(logged.o)).toContain('connection string leaked');
      h.overrides = {};
    });

    it('limits JSON bodies to 256 KB, with or without a content-length header', async () => {
      const h = await make();
      const quiz = await h.createQuiz(miniQuiz());
      const pad = (size: number) => {
        const base = JSON.stringify({ quizId: quiz.id, pad: '' });
        return JSON.stringify({ quizId: quiz.id, pad: 'x'.repeat(size - base.length) });
      };
      const limit = 256 * 1024;
      for (const withHeader of [false, true]) {
        const headers = (body: string): Record<string, string> =>
          withHeader ? { 'content-length': String(new TextEncoder().encode(body).length) } : {};
        const atLimit = pad(limit);
        const ok = await h.api('POST', '/api/sessions', {
          token: A,
          raw: atLimit,
          headers: headers(atLimit),
        });
        expect(ok.status, `at the limit, header ${withHeader}`).toBe(200);
        const over = pad(limit + 1);
        const res = await h.api('POST', '/api/sessions', {
          token: A,
          raw: over,
          headers: headers(over),
        });
        expect(res.status, `over the limit, header ${withHeader}`).toBe(413);
        expect(errorBody(res).error).toBe('payload-too-large');
        expectSecurityHeaders(res);
      }
    });

    it('requires a bearer token on every host route', async () => {
      const h = await make();
      const routes: Array<[string, string]> = [
        ['GET', '/api/me'],
        ['GET', '/api/quizzes'],
        ['POST', '/api/quizzes'],
        ['GET', '/api/quizzes/abcdef'],
        ['PUT', '/api/quizzes/abcdef'],
        ['DELETE', '/api/quizzes/abcdef'],
        ['POST', '/api/quizzes/abcdef/duplicate'],
        ['POST', '/api/media/uploads'],
        ['POST', '/api/sessions'],
        ['GET', '/api/sessions'],
        ['GET', '/api/sessions/abcdef/results.csv'],
      ];
      const badHeaders: Array<Record<string, string>> = [
        {},
        { authorization: 'Bearer' },
        { authorization: 'Bearer not-a-token' },
        { authorization: 'Basic dXNlcjpwYXNz' },
        { authorization: `Bearer ${A} extra` },
        { authorization: `Bearer ${'x'.repeat(5000)}` },
      ];
      for (const [method, path] of routes) {
        for (const headers of badHeaders) {
          const res = await h.api(method, path, { headers });
          expect(res.status, `${method} ${path} ${JSON.stringify(headers).slice(0, 40)}`).toBe(401);
          expect(errorBody(res).error).toBe('unauthorized');
          expect(res.headers.get('www-authenticate')).toBe('Bearer');
        }
      }
      // The scheme is case-insensitive.
      const ok = await h.api('GET', '/api/me', { headers: { authorization: `bearer ${A}` } });
      expect(ok.status).toBe(200);
    });

    it('returns the host identity', async () => {
      const h = await make();
      const me = await h.api('GET', '/api/me', { token: A });
      expect(me.json()).toEqual({ hostId: h.hostIds.a, displayName: 'Host A' });
    });
  });

  describe('CORS', () => {
    const preflight = (app: Harness['app'], origin: string) =>
      app.request('/api/quizzes', {
        method: 'OPTIONS',
        headers: {
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization,content-type',
        },
      });

    it('answers a preflight from an allowed origin with 204 and the allow-list', async () => {
      const h = await make();
      const res = await preflight(corsApp(h, [SITE]), SITE);
      expect(res.status).toBe(204);
      expect(await res.text()).toBe('');
      expect(res.headers.get('access-control-allow-origin')).toBe(SITE);
      expect(res.headers.get('access-control-allow-methods')).toBe('GET,POST,PUT,DELETE,OPTIONS');
      expect(res.headers.get('access-control-allow-headers')).toBe('authorization,content-type');
      expect(res.headers.get('access-control-max-age')).toBe('86400');
      // Bearer tokens in a header, never cookies.
      expect(res.headers.get('access-control-allow-credentials')).toBeNull();
      expect(res.headers.get('vary')).toContain('Origin');
      expectSecurityHeaders(res);
    });

    it('needs no token for the preflight, whichever /api path it names', async () => {
      const h = await make();
      const app = corsApp(h, [SITE]);
      for (const path of ['/api/me', '/api/join/123456', '/api/sessions/abcdef/results.csv']) {
        const res = await app.request(path, {
          method: 'OPTIONS',
          headers: { origin: SITE, 'access-control-request-method': 'GET' },
        });
        expect(res.status, path).toBe(204);
        expect(res.headers.get('access-control-allow-origin'), path).toBe(SITE);
      }
    });

    it('gives a disallowed origin no CORS headers at all', async () => {
      const h = await make();
      const app = corsApp(h, [SITE]);
      const lookalikes = [
        'https://evil.example',
        'http://quiz.example.com',
        'https://quiz.example.com:8443',
        'https://quiz.example.com.evil.example',
        'https://sub.quiz.example.com',
        'https://QUIZ.example.com',
        `${SITE}/`,
        'null',
        '*',
      ];
      for (const origin of lookalikes) {
        const pre = await preflight(app, origin);
        expect(corsHeaders(pre), `preflight from ${origin}`).toEqual([]);
        const get = await app.request('/api/health', { headers: { origin } });
        expect(get.status, origin).toBe(200);
        expect(corsHeaders(get), `GET from ${origin}`).toEqual([]);
      }
    });

    it('sends Access-Control-Allow-Origin and the exposed headers on an actual GET', async () => {
      const h = await make();
      const res = await corsApp(h, [SITE]).request('/api/health', { headers: { origin: SITE } });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe(SITE);
      expect(res.headers.get('access-control-expose-headers')).toBe(
        'content-disposition,retry-after,x-request-id',
      );
      expect(res.headers.get('access-control-allow-credentials')).toBeNull();
      expect(res.headers.get('vary')).toContain('Origin');
      // The body and the other headers are as they are without CORS.
      expect(await res.json()).toEqual({ ok: true, version: 'test', target: 'aws' });
      expectSecurityHeaders(res);
      expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('lets the browser read errors too: 401, 404, 413 and 429 carry the headers', async () => {
      const h = await make();
      const app = corsApp(h, [SITE]);
      const send = (path: string, init: RequestInit = {}) =>
        app.request(path, { ...init, headers: { origin: SITE, ...init.headers } });

      const responses = {
        401: await send('/api/me'),
        404: await send('/api/nothing-here'),
        413: await send('/api/quizzes', {
          method: 'POST',
          headers: { authorization: `Bearer ${A}`, 'content-type': 'application/json' },
          body: 'x'.repeat(256 * 1024 + 1),
        }),
      };
      for (const [status, res] of Object.entries(responses)) {
        expect(res.status).toBe(Number(status));
        expect(res.headers.get('access-control-allow-origin'), status).toBe(SITE);
      }

      // A rate-limited caller must be able to read Retry-After cross-origin.
      let limited = await send('/api/join/123456');
      for (let i = 0; i < 30 && limited.status !== 429; i++) {
        limited = await send('/api/join/123456');
      }
      expect(limited.status).toBe(429);
      expect(limited.headers.get('access-control-allow-origin')).toBe(SITE);
      expect(limited.headers.get('access-control-expose-headers')).toContain('retry-after');
      expect(limited.headers.get('retry-after')).toMatch(/^\d+$/);
    });

    it('allows exactly the configured origins', async () => {
      const h = await make();
      const other = 'https://quiz.example.org';
      const app = corsApp(h, [SITE, other]);
      for (const origin of [SITE, other]) {
        const res = await app.request('/api/health', { headers: { origin } });
        expect(res.headers.get('access-control-allow-origin')).toBe(origin);
      }
      const stranger = await app.request('/api/health', {
        headers: { origin: 'https://x.example' },
      });
      expect(corsHeaders(stranger)).toEqual([]);
      // An empty list allows nobody.
      const none = await corsApp(h, []).request('/api/health', { headers: { origin: SITE } });
      expect(corsHeaders(none)).toEqual([]);
    });

    it('adds no CORS headers to a request without an Origin', async () => {
      const h = await make();
      const res = await corsApp(h, [SITE]).request('/api/health');
      expect(res.status).toBe(200);
      expect(corsHeaders(res)).toEqual([]);
    });

    it('serves nothing outside /api/{segment}, the one path shape the AWS route forwards', async () => {
      // API Gateway sends OPTIONS (and everything else) to the function only for the route
      // `ANY /api/{proxy+}`, which needs at least one segment after /api/. A handler registered
      // anywhere else would answer real requests but never its preflight.
      const h = await make();
      const served = h.app.routes.filter((r) => r.method !== 'ALL').map((r) => r.path);
      expect(served.length).toBeGreaterThan(10);
      for (const path of served) expect(path, path).toMatch(/^\/api\/[^/]+/);
    });

    it('leaves paths outside /api alone', async () => {
      const h = await make();
      const res = await corsApp(h, [SITE]).request('/elsewhere', { headers: { origin: SITE } });
      expect(res.status).toBe(404);
      expect(corsHeaders(res)).toEqual([]);
    });

    it('applies no CORS middleware when `cors` is not configured (the VM is same-origin)', async () => {
      const h = await make();
      const get = await h.app.request('/api/health', { headers: { origin: SITE } });
      expect(get.status).toBe(200);
      expect(corsHeaders(get)).toEqual([]);
      expect(get.headers.get('vary')).toBeNull();
      const pre = await preflight(h.app, SITE);
      expect(corsHeaders(pre)).toEqual([]);
      expect(pre.status).toBe(404);
    });
  });

  describe('GET /api/join/:pin', () => {
    it('reports joinable, locked, full and ended sessions', async () => {
      const h = await make();
      const g = await startGame(h);
      const lookup = async (pin: string) => h.api('GET', `/api/join/${pin}`);
      let res = await lookup(g.pin);
      expect(res.status).toBe(200);
      expect(res.json<PinLookupResponse>()).toEqual({
        sessionId: g.sessionId,
        quizTitle: 'Mini quiz',
        joinable: true,
      });
      await h.send(g.control, { type: 'host.lock', locked: true });
      expect((res = await lookup(g.pin)).json()).toMatchObject({
        joinable: false,
        reason: 'locked',
      });
      await h.send(g.control, { type: 'host.lock', locked: false });

      const tiny = await seedSession(h, { maxPlayers: 1 });
      const solo = h.cid('solo');
      await h.send(solo, { type: 'join', v: 1, pin: tiny.pin, nickname: 'Solo' });
      expect((await lookup(tiny.pin)).json()).toMatchObject({ joinable: false, reason: 'full' });

      const ended = await seedSession(h, { patch: { phase: 'ended', endedAt: h.clock.now() } });
      expect((await lookup(ended.pin)).json()).toMatchObject({ joinable: false, reason: 'ended' });
      // The response is exactly the protocol shape.
      expect(Object.keys((await lookup(g.pin)).json()).sort()).toEqual([
        'joinable',
        'quizTitle',
        'sessionId',
      ]);
    });

    it('answers 404 for unknown and expired PINs and 400 for malformed ones', async () => {
      const h = await make();
      const g = await startGame(h);
      expect((await h.api('GET', '/api/join/000000')).status).toBe(404);
      for (const bad of ['12345', '1234567', 'abcdef', '12 456']) {
        expect((await h.api('GET', `/api/join/${bad}`)).status, bad).toBe(400);
      }
      const meta = (await h.store.getSession(g.sessionId))!;
      h.clock.set(meta.expiresAt + 2000);
      const res = await h.api('GET', `/api/join/${g.pin}`);
      expect(res.status).toBe(404);
      expect(errorBody(res).error).toBe('not-found');
    });

    it('counts only failed lookups toward the per-IP limit (30 per minute)', async () => {
      const h = await make();
      const g = await startGame(h);
      const ip = 'classroom-1';
      // A whole classroom looks up a valid PIN from one IP: none of it counts.
      for (let i = 0; i < 60; i++) {
        expect((await h.api('GET', `/api/join/${g.pin}`, { ip })).status).toBe(200);
      }
      for (let i = 0; i < 30; i++) {
        expect((await h.api('GET', `/api/join/000000`, { ip })).status, `miss ${i + 1}`).toBe(404);
      }
      const limited = await h.api('GET', '/api/join/000000', { ip });
      expect(limited.status).toBe(429);
      expect(errorBody(limited).error).toBe('rate-limited');
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
      expectSecurityHeaders(limited);

      // Once over the limit every lookup from that IP is refused, hits included, until the window ends.
      expect((await h.api('GET', `/api/join/${g.pin}`, { ip })).status).toBe(429);
      expect((await h.api('GET', `/api/join/${g.pin}`, { ip: 'classroom-2' })).status).toBe(200);
      h.clock.advance(59_000);
      expect((await h.api('GET', `/api/join/${g.pin}`, { ip })).status).toBe(429);
      h.clock.advance(1000);
      expect((await h.api('GET', `/api/join/${g.pin}`, { ip })).status).toBe(200);
      expect((await h.api('GET', '/api/join/000000', { ip })).status).toBe(404);
    });

    it('does not count malformed PINs', async () => {
      const h = await make();
      for (let i = 0; i < 50; i++)
        expect((await h.api('GET', '/api/join/abc', { ip: 'typo' })).status).toBe(400);
      expect((await h.api('GET', '/api/join/000000', { ip: 'typo' })).status).toBe(404);
      expect(h.calls.filter((c) => c === 'hitRateLimit')).toHaveLength(1);
    });

    describe('block shared through the store', () => {
      const overLimit = async (h: Harness, ip: string) => {
        for (let i = 0; i < 30; i++) {
          expect((await h.api('GET', '/api/join/000000', { ip })).status, `miss ${i + 1}`).toBe(
            404,
          );
        }
        expect((await h.api('GET', '/api/join/000000', { ip })).status).toBe(429);
      };

      it('blocks a valid PIN on a second instance that never saw the misses', async () => {
        const h = await make();
        const g = await startGame(h);
        const instanceB = secondInstance(h);
        const ip = 'shared-nat-1';
        const path = `/api/join/${g.pin}`;

        await overLimit(h, ip); // instance A
        const hit = await instanceB(path, ip);
        expect(hit.status).toBe(429);
        expect(Number(hit.retryAfter)).toBeGreaterThan(0);
        expect((await instanceB('/api/join/000000', ip)).status).toBe(429);
        expect((await instanceB(path, 'shared-nat-2')).status).toBe(200);

        h.clock.advance(59_000);
        expect((await instanceB(path, ip)).status).toBe(429);
        h.clock.advance(1000);
        expect((await instanceB(path, ip)).status).toBe(200);
        expect((await h.api('GET', path, { ip })).status).toBe(200);
      });

      it('blocks in both directions and adds up misses across instances', async () => {
        const h = await make();
        const g = await startGame(h);
        const instanceB = secondInstance(h);
        const ip = 'shared-nat-3';
        // Alternating instances, 30 misses in all: neither has seen more than 15 of them.
        for (let i = 0; i < 30; i++) {
          const res =
            i % 2 === 0
              ? await instanceB('/api/join/000000', ip)
              : await h.api('GET', '/api/join/000000', { ip });
          expect(res.status, `miss ${i + 1}`).toBe(404);
        }
        expect((await instanceB('/api/join/000000', ip)).status).toBe(429);
        expect((await h.api('GET', `/api/join/${g.pin}`, { ip })).status).toBe(429);
      });

      it('never counts successful lookups: 400 from one IP, across instances, all succeed', async () => {
        const h = await make();
        const g = await startGame(h);
        const instanceB = secondInstance(h);
        const ip = 'big-classroom';
        for (let i = 0; i < 400; i++) {
          const res =
            i % 2 === 0
              ? await h.api('GET', `/api/join/${g.pin}`, { ip })
              : await instanceB(`/api/join/${g.pin}`, ip);
          expect(res.status, `lookup ${i + 1}`).toBe(200);
        }
        expect(h.calls.filter((c) => c === 'hitRateLimit')).toHaveLength(0);
        // The counter is still at zero: a full 30 misses fit.
        for (let i = 0; i < 30; i++) {
          expect((await h.api('GET', '/api/join/000000', { ip })).status, `miss ${i + 1}`).toBe(
            404,
          );
        }
        expect((await h.api('GET', '/api/join/000000', { ip })).status).toBe(429);
      });

      it('reads the block before it looks anything up', async () => {
        const h = await make();
        const g = await startGame(h);
        const ip = 'order-check';

        h.resetCalls();
        expect((await h.api('GET', `/api/join/${g.pin}`, { ip })).status).toBe(200);
        expect(h.calls[0]).toBe('peekRateLimit');
        expect(h.calls).not.toContain('hitRateLimit');

        h.resetCalls();
        expect((await h.api('GET', '/api/join/000000', { ip })).status).toBe(404);
        expect(h.calls.slice(0, 2)).toEqual(['peekRateLimit', 'getSessionIdByPin']);
        expect(h.calls.at(-1)).toBe('hitRateLimit');

        // One miss is already counted, so 29 more are within the limit and the 31st is not.
        for (let i = 0; i < 29; i++) await h.api('GET', '/api/join/000000', { ip });
        expect((await h.api('GET', '/api/join/000000', { ip })).status).toBe(429);
        h.resetCalls();
        expect((await h.api('GET', `/api/join/${g.pin}`, { ip })).status).toBe(429);
        // A blocked IP costs one read and touches neither the PIN nor the session.
        expect(h.calls).toEqual(['peekRateLimit']);
      });
    });
  });

  describe('POST /api/auth/login', () => {
    it('does not exist without a local login', async () => {
      const h = await make();
      const res = await h.api('POST', '/api/auth/login', {
        body: { username: 'admin', password: 'secret' },
      });
      expect(res.status).toBe(404);
    });

    it('logs in, refuses wrong credentials and validates the body', async () => {
      const h = await make({ localLogin });
      const ok = await h.api('POST', '/api/auth/login', {
        body: { username: 'admin', password: 'secret' },
      });
      expect(ok.status).toBe(200);
      expect(ok.json()).toEqual({ token: A, expiresAt: 4_102_444_800_000 + 12 * 3_600_000 });
      expectSecurityHeaders(ok);
      const wrong = await h.api('POST', '/api/auth/login', {
        body: { username: 'admin', password: 'nope' },
      });
      expect(wrong.status).toBe(401);
      expect(errorBody(wrong).error).toBe('unauthorized');
      for (const body of [
        {},
        { username: 'admin' },
        { username: '', password: 'x' },
        { username: 1, password: 2 },
      ]) {
        expect((await h.api('POST', '/api/auth/login', { body })).status).toBe(400);
      }
      expect((await h.api('POST', '/api/auth/login', { raw: 'nope' })).status).toBe(400);
    });

    it('allows 10 attempts per IP per 15 minutes, whatever their outcome', async () => {
      const h = await make({ localLogin });
      const attempt = (ip: string, password = 'wrong') =>
        h.api('POST', '/api/auth/login', { ip, body: { username: 'admin', password } });
      for (let i = 0; i < 10; i++) expect((await attempt('brute')).status).toBe(401);
      const blocked = await attempt('brute', 'secret'); // even the right password
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
      expect((await attempt('other-ip', 'secret')).status).toBe(200);
      h.clock.advance(900_000);
      expect((await attempt('brute', 'secret')).status).toBe(200);
    });
  });

  describe('quizzes', () => {
    it('creates, lists, reads, updates and deletes a quiz', async () => {
      const h = await make();
      h.clock.advance(1000);
      const created = await h.api('POST', '/api/quizzes', { token: A, body: allTypesQuiz() });
      expect(created.status).toBe(200);
      const quiz = created.json<Quiz>();
      expect(Quiz.safeParse(quiz).success).toBe(true);
      expect(quiz).toMatchObject({
        ownerId: h.hostIds.a,
        version: 1,
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
        title: 'All question types',
      });
      expect(quiz.questions).toHaveLength(6);

      const list = await h.api('GET', '/api/quizzes', { token: A });
      expect(list.json<QuizSummary[]>()).toEqual([
        {
          id: quiz.id,
          title: 'All question types',
          questionCount: 6,
          updatedAt: h.clock.now(),
          version: 1,
        },
      ]);
      expect((await h.api('GET', `/api/quizzes/${quiz.id}`, { token: A })).json()).toEqual(quiz);

      h.clock.advance(5000);
      const edited = { ...allTypesQuiz(), title: 'Renamed' };
      const put1 = await h.api('PUT', `/api/quizzes/${quiz.id}`, {
        token: A,
        body: { expectedVersion: 1, quiz: edited },
      });
      expect(put1.status).toBe(200);
      expect(put1.json<Quiz>()).toMatchObject({
        id: quiz.id,
        title: 'Renamed',
        version: 2,
        createdAt: quiz.createdAt,
        updatedAt: h.clock.now(),
        ownerId: h.hostIds.a,
      });
      const put2 = await h.api('PUT', `/api/quizzes/${quiz.id}`, {
        token: A,
        body: { expectedVersion: 2, quiz: edited },
      });
      expect(put2.json<Quiz>().version).toBe(3);

      // A stale editor loses.
      const stale = await h.api('PUT', `/api/quizzes/${quiz.id}`, {
        token: A,
        body: { expectedVersion: 1, quiz: { ...edited, title: 'Stale write' } },
      });
      expect(stale.status).toBe(409);
      expect(errorBody(stale).error).toBe('conflict');
      expect((await h.api('GET', `/api/quizzes/${quiz.id}`, { token: A })).json()).toMatchObject({
        title: 'Renamed',
        version: 3,
      });

      const del = await h.api('DELETE', `/api/quizzes/${quiz.id}`, { token: A });
      expect(del.status).toBe(204);
      expect(del.text).toBe('');
      expectSecurityHeaders(del);
      expect((await h.api('GET', `/api/quizzes/${quiz.id}`, { token: A })).status).toBe(404);
      expect((await h.api('DELETE', `/api/quizzes/${quiz.id}`, { token: A })).status).toBe(404);
      expect((await h.api('GET', '/api/quizzes', { token: A })).json()).toEqual([]);
    });

    it('reports a save that lost the race between read and write as a conflict', async () => {
      const h = await make();
      const quiz = await h.createQuiz(miniQuiz());
      h.overrides.putQuiz = async () => {
        throw new ConflictError();
      };
      const res = await h.api('PUT', `/api/quizzes/${quiz.id}`, {
        token: A,
        body: { expectedVersion: 1, quiz: miniQuiz() },
      });
      expect(res.status).toBe(409);
      h.overrides = {};
    });

    it('validates bodies and ids with 400', async () => {
      const h = await make();
      const quiz = await h.createQuiz(miniQuiz());
      const good = miniQuiz();
      const noCorrect = {
        ...good,
        questions: [{ ...good.questions[0]!, correctOptionId: 'opt-missing' }],
      };
      const bodies: unknown[] = [
        {},
        { ...good, title: '' },
        { ...good, title: 'x'.repeat(LIMITS.quizTitleMax + 1) },
        { ...good, questions: [] },
        noCorrect,
        { ...good, settings: { streakBonus: 'yes' } },
        'a string',
        null,
      ];
      for (const body of bodies) {
        const res = await h.api('POST', '/api/quizzes', { token: A, body });
        expect(res.status, JSON.stringify(body).slice(0, 60)).toBe(400);
        expect(errorBody(res).error).toBe('bad-request');
      }
      expect((await h.api('POST', '/api/quizzes', { token: A, raw: '{"title":' })).status).toBe(
        400,
      );
      for (const body of [
        {},
        { expectedVersion: 'one', quiz: good },
        { expectedVersion: 1 },
        { expectedVersion: 1, quiz: {} },
        { expectedVersion: -1, quiz: good },
      ]) {
        expect((await h.api('PUT', `/api/quizzes/${quiz.id}`, { token: A, body })).status).toBe(
          400,
        );
      }
      for (const path of [
        '/api/quizzes/a',
        '/api/quizzes/has space',
        `/api/quizzes/${'x'.repeat(40)}`,
      ]) {
        expect((await h.api('GET', path, { token: A })).status, path).toBe(400);
      }
      expect((await h.api('GET', `/api/quizzes/${quiz.id}`, { token: A })).json()).toMatchObject({
        version: 1,
      });
    });

    it('duplicates with a "Copy of" title, a new id and version 1', async () => {
      const h = await make();
      const quiz = await h.createQuiz(miniQuiz());
      await h.api('PUT', `/api/quizzes/${quiz.id}`, {
        token: A,
        body: { expectedVersion: 1, quiz: miniQuiz() },
      });
      h.clock.advance(9000);
      const res = await h.api('POST', `/api/quizzes/${quiz.id}/duplicate`, { token: A });
      expect(res.status).toBe(200);
      const copy = res.json<Quiz>();
      expect(Quiz.safeParse(copy).success).toBe(true);
      expect(copy).toMatchObject({
        title: 'Copy of Mini quiz',
        version: 1,
        ownerId: h.hostIds.a,
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      });
      expect(copy.id).not.toBe(quiz.id);
      expect(copy.questions).toEqual(quiz.questions);
      const list = (await h.api('GET', '/api/quizzes', { token: A })).json<QuizSummary[]>();
      expect(list.map((q) => q.title).sort()).toEqual(['Copy of Mini quiz', 'Mini quiz']);
    });

    it('truncates a long copied title to the limit without splitting a surrogate pair', async () => {
      const h = await make();
      const long = await h.createQuiz({ ...miniQuiz(), title: 'x'.repeat(LIMITS.quizTitleMax) });
      const copy = (
        await h.api('POST', `/api/quizzes/${long.id}/duplicate`, { token: A })
      ).json<Quiz>();
      expect(copy.title).toBe(`Copy of ${'x'.repeat(LIMITS.quizTitleMax - 8)}`);
      expect(copy.title).toHaveLength(LIMITS.quizTitleMax);

      // "Copy of " + 111 x + two emoji: the limit falls between the halves of the first emoji.
      const emoji = await h.createQuiz({
        ...miniQuiz(),
        title: `${'x'.repeat(111)}\u{1F600}\u{1F600}`,
      });
      const cut = (
        await h.api('POST', `/api/quizzes/${emoji.id}/duplicate`, { token: A })
      ).json<Quiz>();
      expect(cut.title).toBe(`Copy of ${'x'.repeat(111)}`);
      expect(cut.title.length).toBeLessThanOrEqual(LIMITS.quizTitleMax);
      expect(Quiz.safeParse(cut).success).toBe(true);
    });

    it('keeps other hosts out: their quizzes are 404, never 403', async () => {
      const h = await make();
      const mine = await h.createQuiz(miniQuiz(), 'a');
      const theirs = await h.createQuiz({ ...miniQuiz(), title: 'Theirs' }, 'b');
      expect(
        (await h.api('GET', '/api/quizzes', { token: B }))
          .json<QuizSummary[]>()
          .map((q) => q.title),
      ).toEqual(['Theirs']);
      const attempts: Array<[string, string, unknown?]> = [
        ['GET', `/api/quizzes/${mine.id}`],
        ['PUT', `/api/quizzes/${mine.id}`, { expectedVersion: 1, quiz: miniQuiz() }],
        ['DELETE', `/api/quizzes/${mine.id}`],
        ['POST', `/api/quizzes/${mine.id}/duplicate`],
        ['POST', '/api/sessions', { quizId: mine.id }],
      ];
      for (const [method, path, body] of attempts) {
        const res = await h.api(method, path, {
          token: B,
          ...(body !== undefined ? { body } : {}),
        });
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(errorBody(res).error).toBe('not-found');
      }
      // The same answer as for an id that never existed.
      expect((await h.api('GET', '/api/quizzes/never-existed', { token: B })).status).toBe(404);
      expect((await h.api('GET', `/api/quizzes/${mine.id}`, { token: A })).json()).toMatchObject({
        version: 1,
      });
      expect((await h.api('GET', `/api/quizzes/${theirs.id}`, { token: A })).status).toBe(404);
    });
  });

  describe('sessions', () => {
    it('creates a session with a PIN, lists sessions, and warms up', async () => {
      let warmed = 0;
      const h = await make({
        warmer: {
          async warm() {
            warmed++;
          },
        },
      });
      const quiz = await h.createQuiz(miniQuiz());
      const res = await h.api('POST', '/api/sessions', { token: A, body: { quizId: quiz.id } });
      expect(res.status).toBe(200);
      const { sessionId, pin } = res.json<{ sessionId: string; pin: string }>();
      expect(pin).toMatch(/^[1-9][0-9]{5}$/);
      expect(warmed).toBe(1);
      expect(await h.store.getSessionIdByPin(pin)).toBe(sessionId);
      expect(await h.store.getSession(sessionId)).toMatchObject({
        hostId: h.hostIds.a,
        quizId: quiz.id,
        phase: 'lobby',
        version: 1,
        expiresAt: h.clock.now() + 30 * 24 * 3600 * 1000,
      });
      expect((await h.store.getSnapshot(sessionId))!.questions).toHaveLength(3);

      h.clock.advance(1000);
      const second = (
        await h.api('POST', '/api/sessions', { token: A, body: { quizId: quiz.id } })
      ).json<{ sessionId: string }>();
      const list = await h.api('GET', '/api/sessions', { token: A });
      const sessions = list.json<SessionSummary[]>();
      expect(sessions.map((s) => s.sessionId)).toEqual([second.sessionId, sessionId]);
      expect(sessions[1]).toMatchObject({
        pin,
        quizId: quiz.id,
        quizTitle: 'Mini quiz',
        phase: 'lobby',
      });
      expect((await h.api('GET', '/api/sessions', { token: B })).json()).toEqual([]);
    });

    it('returns 404 for a quiz that does not exist and validates the body', async () => {
      const h = await make();
      expect(
        (await h.api('POST', '/api/sessions', { token: A, body: { quizId: 'unknown-quiz' } }))
          .status,
      ).toBe(404);
      for (const body of [{}, { quizId: 5 }, { quizId: 'a' }]) {
        expect((await h.api('POST', '/api/sessions', { token: A, body })).status).toBe(400);
      }
    });

    it('sessions keep their own snapshot when the quiz is edited or deleted', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann'] });
      await h.api('PUT', `/api/quizzes/${g.quizId}`, {
        token: A,
        body: {
          expectedVersion: 1,
          quiz: { ...miniQuiz(), title: 'Changed', questions: miniQuiz().questions.slice(1) },
        },
      });
      expect((await h.api('DELETE', `/api/quizzes/${g.quizId}`, { token: A })).status).toBe(204);
      const { openAt } = await g.open({ phase: 'lobby', questionIndex: -1 });
      expect(h.transport.last(g.players.Ann!.connectionId, 'question')).toMatchObject({
        index: 0,
        total: 3,
        question: { type: 'single' },
      });
      await g.answer('Ann', 0, choice('opt-paris'), openAt + 100);
      await g.close(0);
      expect(h.transport.last(g.players.Ann!.connectionId, 'reveal').you.points).toBe(1000);
      const csv = await h.api('GET', `/api/sessions/${g.sessionId}/results.csv`, { token: A });
      expect(csv.status).toBe(200);
      expect(csv.text).toContain(',Capital of France?,Ann,');
    });

    it('tries another PIN when one is taken, and gives up with 503 after ten', async () => {
      const h = await make();
      const quiz = await h.createQuiz(miniQuiz());
      const first = (
        await h.api('POST', '/api/sessions', { token: A, body: { quizId: quiz.id } })
      ).json<{ pin: string }>();
      const offered: string[] = [];
      const queue = [first.pin, first.pin, first.pin, '654321'];
      h.ids.pin = () => {
        const pin = queue.shift() ?? first.pin;
        offered.push(pin);
        return pin;
      };
      const ok = await h.api('POST', '/api/sessions', { token: A, body: { quizId: quiz.id } });
      expect(ok.status).toBe(200);
      expect(ok.json()).toMatchObject({ pin: '654321' });
      expect(offered).toEqual([first.pin, first.pin, first.pin, '654321']);

      offered.length = 0;
      h.resetCalls();
      const full = await h.api('POST', '/api/sessions', { token: A, body: { quizId: quiz.id } });
      expect(full.status).toBe(503);
      expect(errorBody(full).error).toBe('unavailable');
      expect(full.headers.get('retry-after')).toBe('1');
      expect(offered).toHaveLength(10);
      expect(h.calls).not.toContain('createSession');
    });

    it('releases the PIN when the session cannot be written', async () => {
      const h = await make();
      const quiz = await h.createQuiz(miniQuiz());
      h.ids.pin = () => '246810';
      h.overrides.createSession = async () => {
        throw new Error('write failed');
      };
      const res = await h.api('POST', '/api/sessions', { token: A, body: { quizId: quiz.id } });
      expect(res.status).toBe(500);
      h.overrides = {};
      expect(await h.store.getSessionIdByPin('246810')).toBeNull();
    });

    it('does not wait more than 500 ms for the warm-up and never surfaces its failure', async () => {
      const hanging = await make({ warmer: { warm: () => new Promise(() => undefined) } });
      const quiz = await hanging.createQuiz(miniQuiz());
      const started = Date.now();
      const res = await hanging.api('POST', '/api/sessions', {
        token: A,
        body: { quizId: quiz.id },
      });
      const elapsed = Date.now() - started;
      expect(res.status).toBe(200);
      expect(elapsed).toBeGreaterThanOrEqual(450);
      expect(elapsed).toBeLessThan(2500);

      for (const warm of [
        async () => {
          throw new Error('invoke failed');
        },
        () => {
          throw new Error('thrown synchronously');
        },
      ]) {
        const failing = await make({ warmer: { warm } });
        const q = await failing.createQuiz(miniQuiz());
        const fast = Date.now();
        const ok = await failing.api('POST', '/api/sessions', { token: A, body: { quizId: q.id } });
        expect(ok.status).toBe(200);
        expect(Date.now() - fast).toBeLessThan(400);
        expect(failing.logger.entries.warn.some((w) => w.m === 'warm-up failed')).toBe(true);
      }
    });
  });

  describe('GET /api/sessions/:id/results.csv', () => {
    it('exports a session that has not started as a header-only CSV with the BOM', async () => {
      const h = await make();
      const g = await startGame(h);
      const res = await h.api('GET', `/api/sessions/${g.sessionId}/results.csv`, { token: A });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
      expect(res.headers.get('content-disposition')).toBe(
        `attachment; filename="zqhoot-${g.pin}-2100-01-01.csv"`,
      );
      expectSecurityHeaders(res);
      expect(res.text).toBe(
        '﻿question_no,question_type,question,nickname,player_id,answered,response,correct,points,streak_bonus,response_time_ms,moderation,final_score,final_rank\r\n',
      );
    });

    it('names the file after the day the session was created', async () => {
      const h = await make();
      h.clock.set(Date.UTC(2100, 5, 15, 23, 59, 59));
      const g = await startGame(h);
      h.clock.advance(3 * 3_600_000);
      const res = await h.api('GET', `/api/sessions/${g.sessionId}/results.csv`, { token: A });
      expect(res.headers.get('content-disposition')).toBe(
        `attachment; filename="zqhoot-${g.pin}-2100-06-15.csv"`,
      );
    });

    it('is only for the owner: other hosts and unknown ids get 404, bad ids 400', async () => {
      const h = await make();
      const g = await startGame(h);
      const foreign = await h.api('GET', `/api/sessions/${g.sessionId}/results.csv`, { token: B });
      expect(foreign.status).toBe(404);
      expect(errorBody(foreign).error).toBe('not-found');
      expect(
        (await h.api('GET', '/api/sessions/no-such-session/results.csv', { token: A })).status,
      ).toBe(404);
      expect((await h.api('GET', '/api/sessions/x/results.csv', { token: A })).status).toBe(400);
      // 404 for an expired session too: the export window is the session lifetime.
      const meta = (await h.store.getSession(g.sessionId))!;
      h.clock.set(meta.expiresAt + 2000);
      expect(
        (await h.api('GET', `/api/sessions/${g.sessionId}/results.csv`, { token: A })).status,
      ).toBe(404);
    });

    it('includes only revealed questions, with their responses', async () => {
      const h = await make();
      const g = await startGame(h, { players: ['Ann', 'Bob'] });
      const { openAt } = await g.open({ phase: 'lobby', questionIndex: -1 });
      await g.answer('Ann', 0, choice('opt-paris'), openAt + 100);
      await g.answer('Bob', 0, choice('opt-rome'), openAt + 200);
      // Still open: nothing is exported yet.
      let csv = await h.api('GET', `/api/sessions/${g.sessionId}/results.csv`, { token: A });
      expect(csv.text.trimEnd().split('\r\n')).toHaveLength(1);
      await g.close(0);
      csv = await h.api('GET', `/api/sessions/${g.sessionId}/results.csv`, { token: A });
      const rows = csv.text.trimEnd().split('\r\n');
      expect(rows).toHaveLength(3);
      expect(rows[1]).toBe(
        `1,single,Capital of France?,Ann,${g.players.Ann!.playerId},yes,Paris,yes,1000,0,100,,1000,1`,
      );
      expect(rows[2]).toBe(
        `1,single,Capital of France?,Bob,${g.players.Bob!.playerId},yes,Rome,no,0,0,200,,0,2`,
      );
    });

    it('escapes commas and formula prefixes in nicknames and answers', async () => {
      const h = await make();
      const g = await startGame(h, {
        quiz: { ...miniQuiz(), questions: [miniQuiz().questions[2]!] },
        players: ['Ann'],
      });
      const { openAt } = await g.open({ phase: 'lobby', questionIndex: -1 });
      await g.answer('Ann', 0, text('=SUM(A1), "quoted"'), openAt + 100);
      await g.close(0);
      const csv = await h.api('GET', `/api/sessions/${g.sessionId}/results.csv`, { token: A });
      // Word cloud entries are normalised (lower case, trailing punctuation trimmed) before export.
      expect(csv.text).toContain(`,"'=sum(a1), ""quoted",`);
    });
  });

  describe('media', () => {
    const png = { contentType: 'image/png', size: 2048 };

    it('creates an upload grant for the host', async () => {
      const h = await make();
      const res = await h.api('POST', '/api/media/uploads', { token: A, body: png });
      expect(res.status).toBe(200);
      const grant = res.json<UploadGrant>();
      expect(grant.key).toMatch(new RegExp(`^media/${h.hostIds.a}/m[a-z0-9]+-001\\.png$`));
      expect(grant.upload).toMatchObject({
        method: 'PUT',
        headers: { 'Content-Type': 'image/png' },
      });
      expect(grant.expiresAt).toBe(h.clock.now() + 300_000);
      expect(h.media.uploads).toEqual([
        {
          host: { hostId: h.hostIds.a, displayName: 'Host A' },
          contentType: 'image/png',
          size: 2048,
        },
      ]);
      expectSecurityHeaders(res);
    });

    it('rejects unsupported types and sizes before asking the storage', async () => {
      const h = await make();
      const bad: unknown[] = [
        { contentType: 'image/svg+xml', size: 100 },
        { contentType: 'text/html', size: 100 },
        { contentType: 'image/png', size: 0 },
        { contentType: 'image/png', size: LIMITS.imageMaxBytes + 1 },
        { contentType: 'image/png', size: 1.5 },
        { contentType: 'image/png' },
        {},
      ];
      for (const body of bad) {
        expect(
          (await h.api('POST', '/api/media/uploads', { token: A, body })).status,
          JSON.stringify(body),
        ).toBe(400);
      }
      expect(h.media.uploads).toEqual([]);
      const limit = await h.api('POST', '/api/media/uploads', {
        token: A,
        body: { contentType: 'image/webp', size: LIMITS.imageMaxBytes },
      });
      expect(limit.status).toBe(200);
    });

    async function grant(h: Harness): Promise<UploadGrant> {
      const res = await h.api('POST', '/api/media/uploads', { token: A, body: png });
      return res.json<UploadGrant>();
    }

    it('stores an upload authorised by the token in the query string, without a bearer token', async () => {
      const h = await make();
      const { key, upload } = await grant(h);
      const url = (upload as { url: string }).url;
      const res = await h.api('PUT', url, {
        raw: new Uint8Array(1234),
        headers: { 'content-type': 'image/png' },
      });
      expect(res.status).toBe(204);
      expect(res.text).toBe('');
      expectSecurityHeaders(res);
      expect(h.media.stored.get(key)).toEqual({ contentType: 'image/png', bytes: 1234 });
    });

    it('maps the storage refusals to 403, 415 and 400', async () => {
      const h = await make();
      const { key, upload } = await grant(h);
      const url = (upload as { url: string }).url;
      const body = new Uint8Array(10);
      const headers = { 'content-type': 'image/png' };
      const wrongToken = await h.api('PUT', `/api/media/${key}?t=forged`, { raw: body, headers });
      expect(wrongToken.status).toBe(403);
      expect(errorBody(wrongToken).error).toBe('forbidden');
      expect((await h.api('PUT', `/api/media/${key}`, { raw: body, headers })).status).toBe(403);
      expect((await h.api('PUT', `/api/media/${key}?t=`, { raw: body, headers })).status).toBe(403);
      const wrongType = await h.api('PUT', url, {
        raw: body,
        headers: { 'content-type': 'text/html' },
      });
      expect(wrongType.status).toBe(415);
      for (const path of [
        `/api/media/${key.replace('.png', '.svg')}?t=x`,
        '/api/media/..%2f..%2fetc%2fpasswd?t=x',
        '/api/media/media/a/b.png?t=x',
        '/api/media/?t=x',
      ]) {
        expect((await h.api('PUT', path, { raw: body, headers })).status, path).toBe(400);
      }
      expect((await h.api('PUT', url, { headers })).status).toBe(400);
      expect(h.media.stored.size).toBe(0);
    });

    it('limits the upload to 5 MB while streaming, with or without a content-length header', async () => {
      const h = await make();
      const { key, upload } = await grant(h);
      const url = (upload as { url: string }).url;
      const headers = { 'content-type': 'image/png' };

      const exact = await h.api('PUT', url, { raw: new Uint8Array(LIMITS.imageMaxBytes), headers });
      expect(exact.status).toBe(204);
      expect(h.media.stored.get(key)?.bytes).toBe(LIMITS.imageMaxBytes);
      h.media.stored.clear();

      // No content-length: the stream is counted and cut off.
      const streamed = await h.api('PUT', url, {
        raw: new Uint8Array(LIMITS.imageMaxBytes + 1),
        headers,
      });
      expect(streamed.status).toBe(413);
      expect(errorBody(streamed).error).toBe('payload-too-large');
      // A declared length over the limit is refused before the body is read.
      const declared = await h.api('PUT', url, {
        raw: new Uint8Array(16),
        headers: { ...headers, 'content-length': String(LIMITS.imageMaxBytes + 1) },
      });
      expect(declared.status).toBe(413);
      // A chunked body (unknown length) that grows past the limit.
      const chunks = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(1024 * 1024));
        },
      });
      const chunked = await h.api('PUT', url, { raw: chunks, headers });
      expect(chunked.status).toBe(413);
      expect(h.media.stored.size).toBe(0);
    });

    it('has no PUT route when the storage cannot accept bytes (S3 uploads go direct)', async () => {
      const h = await make({ mediaPut: false });
      const { upload } = await grant(h);
      expect(upload).toBeDefined();
      const res = await h.api('PUT', `/api/media/media/${h.hostIds.a}/abcdef.png?t=x`, {
        raw: new Uint8Array(4),
        headers: { 'content-type': 'image/png' },
      });
      expect(res.status).toBe(404);
    });
  });
});
