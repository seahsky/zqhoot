import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Env } from '../config.ts';

export interface EmulatorConfig {
  /** Address every listener binds to. Loopback by default: the dev credentials are well known. */
  host: string;
  /** Host name the browser and `config.json` use to reach the emulator. */
  publicHost: string;
  /** 0 picks a free port; the real ones are reported when the emulator is ready. */
  httpPort: number;
  wsPort: number;
  mgmtPort: number;
  stage: string;
  ddbEndpoint: string;
  tableName: string;
  /** Overrides `ZQ_SITE_ORIGIN`, the only Origin `$connect` accepts. */
  siteOrigin: string | undefined;
  webDist: string;
  /** Directory holding `ws/index.mjs` and `http/index.mjs` (the build output). */
  handlersDir: string;
  warmConcurrency: number;
}

function port(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`${name} must be a port number (0-65535), got "${raw}"`);
  }
  return value;
}

export function loadEmulatorConfig(env: Env, moduleUrl: string): EmulatorConfig {
  // dist/emulator/main.mjs -> the package root is two levels up.
  const packageRoot = resolve(dirname(fileURLToPath(moduleUrl)), '../..');
  const at = (name: string, fallback: string): string => {
    const value = env[name];
    return value === undefined || value === '' ? fallback : value;
  };
  const warm = Number(at('ZQ_WARM_CONCURRENCY', '2'));
  return {
    host: at('ZQ_EMU_HOST', '127.0.0.1'),
    publicHost: at('ZQ_EMU_PUBLIC_HOST', 'localhost'),
    httpPort: port(env, 'ZQ_EMU_HTTP_PORT', 3000),
    wsPort: port(env, 'ZQ_EMU_WS_PORT', 3001),
    mgmtPort: port(env, 'ZQ_EMU_MGMT_PORT', 3002),
    stage: at('ZQ_EMU_STAGE', 'emu'),
    ddbEndpoint: at('ZQ_DDB_ENDPOINT', 'http://localhost:8000'),
    tableName: at('ZQ_TABLE_NAME', 'zqhoot-emulator'),
    siteOrigin: env.ZQ_SITE_ORIGIN === '' ? undefined : env.ZQ_SITE_ORIGIN,
    webDist: resolve(at('ZQ_EMU_WEB_DIST', resolve(packageRoot, '../web/dist'))),
    handlersDir: resolve(at('ZQ_EMU_HANDLERS_DIR', resolve(packageRoot, 'dist'))),
    warmConcurrency: Number.isInteger(warm) && warm >= 0 ? warm : 2,
  };
}
