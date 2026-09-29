import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEV_JWT_SECRET,
  HTTP_ENV_NAMES,
  WS_ENV_NAMES,
  loadHttpConfig,
  loadWsConfig,
  localAuthAllowed,
} from '../src/config.ts';
import type { Env } from '../src/config.ts';

const sharedEnv: Env = {
  ZQ_TARGET: 'aws',
  ZQ_TABLE_NAME: 'zqhoot-table',
  ZQ_SITE_ORIGIN: 'https://d111111abcdef8.cloudfront.net',
  ZQ_COGNITO_USER_POOL_ID: 'us-east-1_Abc123',
  ZQ_COGNITO_CLIENT_ID: 'client123',
  ZQ_SESSION_TTL_DAYS: '30',
  ZQ_LOG_LEVEL: 'info',
};
const wsEnv: Env = {
  ...sharedEnv,
  ZQ_WS_CALLBACK_URL: 'https://abc.execute-api.us-east-1.amazonaws.com/prod',
};
const httpEnv: Env = {
  ...sharedEnv,
  ZQ_MEDIA_BUCKET: 'zqhoot-media',
  ZQ_WS_FUNCTION_NAME: 'zqhoot-ws',
  ZQ_WARM_CONCURRENCY: '4',
};

describe('environment contract (docs/tasks/W1-infra.md)', () => {
  const doc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../../docs/tasks/W1-infra.md'),
    'utf8',
  );
  const section = doc.slice(doc.indexOf('## Lambda environment contract'));
  const rows = [...section.matchAll(/^\|\s*`([A-Z_]+)`\s*\|\s*(✓?)\s*\|\s*(✓?)\s*\|/gm)].map(
    (m) => ({ name: m[1] as string, ws: m[2] === '✓', http: m[3] === '✓' }),
  );

  // Optional and never set by Terraform: local endpoints, and the emulator's local auth.
  const extras = [
    'ZQ_DDB_ENDPOINT',
    'ZQ_LAMBDA_ENDPOINT',
    'ZQ_AUTH_MODE',
    'ZQ_ADMIN_USER',
    'ZQ_ADMIN_PASSWORD',
    'ZQ_ADMIN_PASSWORD_HASH',
    'ZQ_JWT_SECRET',
  ];

  it('finds the whole table in the doc', () => {
    expect(rows.map((r) => r.name)).toEqual([
      'ZQ_TARGET',
      'ZQ_TABLE_NAME',
      'ZQ_SITE_ORIGIN',
      'ZQ_COGNITO_USER_POOL_ID',
      'ZQ_COGNITO_CLIENT_ID',
      'ZQ_SESSION_TTL_DAYS',
      'ZQ_WS_CALLBACK_URL',
      'ZQ_MEDIA_BUCKET',
      'ZQ_WS_FUNCTION_NAME',
      'ZQ_WARM_CONCURRENCY',
      'ZQ_LOG_LEVEL',
      'NODE_OPTIONS',
    ]);
  });

  it.each([
    ['ws', WS_ENV_NAMES, 'ws' as const],
    ['http', HTTP_ENV_NAMES, 'http' as const],
  ])('%s function reads every variable the contract gives it and no others', (_, names, column) => {
    const contract = rows.filter((r) => r[column]).map((r) => r.name);
    // NODE_OPTIONS belongs to the Node runtime, not to us.
    for (const name of contract.filter((n) => n !== 'NODE_OPTIONS')) {
      expect(names, `${name} is in the contract but not read`).toContain(name);
    }
    for (const name of names) {
      expect(
        contract.includes(name) || extras.includes(name),
        `${name} is read but is neither in the contract nor an optional extra`,
      ).toBe(true);
    }
  });

  it('loads a config from exactly the contract variables', () => {
    const pick = (column: 'ws' | 'http', env: Env): Env =>
      Object.fromEntries(rows.filter((r) => r[column]).map((r) => [r.name, env[r.name]]));
    expect(() => loadWsConfig(pick('ws', wsEnv))).not.toThrow();
    expect(() => loadHttpConfig(pick('http', httpEnv))).not.toThrow();
  });
});

