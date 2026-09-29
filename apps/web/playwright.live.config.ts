import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import {
  BASE_URL,
  DDB_ENDPOINT,
  EMULATOR_PORTS,
  HOST_LOGIN,
  JWT_SECRET,
  NODE_SERVER_PORT,
  TARGET,
} from './e2e-live/target.ts';

/**
 * Live end-to-end suite: real browsers against a real server, not a scripted one.
 *
 *   pnpm --filter @zqhoot/web test:e2e:live                                   # Node server
 *   ZQ_E2E_TARGET=lambda-emulator pnpm --filter @zqhoot/web test:e2e:live     # Lambda handlers
 *
 * `ZQ_E2E_SKIP_BUILD=1` reuses the last builds, for iterating on the specs.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const skipBuild = process.env.ZQ_E2E_SKIP_BUILD === '1';
const wrap = 'node apps/web/e2e-live/run-server.mjs';

/** Names the DynamoDB Local table of one emulator run; a fresh one each time, so runs never mix. */
const table = `zqhoot-e2e-${Date.now().toString(36)}`;

const nodeServer = {
  command: [
    ...(skipBuild
      ? []
      : ['pnpm --filter @zqhoot/web build', 'pnpm --filter @zqhoot/server-node build']),
    `${wrap} node --enable-source-maps apps/server-node/dist/server.mjs`,
  ].join(' && '),
  env: {
    ZQ_PORT: String(NODE_SERVER_PORT),
    ZQ_PUBLIC_URL: BASE_URL,
    ZQ_JWT_SECRET: JWT_SECRET,
    // Plain-text password is the documented development mode; a test needs no hash.
    ZQ_ADMIN_USER: HOST_LOGIN.username,
    ZQ_ADMIN_PASSWORD: HOST_LOGIN.password,
    ZQ_LOG_LEVEL: 'warn',
  },
};

const emulator = {
  command: [
    ...(skipBuild
      ? []
      : ['pnpm --filter @zqhoot/web build', 'pnpm --filter @zqhoot/server-lambda build']),
    `${wrap} node --enable-source-maps apps/server-lambda/dist/emulator/main.mjs`,
  ].join(' && '),
  env: {
    ZQ_EMU_HTTP_PORT: String(EMULATOR_PORTS.http),
    ZQ_EMU_WS_PORT: String(EMULATOR_PORTS.ws),
    ZQ_EMU_MGMT_PORT: String(EMULATOR_PORTS.mgmt),
    ZQ_TABLE_NAME: table,
    ZQ_E2E_DROP_TABLE: table,
    ZQ_DDB_ENDPOINT: DDB_ENDPOINT,
    ZQ_JWT_SECRET: JWT_SECRET,
    ZQ_ADMIN_USER: HOST_LOGIN.username,
    ZQ_ADMIN_PASSWORD: HOST_LOGIN.password,
    ZQ_LOG_LEVEL: 'warn',
  },
};

const server = TARGET === 'node' ? nodeServer : emulator;

export default defineConfig({
  testDir: 'e2e-live',
  testMatch: '**/*.spec.ts',
  // One game at a time: the specs share one server and its login rate limit.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  // The whole game takes about two minutes. The rest is headroom for a busy machine, since the
  // 400-player load test may be using the same CPUs; assertions stay strict, only waits stretch.
  timeout: 360_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: BASE_URL,
    browserName: 'chromium',
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },
  projects: [{ name: TARGET }],
  webServer: {
    command: server.command,
    cwd: repoRoot,
    env: server.env,
    url: `${BASE_URL}/api/health`,
    // A leftover server on the port would be tested by mistake, with somebody else's data.
    reuseExistingServer: false,
    timeout: 240_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
    stderr: 'pipe',
  },
});
