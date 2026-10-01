import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '@zqhoot/protocol';
import { API_RATE_BURST, API_RATE_PER_SECOND, IpRateLimiter } from '../src/ip-rate-limit.ts';
import { rawRequest } from './helpers/http.ts';
import { createWorkspace, startServer } from './helpers/server.ts';
import type { TestServer, Workspace } from './helpers/server.ts';

describe('IpRateLimiter', () => {
  const setup = (perSecond = 20, burst = 400) => {
    let now = 1_000_000;
    const limiter = new IpRateLimiter(perSecond, burst, { now: () => now });
    return {
      limiter,
      advance: (ms: number) => {
        now += ms;
      },
    };
  };

  it('is the ADR-0013 rate: 20 requests per second per IP', () => {
    expect(API_RATE_PER_SECOND).toBe(20);
    // Room for a class of 400 phones behind one NAT to look up a PIN within seconds.
    expect(API_RATE_BURST).toBeGreaterThanOrEqual(400);
  });

  it('allows the burst, then refills at the steady rate', () => {
    const { limiter, advance } = setup(20, 400);
    for (let i = 0; i < 400; i++) expect(limiter.allow('192.0.2.1'), `request ${i}`).toBe(true);
    expect(limiter.allow('192.0.2.1')).toBe(false);
    advance(49);
    expect(limiter.allow('192.0.2.1')).toBe(false);
    advance(1);
    expect(limiter.allow('192.0.2.1')).toBe(true);
    expect(limiter.allow('192.0.2.1')).toBe(false);
  });

  it('keeps one budget per address', () => {
    const { limiter } = setup(1, 2);
    expect(limiter.allow('192.0.2.1')).toBe(true);
    expect(limiter.allow('192.0.2.1')).toBe(true);
    expect(limiter.allow('192.0.2.1')).toBe(false);
    expect(limiter.allow('192.0.2.2')).toBe(true);
    expect(limiter.allow('2001:db8::1')).toBe(true);
  });

  it('does not limit a request without an address', () => {
    const { limiter } = setup(1, 1);
    for (let i = 0; i < 10; i++) expect(limiter.allow(undefined)).toBe(true);
    expect(limiter.size).toBe(0);
  });

  it('forgets addresses that have been idle long enough to be full again', () => {
    const { limiter, advance } = setup(20, 400);
    for (let i = 0; i < 50; i++) limiter.allow(`198.51.100.${i}`);
    expect(limiter.size).toBe(50);
    // A full refill takes 20 s; the sweep runs on the next request after that.
    advance(20_000);
    limiter.allow('203.0.113.1');
    expect(limiter.size).toBe(1);
  });

  it('keeps an address that has not been idle for a full refill', () => {
    const { limiter, advance } = setup(1, 10);
    limiter.allow('192.0.2.1');
    advance(5_000);
    limiter.allow('192.0.2.2');
    advance(5_000);
    // The sweep at 10 s drops .1 (idle 10 s) and keeps .2 (idle 5 s).
    limiter.allow('192.0.2.3');
    expect(limiter.size).toBe(2);
  });
});

describe('HTTP API limit', () => {
  let workspace: Workspace;
  let server: TestServer;
  let now: number;

  beforeAll(async () => {
    workspace = await createWorkspace();
    now = Date.now();
    // Behind a trusted proxy the address comes from X-Forwarded-For, which lets one test play many clients.
    server = await startServer(workspace, {
      env: { ZQ_TRUST_PROXY: 'true' },
      clock: { now: () => now },
    });
  });

  afterAll(async () => {
    await server.close();
    await workspace.cleanup();
  });

  const health = (ip: string) =>
    rawRequest(server, 'GET', '/api/health', { headers: { 'X-Forwarded-For': ip } });

  it('answers 429 with Retry-After once one address has used up its bucket', async () => {
    const ip = '203.0.113.50';
    for (let batch = 0; batch < API_RATE_BURST; batch += 50) {
      const statuses = await Promise.all(Array.from({ length: 50 }, () => health(ip))).then((rs) =>
        rs.map((r) => r.status),
      );
      expect(new Set(statuses)).toEqual(new Set([200]));
    }

    const refused = await health(ip);
    expect(refused.status).toBe(429);
    expect(refused.headers['retry-after']).toBe('1');
    expect(refused.headers['cache-control']).toBe('no-store');
    expect(refused.headers['content-type']).toBe('application/json');
    expect(ApiError.parse(JSON.parse(refused.text))).toMatchObject({ error: 'rate-limited' });

    // Another client behind the same proxy is not affected.
    expect((await health('203.0.113.51')).status).toBe(200);

    // Static files, config.json and media are not part of the HTTP API.
    expect(
      (await rawRequest(server, 'GET', '/config.json', { headers: forwarded(ip) })).status,
    ).toBe(200);
    expect((await rawRequest(server, 'GET', '/', { headers: forwarded(ip) })).status).toBe(200);

    // The bucket refills at 20 requests per second.
    now += 1000;
    for (let i = 0; i < API_RATE_PER_SECOND; i++) expect((await health(ip)).status).toBe(200);
    expect((await health(ip)).status).toBe(429);
  });

  it('counts a bare /api and a POST alike', async () => {
    const ip = '203.0.113.60';
    for (let batch = 0; batch < API_RATE_BURST; batch += 50) {
      await Promise.all(Array.from({ length: 50 }, () => health(ip)));
    }
    const post = await rawRequest(server, 'POST', '/api/auth/login', {
      headers: { ...forwarded(ip), 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'wrong' }),
    });
    expect(post.status).toBe(429);
    expect((await rawRequest(server, 'GET', '/api', { headers: forwarded(ip) })).status).toBe(429);
  });
});

const forwarded = (ip: string): Record<string, string> => ({ 'X-Forwarded-For': ip });
