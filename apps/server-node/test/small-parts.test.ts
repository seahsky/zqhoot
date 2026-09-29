import { describe, expect, it } from 'vitest';
import { Id, LIMITS } from '@zqhoot/protocol';
import { clientIp } from '../src/client-ip.ts';
import { createLogger } from '../src/logger.ts';
import { createIds } from '../src/ports/ids.ts';
import { rawPath } from '../src/request-path.ts';
import { TokenBucket } from '../src/token-bucket.ts';
import type { IncomingMessage } from 'node:http';

describe('TokenBucket', () => {
  it('allows the burst, then refills at the steady rate', () => {
    const bucket = new TokenBucket(10, 20, 0);
    for (let i = 0; i < 20; i++) expect(bucket.take(0), `token ${i}`).toBe(true);
    expect(bucket.take(0)).toBe(false);
    expect(bucket.take(99)).toBe(false);
    expect(bucket.take(100)).toBe(true);
    expect(bucket.take(100)).toBe(false);
    expect(bucket.take(1100)).toBe(true);
  });

  it('never holds more than the burst, however long it was idle', () => {
    const bucket = new TokenBucket(10, 20, 0);
    let taken = 0;
    while (bucket.take(3_600_000)) taken++;
    expect(taken).toBe(20);
  });

  it('sustains 10 messages per second', () => {
    const bucket = new TokenBucket(10, 20, 0);
    for (let t = 0; t < 60_000; t += 100) expect(bucket.take(t)).toBe(true);
  });

  it('survives a clock that steps backwards', () => {
    const bucket = new TokenBucket(10, 20, 1000);
    for (let i = 0; i < 20; i++) bucket.take(1000);
    expect(bucket.take(500)).toBe(false);
  });
});

describe('createIds', () => {
  const ids = createIds();

  it('makes protocol-valid ids, unique in practice', () => {
    const made = new Set<string>();
    for (const make of [ids.sessionId, ids.playerId, ids.quizId, ids.mediaId]) {
      for (let i = 0; i < 200; i++) {
        const id = make();
        expect(Id.safeParse(id).success).toBe(true);
        made.add(id);
      }
    }
    expect(made.size).toBe(800);
  });

  it('makes 256-bit base64url tokens', () => {
    const token = ids.token();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(ids.token()).not.toBe(token);
  });

  it('makes six-digit PINs that never start with 0', () => {
    const firstDigits = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const pin = ids.pin();
      expect(pin).toMatch(new RegExp(`^[1-9][0-9]{${LIMITS.pinLength - 1}}$`));
      firstDigits.add(pin[0] ?? '');
    }
    expect(firstDigits.size).toBe(9);
  });
});

describe('clientIp', () => {
  const req = (headers: Record<string, string>, remote = '10.0.0.9'): IncomingMessage =>
    ({ headers, socket: { remoteAddress: remote } }) as unknown as IncomingMessage;

  it('ignores X-Forwarded-For unless the proxy is trusted', () => {
    expect(clientIp(req({ 'x-forwarded-for': '203.0.113.7' }), false)).toBe('10.0.0.9');
  });

  it('takes the first hop when the proxy is trusted', () => {
    expect(clientIp(req({ 'x-forwarded-for': '203.0.113.7, 10.1.1.1' }), true)).toBe('203.0.113.7');
    expect(clientIp(req({ 'x-forwarded-for': '2001:db8::1' }), true)).toBe('2001:db8::1');
  });

  it('falls back to the socket address for a missing or malformed header', () => {
    expect(clientIp(req({}), true)).toBe('10.0.0.9');
    expect(clientIp(req({ 'x-forwarded-for': 'not an ip' }), true)).toBe('10.0.0.9');
    expect(clientIp(req({ 'x-forwarded-for': '' }), true)).toBe('10.0.0.9');
  });

  it('strips the IPv4-mapped prefix', () => {
    expect(clientIp(req({}, '::ffff:192.0.2.5'), false)).toBe('192.0.2.5');
  });
});

describe('rawPath', () => {
  it('cuts the query and fragment and keeps percent-escapes', () => {
    expect(rawPath('/a/b?x=1')).toBe('/a/b');
    expect(rawPath('/a%2Fb#frag')).toBe('/a%2Fb');
    expect(rawPath('/')).toBe('/');
  });

  it('refuses anything that is not origin-form', () => {
    expect(rawPath('http://x/y')).toBeNull();
    expect(rawPath('*')).toBeNull();
    expect(rawPath('')).toBeNull();
    expect(rawPath(undefined)).toBeNull();
  });
});

describe('createLogger', () => {
  const collect = (level: Parameters<typeof createLogger>[0]) => {
    const lines: Array<{ level: string; line: string }> = [];
    return { lines, log: createLogger(level, (l, line) => lines.push({ level: l, line })) };
  };

  it('writes one JSON object per line and filters by level', () => {
    const { lines, log } = collect('info');
    log.debug({ a: 1 }, 'hidden');
    log.info({ a: 1 }, 'shown');
    log.error({ b: 2 }, 'bad');
    expect(lines.map((l) => l.level)).toEqual(['info', 'error']);
    expect(JSON.parse(lines[0]?.line ?? '')).toMatchObject({ level: 'info', msg: 'shown', a: 1 });
    expect(Object.keys(JSON.parse(lines[0]?.line ?? '{}')).slice(0, 3)).toEqual([
      'level',
      'time',
      'msg',
    ]);
  });

  it('lets the core fields win over keys in the logged object', () => {
    const { lines, log } = collect('debug');
    log.warn({ level: 'debug', msg: 'spoofed' }, 'real');
    expect(JSON.parse(lines[0]?.line ?? '')).toMatchObject({ level: 'warn', msg: 'real' });
  });

  it('logs nothing at silent and survives circular objects', () => {
    const silent = collect('silent');
    silent.log.error({}, 'x');
    expect(silent.lines).toEqual([]);
    const { lines, log } = collect('info');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    log.info(circular, 'loop');
    expect(JSON.parse(lines[0]?.line ?? '')).toMatchObject({
      msg: 'loop',
      logError: 'unserialisable',
    });
  });
});
