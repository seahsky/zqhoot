import { describe, expect, it } from 'vitest';
import {
  CreateSessionResponse,
  EpochMs,
  ErrorCode,
  Id,
  LIMITS,
  MediaKey,
  Phase,
  Pin,
  PinLookupResponse,
  RuntimeConfig,
  SessionSummary,
  UploadGrant,
  UploadRequest,
} from '../src/index.ts';

const ok = (schema: { safeParse(v: unknown): { success: boolean } }, v: unknown) =>
  schema.safeParse(v).success;

describe('Pin', () => {
  it.each([
    ['123456', true],
    ['000000', true],
    ['12345', false],
    ['1234567', false],
    ['12345a', false],
    ['12 456', false],
    ['', false],
    [123456, false],
  ])('%j -> %s', (v, valid) => {
    expect(ok(Pin, v)).toBe(valid);
  });
});

describe('Id', () => {
  it.each([
    ['abcdef', true],
    ['abcde', false],
    ['a'.repeat(32), true],
    ['a'.repeat(33), false],
    ['V1StGXR8_Z5jdHi6B-myT', true],
    ['has space', false],
    ['emoji-\u{1F600}', false],
    ['dot.dot1', false],
  ])('%j -> %s', (v, valid) => {
    expect(ok(Id, v)).toBe(valid);
  });
});

describe('EpochMs', () => {
  it.each([
    [0, true],
    [1_700_000_000_000, true],
    [-1, false],
    [1.5, false],
    ['1', false],
    [Number.NaN, false],
    [Number.POSITIVE_INFINITY, false],
  ])('%j -> %s', (v, valid) => {
    expect(ok(EpochMs, v)).toBe(valid);
  });
});

describe('MediaKey', () => {
  it('accepts only the four raster formats under media/<owner>/', () => {
    for (const ext of ['png', 'jpg', 'webp', 'gif']) {
      expect(ok(MediaKey, `media/owner_1/abcdef.${ext}`)).toBe(true);
    }
    for (const bad of ['jpeg', 'svg', 'html', 'png.exe', '']) {
      expect(ok(MediaKey, `media/owner_1/abcdef.${bad}`), bad).toBe(false);
    }
    expect(ok(MediaKey, 'media/owner_1/abcdef')).toBe(false);
    expect(ok(MediaKey, '/media/owner_1/abcdef.png')).toBe(false);
    expect(ok(MediaKey, 'media/a/b/abcdef.png')).toBe(false);
    expect(ok(MediaKey, `media/${'o'.repeat(64)}/${'a'.repeat(32)}.png`)).toBe(true);
    expect(ok(MediaKey, `media/${'o'.repeat(65)}/abcdef.png`)).toBe(false);
    expect(ok(MediaKey, `media/owner_1/${'a'.repeat(33)}.png`)).toBe(false);
  });
});

describe('enums', () => {
  it('Phase lists the six session phases', () => {
    expect(Phase.options).toEqual([
      'lobby',
      'question',
      'revealing',
      'reveal',
      'leaderboard',
      'ended',
    ]);
  });

  it('ErrorCode covers the codes the service maps engine and auth failures to', () => {
    for (const code of [
      'session-ended',
      'session-locked',
      'session-full',
      'nickname-invalid',
      'nickname-taken',
    ]) {
      expect(ok(ErrorCode, code)).toBe(true);
    }
    expect(ok(ErrorCode, 'nope')).toBe(false);
  });
});

describe('HTTP bodies', () => {
  it('UploadRequest: image types and 1 byte to 5 MiB', () => {
    expect(ok(UploadRequest, { contentType: 'image/png', size: 1 })).toBe(true);
    expect(ok(UploadRequest, { contentType: 'image/webp', size: LIMITS.imageMaxBytes })).toBe(true);
    expect(ok(UploadRequest, { contentType: 'image/png', size: LIMITS.imageMaxBytes + 1 })).toBe(
      false,
    );
    expect(ok(UploadRequest, { contentType: 'image/png', size: 0 })).toBe(false);
    expect(ok(UploadRequest, { contentType: 'image/svg+xml', size: 10 })).toBe(false);
  });

  it('UploadGrant: presigned POST or direct PUT', () => {
    const key = 'media/owner_1/abcdef.png';
    expect(
      ok(UploadGrant, {
        key,
        upload: { method: 'POST', url: 'https://s3.example.com/b', fields: { k: 'v' } },
        expiresAt: 5,
      }),
    ).toBe(true);
    expect(
      ok(UploadGrant, {
        key,
        upload: { method: 'PUT', url: '/api/media/x', headers: {} },
        expiresAt: 5,
      }),
    ).toBe(true);
    expect(
      ok(UploadGrant, {
        key,
        upload: { method: 'POST', url: 'not a url', fields: {} },
        expiresAt: 5,
      }),
    ).toBe(false);
    expect(
      ok(UploadGrant, { key, upload: { method: 'GET', url: 'https://x.example' }, expiresAt: 5 }),
    ).toBe(false);
  });

  it('session bodies', () => {
    expect(ok(CreateSessionResponse, { sessionId: 'sess-0001', pin: '123456' })).toBe(true);
    expect(ok(CreateSessionResponse, { sessionId: 'sess-0001', pin: '12' })).toBe(false);
    expect(
      ok(PinLookupResponse, {
        sessionId: 'sess-0001',
        quizTitle: 'Q',
        joinable: false,
        reason: 'locked',
      }),
    ).toBe(true);
    expect(
      ok(PinLookupResponse, {
        sessionId: 'sess-0001',
        quizTitle: 'Q',
        joinable: false,
        reason: 'expired',
      }),
    ).toBe(false);
    expect(
      ok(SessionSummary, {
        sessionId: 'sess-0001',
        pin: '123456',
        quizId: 'quiz-0001',
        quizTitle: 'Q',
        phase: 'lobby',
        createdAt: 1,
        expiresAt: 2,
      }),
    ).toBe(true);
  });

  it('RuntimeConfig: local and cognito auth', () => {
    const base = {
      target: 'vm',
      apiBaseUrl: '',
      wsUrl: 'wss://x.example/ws',
      mediaBaseUrl: '/',
      joinUrl: 'https://x.example/join',
    };
    expect(ok(RuntimeConfig, { ...base, auth: { mode: 'local' } })).toBe(true);
    expect(
      ok(RuntimeConfig, {
        ...base,
        target: 'aws',
        auth: {
          mode: 'cognito',
          region: 'us-east-1',
          userPoolId: 'p',
          clientId: 'c',
          domain: 'https://d.auth.us-east-1.amazoncognito.com',
        },
      }),
    ).toBe(true);
    expect(ok(RuntimeConfig, { ...base, auth: { mode: 'cognito', region: 'us-east-1' } })).toBe(
      false,
    );
    expect(ok(RuntimeConfig, { ...base, target: 'k8s', auth: { mode: 'local' } })).toBe(false);
  });
});
