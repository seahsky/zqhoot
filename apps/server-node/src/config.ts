import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { LOG_LEVELS } from './logger.ts';
import type { LogLevel } from './logger.ts';
import { parsePasswordHash } from './password-hash.ts';

/** Everything derived from `ZQ_PUBLIC_URL`. */
export interface PublicUrls {
  /** `https://quiz.example.com`, the only `Origin` a WebSocket upgrade may carry. */
  origin: string;
  /** `wss://quiz.example.com`, for the CSP `connect-src`. */
  wsOrigin: string;
  wsUrl: string;
  joinUrl: string;
  mediaBaseUrl: string;
  secure: boolean;
  hostname: string;
}

export type StoreConfig =
  { kind: 'memory' } | { kind: 'dynamodb'; tableName: string; region: string; endpoint?: string };

export type AdminPassword = { kind: 'hash'; hash: string } | { kind: 'plain'; password: string };

export interface ServerConfig {
  port: number;
  host: string;
  publicUrl: PublicUrls;
  dataDir: string;
  store: StoreConfig;
  admin: { user: string; password: AdminPassword };
  jwtSecret: string;
  webDist: string;
  trustProxy: boolean;
  sessionTtlDays: number;
  logLevel: LogLevel;
}

export type ConfigResult =
  { ok: true; config: ServerConfig; warnings: string[] } | { ok: false; errors: string[] };

const JWT_SECRET_MIN_BYTES = 32;
const DOCKER_WEB_DIST = '/app/web';

const required = z.string({ error: 'is required' });

const whole = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d{1,9}$/, 'must be a whole number')
    .transform(Number)
    .pipe(z.number().min(min, `must be at least ${min}`).max(max, `must be at most ${max}`));

const flag = z
  .enum(['true', 'false', '1', '0'], { error: 'must be true or false' })
  .transform((v) => v === 'true' || v === '1');

const RawEnv = z.object({
  ZQ_PORT: whole(0, 65_535).default(8080),
  ZQ_HOST: z.string().min(1).default('0.0.0.0'),
  ZQ_PUBLIC_URL: required,
  ZQ_DATA_DIR: z.string().default('./data'),
  ZQ_STORE: z
    .enum(['memory', 'dynamodb'], { error: 'must be memory or dynamodb' })
    .default('memory'),
  ZQ_TABLE_NAME: z.string().optional(),
  ZQ_DDB_ENDPOINT: z.url({ error: 'must be a URL' }).optional(),
  AWS_REGION: z.string().optional(),
  ZQ_ADMIN_USER: z
    .string()
    .max(128, 'must be at most 128 characters')
    .regex(/^[^\p{Cc}]+$/u, 'must not contain control characters')
    .default('admin'),
  ZQ_ADMIN_PASSWORD_HASH: z
    .string()
    .refine(
      (v) => parsePasswordHash(v) !== null,
      'must look like scrypt$N$r$p$saltBase64$hashBase64 (generate one with: pnpm --filter @zqhoot/server-node hash-password)',
    )
    .optional(),
  ZQ_ADMIN_PASSWORD: z.string().optional(),
  ZQ_JWT_SECRET: required.refine(
    (v) => Buffer.byteLength(v, 'utf8') >= JWT_SECRET_MIN_BYTES,
    `must be at least ${JWT_SECRET_MIN_BYTES} bytes (generate one with: openssl rand -base64 48)`,
  ),
  ZQ_WEB_DIST: z.string().optional(),
  ZQ_TRUST_PROXY: flag.default(false),
  ZQ_SESSION_TTL_DAYS: whole(1, 3650).default(30),
  ZQ_LOG_LEVEL: z
    .enum(LOG_LEVELS, { error: `must be one of ${LOG_LEVELS.join(', ')}` })
    .default('info'),
});

/**
 * Rules that span variables. Checked on the raw environment rather than inside the zod schema,
 * because zod skips a refinement while any field is invalid and the operator should see everything at once.
 */
function crossFieldProblems(env: Record<string, string>): string[] {
  const problems: string[] = [];
  if (env.ZQ_ADMIN_PASSWORD_HASH === undefined && env.ZQ_ADMIN_PASSWORD === undefined) {
    problems.push(
      'ZQ_ADMIN_PASSWORD_HASH: set ZQ_ADMIN_PASSWORD_HASH (or ZQ_ADMIN_PASSWORD for local development)',
    );
  }
  if (env.ZQ_STORE === 'dynamodb') {
    for (const name of ['ZQ_TABLE_NAME', 'AWS_REGION']) {
      if (env[name] === undefined) problems.push(`${name}: is required when ZQ_STORE=dynamodb`);
    }
  }
  return problems;
}

