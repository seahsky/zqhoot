import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DDB_ENDPOINT,
  createDocClient,
  createTable,
  dropTable,
  uniqueTableName,
} from './support/dynamo.ts';

type Handler = (
  event: APIGatewayProxyEventV2,
  context: Context,
) => Promise<APIGatewayProxyStructuredResultV2>;

const client = createDocClient();
const tableName = uniqueTableName('http');

beforeAll(() => createTable(client, tableName));
afterAll(async () => {
  await dropTable(client, tableName);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** The environment Terraform gives the http function, pointed at DynamoDB Local. */
function stubHttpEnv(extra: Record<string, string> = {}): void {
  const env: Record<string, string> = {
    ZQ_TARGET: 'aws',
    ZQ_TABLE_NAME: tableName,
    ZQ_SITE_ORIGIN: 'https://quiz.example.com',
    ZQ_COGNITO_USER_POOL_ID: 'us-east-1_TestPool1',
    ZQ_COGNITO_CLIENT_ID: 'client-abc',
    ZQ_SESSION_TTL_DAYS: '30',
    ZQ_MEDIA_BUCKET: 'zqhoot-media',
    ZQ_WS_FUNCTION_NAME: 'zqhoot-ws',
    ZQ_WARM_CONCURRENCY: '0',
    ZQ_LOG_LEVEL: 'error',
    ZQ_DDB_ENDPOINT: DDB_ENDPOINT,
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'local',
    AWS_SECRET_ACCESS_KEY: 'local',
    ...extra,
  };
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  vi.stubEnv('AWS_SESSION_TOKEN', undefined);
}

async function loadHandler(): Promise<Handler> {
  return (await import('../src/http.ts')).handler as unknown as Handler;
}

const context = { awsRequestId: 'req-1', functionName: 'zqhoot-http' } as Context;

/** An API Gateway HTTP API payload v2 event. */
function v2Event(
  method: string,
  path: string,
  opts: { sourceIp?: string; headers?: Record<string, string>; body?: unknown } = {},
): APIGatewayProxyEventV2 {
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: '',
    headers: {
      host: 'abc123.execute-api.us-east-1.amazonaws.com',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...opts.headers,
    },
    requestContext: {
      accountId: '123456789012',
      apiId: 'abc123',
      domainName: 'abc123.execute-api.us-east-1.amazonaws.com',
      domainPrefix: 'abc123',
      http: {
        method,
        path,
        protocol: 'HTTP/1.1',
        sourceIp: opts.sourceIp ?? '203.0.113.5',
        userAgent: 'vitest',
      },
      requestId: 'r-1',
      routeKey: '$default',
      stage: '$default',
      time: '29/Sep/2026:06:00:00 +0000',
      timeEpoch: Date.now(),
    },
    ...(body !== undefined ? { body } : {}),
    isBase64Encoded: false,
  };
}

const json = (result: APIGatewayProxyStructuredResultV2): unknown =>
  JSON.parse(result.body ?? 'null');

describe('http handler', () => {
  it('routes a v2 event to /api/health', async () => {
    stubHttpEnv();
    const handler = await loadHandler();
    const result = await handler(v2Event('GET', '/api/health'), context);
    expect(result.statusCode).toBe(200);
    expect(json(result)).toEqual({ ok: true, version: 'dev', target: 'aws' });
    expect(result.headers).toMatchObject({
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
  });

  it('answers unknown routes with the ApiError body', async () => {
    stubHttpEnv();
    const handler = await loadHandler();
    const result = await handler(v2Event('GET', '/api/nope'), context);
    expect(result.statusCode).toBe(404);
    expect(json(result)).toEqual({ error: 'not-found', message: 'not found' });
  });

  it('keeps host routes behind the Cognito bearer check', async () => {
    stubHttpEnv();
    const handler = await loadHandler();
    const result = await handler(v2Event('GET', '/api/quizzes'), context);
    expect(result.statusCode).toBe(401);
    const forged = await handler(
      v2Event('GET', '/api/me', { headers: { authorization: 'Bearer a.b.c' } }),
      context,
    );
    expect(forged.statusCode).toBe(401);
  });

  it('has no local login route on AWS', async () => {
    stubHttpEnv();
    const handler = await loadHandler();
    const result = await handler(
      v2Event('POST', '/api/auth/login', { body: { username: 'a', password: 'b' } }),
      context,
    );
    expect(result.statusCode).toBe(404);
  });

  it("rate limits by the API Gateway event's sourceIp", async () => {
    stubHttpEnv();
    const handler = await loadHandler();
    const lookup = (sourceIp: string) =>
      handler(v2Event('GET', '/api/join/123456', { sourceIp }), context);

    // The limit counts in fixed one-minute windows, so start just after a boundary: a boundary
    // crossed halfway through would reset the count and hide the 429.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Math.floor(Date.now() / 60_000) * 60_000 + 1000);
    try {
      // Failed lookups are limited to 30 a minute per IP (ADR-0013).
      const statuses: number[] = [];
      for (let i = 0; i < 31; i++) statuses.push((await lookup('198.51.100.20')).statusCode ?? 0);
      expect(statuses.slice(0, 30).every((s) => s === 404)).toBe(true);
      expect(statuses[30]).toBe(429);

      // Another address is unaffected: the count is keyed on requestContext.http.sourceIp.
      expect((await lookup('192.0.2.77')).statusCode).toBe(404);
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs in through the emulator-only local login', async () => {
    stubHttpEnv({ ZQ_AUTH_MODE: 'local', ZQ_EMULATOR: '1' });
    // A developer's shell may carry Lambda variables; the switch only needs them absent here.
    vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', undefined);
    const handler = await loadHandler();

    const login = await handler(
      v2Event('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin' } }),
      context,
    );
    expect(login.statusCode).toBe(200);
    const { token } = json(login) as { token: string };

    const me = await handler(
      v2Event('GET', '/api/me', { headers: { authorization: `Bearer ${token}` } }),
      context,
    );
    expect(json(me)).toEqual({ hostId: 'local:admin', displayName: 'admin' });

    const bad = await handler(
      v2Event('POST', '/api/auth/login', { body: { username: 'admin', password: 'wrong' } }),
      context,
    );
    expect(bad.statusCode).toBe(401);
  });

  it('refuses to start with local auth inside Lambda, even with the emulator flag', async () => {
    stubHttpEnv({
      ZQ_AUTH_MODE: 'local',
      ZQ_EMULATOR: '1',
      AWS_LAMBDA_FUNCTION_NAME: 'zqhoot-http',
    });
    await expect(loadHandler()).rejects.toThrow(/only available in the local emulator/);
  });

  it('refuses to start with local auth and no emulator flag', async () => {
    stubHttpEnv({ ZQ_AUTH_MODE: 'local' });
    vi.stubEnv('ZQ_EMULATOR', undefined);
    await expect(loadHandler()).rejects.toThrow(/only available in the local emulator/);
  });

  it('fails cold start with a readable message when the environment is incomplete', async () => {
    stubHttpEnv();
    vi.stubEnv('ZQ_MEDIA_BUCKET', undefined);
    await expect(loadHandler()).rejects.toThrow(/ZQ_MEDIA_BUCKET/);
  });
});
