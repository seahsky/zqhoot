import { z } from 'zod';

export type Env = Record<string, string | undefined>;

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** A dev-only secret: `local` auth is refused outside the emulator, so it never signs a real token. */
export const DEV_JWT_SECRET = 'zqhoot-emulator-dev-secret-not-for-production-use';

/** Set by the Lambda runtime; local auth must never start when any of them is present. */
const AWS_RUNTIME_MARKERS = [
  'AWS_LAMBDA_FUNCTION_NAME',
  'AWS_EXECUTION_ENV',
  'AWS_LAMBDA_RUNTIME_API',
  'LAMBDA_TASK_ROOT',
] as const;

export type AuthConfig =
  | { mode: 'cognito'; userPoolId: string; clientId: string }
  | {
      mode: 'local';
      adminUser: string;
      /**
       * At least one of the two is set (the password defaults to 'admin' when there is no hash).
       * `LocalAuth` uses the hash when both are present.
       */
      adminPassword: string | undefined;
      adminPasswordHash: string | undefined;
      jwtSecret: string;
    };

export interface BaseConfig {
  tableName: string;
  /** DynamoDB Local in the emulator and tests; unset on AWS. */
  ddbEndpoint: string | undefined;
  siteOrigin: string;
  sessionTtlMs: number;
  logLevel: LogLevel;
  auth: AuthConfig;
}

export interface WsConfig extends BaseConfig {
  wsCallbackUrl: string;
}

export interface HttpConfig extends BaseConfig {
  /** Origins the API answers CORS for: `siteOrigin` first, then `ZQ_CORS_EXTRA_ORIGINS`. */
  corsOrigins: string[];
  mediaBucket: string;
  wsFunctionName: string;
  warmConcurrency: number;
  /** The emulator's fake Lambda API; unset on AWS. */
  lambdaEndpoint: string | undefined;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * `ZQ_AUTH_MODE=local` replaces Cognito with a shared-secret login. It needs the emulator's own
 * opt-in and the absence of every Lambda runtime marker, so a stray variable in a real
 * deployment cannot turn it on.
 */
export function localAuthAllowed(env: Env): boolean {
  if (env.ZQ_EMULATOR !== '1') return false;
  return AWS_RUNTIME_MARKERS.every((name) => env[name] === undefined || env[name] === '');
}

const isOrigin = (value: string): boolean => {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
};

const Origin = z
  .string()
  .refine(isOrigin, 'must be an origin without a path or trailing slash, e.g. https://example.com');

/** Comma-separated exact `https://host[:port]` origins: no path, no wildcard, no `null`. */
const ExtraOrigins = z.string().transform((raw, ctx) => {
  const origins: string[] = [];
  for (const part of raw.split(',')) {
    const value = part.trim();
    if (value === '') continue;
    if (value.includes('*') || !value.startsWith('https://') || !isOrigin(value)) {
      ctx.issues.push({
        code: 'custom',
        message: `"${value}" must be an exact https origin such as https://quiz.example.com`,
        input: raw,
      });
      return z.NEVER;
    }
    origins.push(value);
  }
  return origins;
});

const baseShape = {
  ZQ_TARGET: z.literal('aws'),
  ZQ_TABLE_NAME: z.string().min(3).max(255),
  ZQ_SITE_ORIGIN: Origin,
  ZQ_SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  ZQ_LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  ZQ_DDB_ENDPOINT: z.url().optional(),
  ZQ_AUTH_MODE: z.enum(['cognito', 'local']).default('cognito'),
  ZQ_COGNITO_USER_POOL_ID: z.string().min(1).optional(),
  ZQ_COGNITO_CLIENT_ID: z.string().min(1).optional(),
  ZQ_ADMIN_USER: z.string().min(1).max(128).default('admin'),
  ZQ_ADMIN_PASSWORD: z.string().min(1).optional(),
  ZQ_ADMIN_PASSWORD_HASH: z.string().min(1).optional(),
  ZQ_JWT_SECRET: z.string().min(32).optional(),
};

const WsEnv = z.object({
  ...baseShape,
  ZQ_WS_CALLBACK_URL: z.url(),
});

const HttpEnv = z.object({
  ...baseShape,
  ZQ_CORS_EXTRA_ORIGINS: ExtraOrigins.optional(),
  ZQ_MEDIA_BUCKET: z.string().min(3).max(63),
  ZQ_WS_FUNCTION_NAME: z.string().min(1).max(140),
  ZQ_WARM_CONCURRENCY: z.coerce.number().int().min(0).max(50).default(4),
  ZQ_LAMBDA_ENDPOINT: z.url().optional(),
});

/** Every variable each function reads, for the contract test. */
export const WS_ENV_NAMES: readonly string[] = Object.keys(WsEnv.shape);
export const HTTP_ENV_NAMES: readonly string[] = Object.keys(HttpEnv.shape);

type BaseEnv = z.infer<z.ZodObject<typeof baseShape>>;

/** Terraform and shells both produce empty strings for "unset"; treat them the same. */
function withoutEmpty(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value !== '') out[key] = value;
  }
  return out;
}