/** The derived URLs, or the reason `value` cannot be the public URL. */
function derivePublicUrls(value: string): PublicUrls | string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'must be an absolute URL such as https://quiz.example.com';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return 'must start with http:// or https://';
  if (url.username !== '' || url.password !== '') return 'must not contain credentials';
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    return 'must be an origin without a path, query or fragment (the app is served from the root)';
  }
  const secure = url.protocol === 'https:';
  const wsOrigin = `${secure ? 'wss' : 'ws'}://${url.host}`;
  return {
    origin: url.origin,
    wsOrigin,
    wsUrl: `${wsOrigin}/ws`,
    joinUrl: `${url.origin}/join`,
    mediaBaseUrl: `${url.origin}/`,
    secure,
    hostname: url.hostname,
  };
}

/**
 * `../../web/dist` from the bundle (`apps/server-node/dist/server.mjs`) or from the source
 * (`apps/server-node/src/config.ts`) is `apps/web/dist` either way. The Docker image keeps the
 * web app in `/app/web` instead.
 */
export function defaultWebDist(): string {
  const monorepo = fileURLToPath(new URL('../../web/dist', import.meta.url));
  if (existsSync(join(monorepo, 'index.html'))) return monorepo;
  if (existsSync(join(DOCKER_WEB_DIST, 'index.html'))) return DOCKER_WEB_DIST;
  return monorepo;
}

/**
 * Validates the environment. Empty values count as unset, so a `.env` with `ZQ_ADMIN_PASSWORD=`
 * behaves like one without the line. Never returns a value that was rejected, so error messages
 * cannot leak a secret.
 */
export function parseConfig(
  env: Record<string, string | undefined>,
  opts: { cwd?: string; defaultWebDist?: () => string } = {},
): ConfigResult {
  const present: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if ((key.startsWith('ZQ_') || key === 'AWS_REGION') && value !== undefined && value !== '')
      present[key] = value;
  }
  const parsed = RawEnv.safeParse(present);
  const problems = parsed.success
    ? []
    : parsed.error.issues.map(
        (issue) => `${issue.path.map(String).join('.') || 'environment'}: ${issue.message}`,
      );
  problems.push(...crossFieldProblems(present));
  const publicUrl =
    present.ZQ_PUBLIC_URL === undefined ? undefined : derivePublicUrls(present.ZQ_PUBLIC_URL);
  if (typeof publicUrl === 'string') problems.push(`ZQ_PUBLIC_URL: ${publicUrl}`);
  if (!parsed.success || typeof publicUrl !== 'object' || problems.length > 0) {
    return { ok: false, errors: problems };
  }
  const raw = parsed.data;

  const cwd = opts.cwd ?? process.cwd();
  const warnings: string[] = [];
  let password: AdminPassword;
  if (raw.ZQ_ADMIN_PASSWORD_HASH !== undefined) {
    password = { kind: 'hash', hash: raw.ZQ_ADMIN_PASSWORD_HASH };
    if (raw.ZQ_ADMIN_PASSWORD !== undefined) {
      warnings.push('ZQ_ADMIN_PASSWORD is ignored because ZQ_ADMIN_PASSWORD_HASH is set');
    }
  } else {
    password = { kind: 'plain', password: raw.ZQ_ADMIN_PASSWORD ?? '' };
    warnings.push(
      'ZQ_ADMIN_PASSWORD is for local development only; set ZQ_ADMIN_PASSWORD_HASH in production',
    );
  }

  return {
    ok: true,
    warnings,
    config: {
      port: raw.ZQ_PORT,
      host: raw.ZQ_HOST,
      publicUrl,
      dataDir: resolve(cwd, raw.ZQ_DATA_DIR),
      store:
        raw.ZQ_STORE === 'memory'
          ? { kind: 'memory' }
          : {
              kind: 'dynamodb',
              tableName: raw.ZQ_TABLE_NAME ?? '',
              region: raw.AWS_REGION ?? '',
              ...(raw.ZQ_DDB_ENDPOINT !== undefined && { endpoint: raw.ZQ_DDB_ENDPOINT }),
            },
      admin: { user: raw.ZQ_ADMIN_USER, password },
      jwtSecret: raw.ZQ_JWT_SECRET,
      webDist:
        raw.ZQ_WEB_DIST !== undefined
          ? resolve(cwd, raw.ZQ_WEB_DIST)
          : (opts.defaultWebDist ?? defaultWebDist)(),
      trustProxy: raw.ZQ_TRUST_PROXY,
      sessionTtlDays: raw.ZQ_SESSION_TTL_DAYS,
      logLevel: raw.ZQ_LOG_LEVEL,
    },
  };
}
