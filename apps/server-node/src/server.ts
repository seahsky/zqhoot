import { mkdir } from 'node:fs/promises';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { TIMING } from '@zqhoot/protocol';
import { GameService, createHttpApp } from '@zqhoot/service';
import type { Clock, Logger } from '@zqhoot/service';
import { DynamoStore, attachFilePersistence, loadMemoryStore } from '@zqhoot/store';
import type { FilePersistence, MemoryStore, Store } from '@zqhoot/store';
import pkg from '../package.json' with { type: 'json' };
import { clientIp } from './client-ip.ts';
import { createHttpServer } from './http.ts';
import { API_RATE_BURST, API_RATE_PER_SECOND, IpRateLimiter } from './ip-rate-limit.ts';
import { createLogger } from './logger.ts';
import { parsePasswordHash, hashPassword } from './password-hash.ts';
import type { PasswordHash } from './password-hash.ts';
import { LocalAuth } from './ports/local-auth.ts';
import { LocalMedia } from './ports/local-media.ts';
import { createIds } from './ports/ids.ts';
import { TimerScheduler, recoverSessions } from './ports/scheduler.ts';
import type { ServerConfig } from './config.ts';
import { attachWebSocketServer } from './ws-server.ts';
import type { WebSocketRuntime } from './ws-server.ts';
import { WsTransport } from './ws-transport.ts';

const SWEEP_INTERVAL_MS = 60_000;
const PERSIST_DEBOUNCE_MS = 1000;
const DAY_MS = 24 * 3_600_000;
const SOCKET_GRACE_MS = 3000;
const HTTP_GRACE_MS = 3000;

export interface CreateServerOptions {
  logger?: Logger;
  clock?: Clock;
  /** Overrides the scrypt cost of a plaintext `ZQ_ADMIN_PASSWORD`; tests use a small one. */
  scryptCost?: { N: number; r: number; p: number };
  /** Milliseconds between `MemoryStore.sweepExpired` calls. Default 60 s (ADR-0003). */
  sweepIntervalMs?: number;
  /** Milliseconds between WebSocket ping sweeps. Default 30 s (ADR-0007). */
  pingIntervalMs?: number;
}

export interface ServerHandle {
  readonly httpServer: Server;
  readonly store: Store;
  readonly service: GameService;
  readonly scheduler: TimerScheduler;
  readonly sockets: WebSocketRuntime;
  /** Recovers persisted sessions, then starts listening. */
  start(): Promise<AddressInfo>;
  /** Stops accepting, closes sockets with 1001, writes the state file. Safe to call twice. */
  close(): Promise<void>;
}

async function resolvePassword(
  config: ServerConfig,
  cost: NonNullable<CreateServerOptions['scryptCost']> | undefined,
): Promise<PasswordHash> {
  const { password } = config.admin;
  const stored =
    password.kind === 'hash' ? password.hash : await hashPassword(password.password, cost);
  const parsed = parsePasswordHash(stored);
  if (parsed === null) throw new Error('the admin password hash is malformed');
  return parsed;
}

function createStore(config: ServerConfig, logger: Logger, clock: Clock) {
  const now = (): number => clock.now();
  if (config.store.kind === 'dynamodb') {
    const { tableName, region, endpoint } = config.store;
    const store: Store = new DynamoStore({
      tableName,
      region,
      now,
      ...(endpoint !== undefined && { endpoint }),
    });
    return { store, memory: undefined, persistence: undefined };
  }
  const statePath = join(config.dataDir, 'state.json');
  const memory = loadMemoryStore(statePath, { now });
  const persistence = attachFilePersistence(memory, statePath, {
    debounceMs: PERSIST_DEBOUNCE_MS,
    onError: (err) =>
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'state file write failed',
      ),
  });
  return { store: memory, memory, persistence };
}

/**
 * Wires the service to the Node runtime: store, ports, HTTP and WebSocket. Nothing listens until
 * `start()`.
 */