function parseEnv<S extends z.ZodType>(schema: S, env: Env): z.infer<S> {
  const parsed = schema.safeParse(withoutEmpty(env));
  if (parsed.success) return parsed.data;
  const lines = parsed.error.issues.map(
    (issue) => `  ${issue.path.join('.') || '(env)'}: ${issue.message}`,
  );
  throw new ConfigError(`invalid environment:\n${lines.join('\n')}`);
}

function resolveAuth(parsed: BaseEnv, env: Env): AuthConfig {
  if (parsed.ZQ_AUTH_MODE === 'local') {
    if (!localAuthAllowed(env)) {
      throw new ConfigError(
        'ZQ_AUTH_MODE=local is only available in the local emulator (ZQ_EMULATOR=1 outside Lambda); ' +
          'remove it to use Cognito',
      );
    }
    return {
      mode: 'local',
      adminUser: parsed.ZQ_ADMIN_USER,
      adminPassword:
        parsed.ZQ_ADMIN_PASSWORD ??
        (parsed.ZQ_ADMIN_PASSWORD_HASH === undefined ? 'admin' : undefined),
      adminPasswordHash: parsed.ZQ_ADMIN_PASSWORD_HASH,
      jwtSecret: parsed.ZQ_JWT_SECRET ?? DEV_JWT_SECRET,
    };
  }
  const missing = (['ZQ_COGNITO_USER_POOL_ID', 'ZQ_COGNITO_CLIENT_ID'] as const).filter(
    (name) => parsed[name] === undefined,
  );
  if (missing.length > 0) {
    throw new ConfigError(
      `invalid environment:\n${missing.map((n) => `  ${n}: required`).join('\n')}`,
    );
  }
  return {
    mode: 'cognito',
    userPoolId: parsed.ZQ_COGNITO_USER_POOL_ID as string,
    clientId: parsed.ZQ_COGNITO_CLIENT_ID as string,
  };
}

function baseConfig(parsed: BaseEnv, env: Env): BaseConfig {
  return {
    tableName: parsed.ZQ_TABLE_NAME,
    ddbEndpoint: parsed.ZQ_DDB_ENDPOINT,
    siteOrigin: parsed.ZQ_SITE_ORIGIN,
    sessionTtlMs: parsed.ZQ_SESSION_TTL_DAYS * 86_400_000,
    logLevel: parsed.ZQ_LOG_LEVEL,
    auth: resolveAuth(parsed, env),
  };
}

/** Environment of the `ws` function. Throws `ConfigError` listing every problem. */
export function loadWsConfig(env: Env): WsConfig {
  const parsed = parseEnv(WsEnv, env);
  return { ...baseConfig(parsed, env), wsCallbackUrl: parsed.ZQ_WS_CALLBACK_URL };
}

/** Environment of the `http` function. Throws `ConfigError` listing every problem. */
export function loadHttpConfig(env: Env): HttpConfig {
  const parsed = parseEnv(HttpEnv, env);
  const base = baseConfig(parsed, env);
  return {
    ...base,
    corsOrigins: [...new Set([base.siteOrigin, ...(parsed.ZQ_CORS_EXTRA_ORIGINS ?? [])])],
    mediaBucket: parsed.ZQ_MEDIA_BUCKET,
    wsFunctionName: parsed.ZQ_WS_FUNCTION_NAME,
    warmConcurrency: parsed.ZQ_WARM_CONCURRENCY,
    lambdaEndpoint: parsed.ZQ_LAMBDA_ENDPOINT,
  };
}
