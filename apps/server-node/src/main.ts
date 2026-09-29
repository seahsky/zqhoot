import { parseConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { createServer } from './server.ts';

/** `SIGTERM` gives a container 10 s before `SIGKILL`; leave nothing to that. */
const SHUTDOWN_DEADLINE_MS = 10_000;

const parsed = parseConfig(process.env);
if (!parsed.ok) {
  process.stderr.write(
    `zqhoot: invalid configuration\n${parsed.errors.map((e) => `  ${e}`).join('\n')}\n`,
  );
  process.exit(1);
}
const { config, warnings } = parsed;
const logger = createLogger(config.logLevel);
for (const warning of warnings) logger.warn({}, warning);
if (
  !config.publicUrl.secure &&
  !['localhost', '127.0.0.1', '[::1]'].includes(config.publicUrl.hostname)
) {
  logger.warn(
    { publicUrl: config.publicUrl.origin },
    'ZQ_PUBLIC_URL is plain http; phones need https for Wake Lock and other features',
  );
}

let shuttingDown = false;
let server: Awaited<ReturnType<typeof createServer>> | undefined;

async function shutdown(reason: string, exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ reason }, 'shutting down');
  setTimeout(() => {
    logger.error({}, 'shutdown did not finish in time; exiting');
    process.exit(1);
  }, SHUTDOWN_DEADLINE_MS).unref();
  try {
    await server?.close();
    logger.info({}, 'stopped');
    process.exit(exitCode);
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'shutdown failed');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
process.on('SIGINT', () => void shutdown('SIGINT', 0));
process.on('uncaughtException', (err) => {
  logger.error({ err: { message: err.message, stack: err.stack } }, 'uncaught exception');
  void shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (reason) => {
  logger.error(
    {
      err:
        reason instanceof Error ? { message: reason.message, stack: reason.stack } : String(reason),
    },
    'unhandled rejection',
  );
});

try {
  server = await createServer(config, { logger });
  const address = await server.start();
  logger.info(
    {
      port: address.port,
      host: address.address,
      publicUrl: config.publicUrl.origin,
      store: config.store.kind,
      dataDir: config.dataDir,
      webDist: config.webDist,
    },
    'zqhoot server listening',
  );
} catch (err) {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, 'failed to start');
  await shutdown('startup failure', 1);
}