export async function createServer(
  config: ServerConfig,
  opts: CreateServerOptions = {},
): Promise<ServerHandle> {
  const logger = opts.logger ?? createLogger(config.logLevel);
  const clock: Clock = opts.clock ?? { now: () => Date.now() };
  const ids = createIds();
  const password = await resolvePassword(config, opts.scryptCost);

  const { store, memory, persistence } = createStore(config, logger, clock);
  const auth = new LocalAuth({
    user: config.admin.user,
    password,
    secret: config.jwtSecret,
    clock,
  });
  const media = new LocalMedia({ dataDir: config.dataDir, secret: config.jwtSecret, clock, ids });
  const transport = new WsTransport(clock, logger);

  const engine = {
    minLeadMs: TIMING.minLeadMs.node,
    answerGraceMs: TIMING.answerGraceMs,
    sessionTtlMs: config.sessionTtlDays * DAY_MS,
  };
  // The scheduler calls the service and the service holds the scheduler; timers only fire after both exist.
  const scheduler = new TimerScheduler(
    (sessionId, questionIndex) => game.onTimer(sessionId, questionIndex),
    clock,
    logger,
  );
  const game = new GameService({
    store,
    transport,
    clock,
    ids,
    hostAuth: auth,
    scheduler,
    logger,
    config: {
      engine,
      revealSettleMs: 0,
      allowedOrigins: [config.publicUrl.origin],
      nicknameAttemptsPerConnection: 10,
    },
  });

  const app = createHttpApp({
    store,
    clock,
    ids,
    hostAuth: auth,
    media,
    logger,
    localLogin: auth,
    engine,
    info: { target: 'vm', version: pkg.version },
    clientIp: (c) => {
      const incoming = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming;
      return incoming === undefined ? undefined : clientIp(incoming, config.trustProxy);
    },
  });

  const apiLimiter = new IpRateLimiter(API_RATE_PER_SECOND, API_RATE_BURST, clock);
  const httpServer = createHttpServer({
    app,
    publicUrl: config.publicUrl,
    webDist: config.webDist,
    dataDir: config.dataDir,
    logger,
    allowApiRequest: (req) => apiLimiter.allow(clientIp(req, config.trustProxy)),
  });
  const sockets = attachWebSocketServer({
    server: httpServer,
    service: game,
    transport,
    clock,
    logger,
    trustProxy: config.trustProxy,
    ...(opts.pingIntervalMs !== undefined && { pingIntervalMs: opts.pingIntervalMs }),
  });

  const sweeper =
    memory === undefined
      ? undefined
      : startSweeper(memory, opts.sweepIntervalMs ?? SWEEP_INTERVAL_MS);
  let closing: Promise<void> | undefined;

  return {
    httpServer,
    store,
    service: game,
    scheduler,
    sockets,
    async start() {
      // Fail at startup, not at the first upload or the first state write, when the volume is not writable.
      await mkdir(join(config.dataDir, 'media'), { recursive: true });
      await recoverSessions({
        store,
        scheduler,
        hostId: auth.hostId,
        answerGraceMs: engine.answerGraceMs,
        log: logger,
      });
      await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(config.port, config.host, () => {
          httpServer.off('error', reject);
          resolve();
        });
      });
      return httpServer.address() as AddressInfo;
    },
    close() {
      closing ??= shutdown();
      return closing;
    },
  };

  async function shutdown(): Promise<void> {
    if (sweeper !== undefined) clearInterval(sweeper);
    scheduler.dispose();
    const stopped = stopHttp(httpServer);
    await sockets.close(SOCKET_GRACE_MS);
    await stopped;
    await flush(persistence, logger);
  }
}

function startSweeper(memory: MemoryStore, intervalMs: number): NodeJS.Timeout {
  const timer = setInterval(() => memory.sweepExpired(), intervalMs);
  timer.unref();
  return timer;
}

/** Stops accepting connections, then drops the ones still open after a grace period. */
function stopHttp(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    const cutoff = setTimeout(() => server.closeAllConnections(), HTTP_GRACE_MS);
    server.close(() => {
      clearTimeout(cutoff);
      resolve();
    });
    server.closeIdleConnections();
  });
}

async function flush(persistence: FilePersistence | undefined, logger: Logger): Promise<void> {
  if (persistence === undefined) return;
  try {
    await persistence.close();
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'final state write failed',
    );
    throw err;
  }
}
