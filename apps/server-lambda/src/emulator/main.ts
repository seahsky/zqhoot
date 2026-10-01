import { LOG_LEVELS } from '../config.ts';
import type { LogLevel } from '../config.ts';
import { createLogger } from '../logger.ts';
import { loadEmulatorConfig } from './config.ts';
import { startEmulator } from './emulator.ts';

const level = process.env.ZQ_LOG_LEVEL as LogLevel | undefined;
const logger = createLogger(level !== undefined && LOG_LEVELS.includes(level) ? level : 'info');

try {
  const cfg = loadEmulatorConfig(process.env, import.meta.url);
  const usesDefaultLogin =
    (process.env.ZQ_ADMIN_PASSWORD ?? process.env.ZQ_ADMIN_PASSWORD_HASH ?? '') === '';
  if (usesDefaultLogin && !['127.0.0.1', 'localhost', '::1'].includes(cfg.host)) {
    logger.warn({ host: cfg.host }, 'listening beyond loopback with the default admin/admin login');
  }

  const emulator = await startEmulator(cfg, logger);

  // Scripts (the E2E test, the load test) read this line for the ports and the Origin to send.
  console.log(
    `ZQ_EMULATOR_READY ${JSON.stringify({
      http: emulator.urls.http,
      ws: emulator.urls.ws,
      mgmt: emulator.urls.mgmt,
      callback: emulator.urls.callback,
      origin: emulator.siteOrigin,
      table: emulator.tableName,
      webDist: cfg.webDist,
    })}`,
  );

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'emulator stopping');
    void emulator.stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
} catch (err) {
  console.error(`emulator failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