describe('loadWsConfig', () => {
  it('maps the contract variables', () => {
    expect(loadWsConfig(wsEnv)).toEqual({
      tableName: 'zqhoot-table',
      ddbEndpoint: undefined,
      siteOrigin: 'https://d111111abcdef8.cloudfront.net',
      sessionTtlMs: 30 * 86_400_000,
      logLevel: 'info',
      auth: { mode: 'cognito', userPoolId: 'us-east-1_Abc123', clientId: 'client123' },
      wsCallbackUrl: 'https://abc.execute-api.us-east-1.amazonaws.com/prod',
    });
  });

  it('accepts a local DynamoDB endpoint and callback URL', () => {
    const cfg = loadWsConfig({
      ...wsEnv,
      ZQ_DDB_ENDPOINT: 'http://localhost:8000',
      ZQ_WS_CALLBACK_URL: 'http://localhost:3002/emu',
    });
    expect(cfg.ddbEndpoint).toBe('http://localhost:8000');
    expect(cfg.wsCallbackUrl).toBe('http://localhost:3002/emu');
  });

  it('names every problem at once', () => {
    let error: unknown;
    try {
      loadWsConfig({ ZQ_TARGET: 'gcp', ZQ_SITE_ORIGIN: 'https://x.example/' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as Error).message;
    for (const name of ['ZQ_TARGET', 'ZQ_TABLE_NAME', 'ZQ_SITE_ORIGIN', 'ZQ_WS_CALLBACK_URL']) {
      expect(message).toContain(name);
    }
  });

  it('requires the Cognito ids unless local auth is on', () => {
    const { ZQ_COGNITO_CLIENT_ID: _client, ...noClient } = wsEnv;
    expect(() => loadWsConfig(noClient)).toThrow(/ZQ_COGNITO_CLIENT_ID: required/);
  });

  it('treats empty strings as unset', () => {
    const cfg = loadWsConfig({ ...wsEnv, ZQ_DDB_ENDPOINT: '', ZQ_SESSION_TTL_DAYS: '' });
    expect(cfg.ddbEndpoint).toBeUndefined();
    expect(cfg.sessionTtlMs).toBe(30 * 86_400_000);
  });

  it('rejects a site origin with a path or trailing slash', () => {
    expect(() => loadWsConfig({ ...wsEnv, ZQ_SITE_ORIGIN: 'https://example.com/' })).toThrow(
      /ZQ_SITE_ORIGIN/,
    );
    expect(() => loadWsConfig({ ...wsEnv, ZQ_SITE_ORIGIN: 'https://example.com/app' })).toThrow(
      /ZQ_SITE_ORIGIN/,
    );
    expect(() => loadWsConfig({ ...wsEnv, ZQ_SITE_ORIGIN: 'example.com' })).toThrow(
      /ZQ_SITE_ORIGIN/,
    );
  });
});

describe('loadHttpConfig', () => {
  it('maps the contract variables', () => {
    expect(loadHttpConfig(httpEnv)).toMatchObject({
      mediaBucket: 'zqhoot-media',
      wsFunctionName: 'zqhoot-ws',
      warmConcurrency: 4,
      lambdaEndpoint: undefined,
    });
  });

  it('rejects a non-numeric warm concurrency', () => {
    expect(() => loadHttpConfig({ ...httpEnv, ZQ_WARM_CONCURRENCY: 'many' })).toThrow(
      /ZQ_WARM_CONCURRENCY/,
    );
  });
});

describe('local auth switch', () => {
  const local: Env = { ...wsEnv, ZQ_AUTH_MODE: 'local' };
  const emulator: Env = { ...local, ZQ_EMULATOR: '1' };

  it('is refused without the emulator opt-in', () => {
    expect(() => loadWsConfig(local)).toThrow(/only available in the local emulator/);
    expect(() => loadWsConfig({ ...local, ZQ_EMULATOR: '0' })).toThrow(/emulator/);
    expect(() => loadWsConfig({ ...local, ZQ_EMULATOR: 'true' })).toThrow(/emulator/);
  });

  it.each([
    'AWS_LAMBDA_FUNCTION_NAME',
    'AWS_EXECUTION_ENV',
    'AWS_LAMBDA_RUNTIME_API',
    'LAMBDA_TASK_ROOT',
  ])('is refused when %s says this is Lambda', (marker) => {
    expect(() => loadWsConfig({ ...emulator, [marker]: 'x' })).toThrow(/emulator/);
    expect(() =>
      loadHttpConfig({ ...httpEnv, ZQ_AUTH_MODE: 'local', ZQ_EMULATOR: '1', [marker]: 'x' }),
    ).toThrow(/emulator/);
  });

  it('works in the emulator, with dev defaults and no Cognito ids', () => {
    const {
      ZQ_COGNITO_USER_POOL_ID: _pool,
      ZQ_COGNITO_CLIENT_ID: _client,
      ...noCognito
    } = emulator;
    expect(loadWsConfig(noCognito).auth).toEqual({
      mode: 'local',
      adminUser: 'admin',
      adminPassword: 'admin',
      adminPasswordHash: undefined,
      jwtSecret: DEV_JWT_SECRET,
    });
  });

  it('prefers a configured hash over the default password', () => {
    const auth = loadWsConfig({
      ...emulator,
      ZQ_ADMIN_PASSWORD_HASH: 'scrypt$1$2$3$c2FsdA$aGFzaA',
    }).auth;
    expect(auth).toMatchObject({
      adminPassword: undefined,
      adminPasswordHash: 'scrypt$1$2$3$c2FsdA$aGFzaA',
    });
  });

  it('rejects a short JWT secret', () => {
    expect(() => loadWsConfig({ ...emulator, ZQ_JWT_SECRET: 'short' })).toThrow(/ZQ_JWT_SECRET/);
  });

  it('is off by default', () => {
    expect(localAuthAllowed({})).toBe(false);
    expect(localAuthAllowed({ ZQ_EMULATOR: '1' })).toBe(true);
    expect(loadWsConfig(wsEnv).auth.mode).toBe('cognito');
  });
});
