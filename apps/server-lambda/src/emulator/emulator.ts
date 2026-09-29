import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { RuntimeConfig } from '@zqhoot/protocol';
import { ensureTable } from '@zqhoot/store';
import type { Logger } from '@zqhoot/service';
import type { EmulatorConfig } from './config.ts';
import { createApiHandler } from './http-gateway.ts';
import type { HttpApiResult } from './http-gateway.ts';
import { createManagementHandler } from './management-api.ts';
import { ConnectionRegistry, createStats } from './registry.ts';
import { createStaticHandler } from './static-files.ts';
import { WebSocketGateway } from './ws-gateway.ts';

export interface RunningEmulator {
  ports: { http: number; ws: number; mgmt: number };
  urls: { http: string; ws: string; mgmt: string; callback: string };
  siteOrigin: string;
  tableName: string;
  stop(): Promise<void>;
}

type LambdaHandler = (event: unknown, context: unknown) => Promise<unknown>;

const WS_FUNCTION_NAME = 'zqhoot-emulator-ws';
const HTTP_FUNCTION_NAME = 'zqhoot-emulator-http';

const listen = (server: Server, port: number, host: string): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve((server.address() as AddressInfo).port));
  });

const close = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });

const lambdaContext = (functionName: string) => ({
  functionName,
  awsRequestId: crypto.randomUUID(),
  getRemainingTimeInMillis: () => 30_000,
});

async function loadHandler(handlersDir: string, name: string): Promise<LambdaHandler> {
  const file = join(handlersDir, name, 'index.mjs');
  try {
    return ((await import(pathToFileURL(file).href)) as { handler: LambdaHandler }).handler;
  } catch (err) {
    throw new Error(
      `cannot load ${file}: ${err instanceof Error ? err.message : String(err)}. ` +
        'Run pnpm --filter @zqhoot/server-lambda build first.',
      { cause: err },
    );
  }
}

/**
 * Starts the three listeners and the built handlers behind them. The handlers read
 * `process.env` when they are imported, so it is filled in first; that also makes it one emulator
 * per process.
 */
export async function startEmulator(cfg: EmulatorConfig, logger: Logger): Promise<RunningEmulator> {
  const mgmtServer = createServer();
  const wsServer = createServer((_req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end('WebSocket endpoint: connect with ws://');
  });
  const httpServer = createServer();
  const servers = [mgmtServer, wsServer, httpServer];
  // Node closes idle keep-alive sockets after 5 s, and the SDK's pooled sockets outlive that: the
  // next request on a socket the server just closed fails with ECONNRESET. API Gateway holds
  // idle connections far longer.
  for (const server of [mgmtServer, httpServer]) {
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;
  }

  // Bind first, so that port 0 has become a real port before the handlers read their environment.
  const [mgmt, ws, http] = await Promise.all([
    listen(mgmtServer, cfg.mgmtPort, cfg.host),
    listen(wsServer, cfg.wsPort, cfg.host),
    listen(httpServer, cfg.httpPort, cfg.host),
  ]);
  const inside = cfg.host === '0.0.0.0' || cfg.host === '::' ? '127.0.0.1' : cfg.host;
  const urls = {
    http: `http://${cfg.publicHost}:${http}`,
    ws: `ws://${cfg.publicHost}:${ws}`,
    mgmt: `http://${inside}:${mgmt}`,
    callback: `http://${inside}:${mgmt}/${cfg.stage}`,
  };
  const siteOrigin = cfg.siteOrigin ?? urls.http;

  let wsHandler: LambdaHandler;
  let httpHandler: LambdaHandler;
  try {
    Object.assign(process.env, {
      ZQ_TARGET: 'aws',
      ZQ_EMULATOR: '1',
      ZQ_AUTH_MODE: 'local',
      ZQ_TABLE_NAME: cfg.tableName,
      ZQ_DDB_ENDPOINT: cfg.ddbEndpoint,
      ZQ_SITE_ORIGIN: siteOrigin,
      ZQ_WS_CALLBACK_URL: urls.callback,
      ZQ_LAMBDA_ENDPOINT: urls.mgmt,
      ZQ_WS_FUNCTION_NAME: WS_FUNCTION_NAME,
      ZQ_WARM_CONCURRENCY: String(cfg.warmConcurrency),
      ZQ_MEDIA_BUCKET: process.env.ZQ_MEDIA_BUCKET ?? 'zqhoot-emulator-media',
      AWS_REGION: process.env.AWS_REGION ?? 'us-east-1',
      // The SDK signs every request and nothing here checks the signature. Real credentials from
      // the developer's shell must never reach a local endpoint (or a presigned POST), and
      // DynamoDB Local rejects some real-looking key ids.
      AWS_ACCESS_KEY_ID: 'emulator',
      AWS_SECRET_ACCESS_KEY: 'emulator',
    });
    delete process.env.AWS_SESSION_TOKEN;

    await ensureTable(
      new DynamoDBClient({ endpoint: cfg.ddbEndpoint, region: process.env.AWS_REGION as string }),
      cfg.tableName,
    );
    // One after the other: both read and validate the same environment, and a failure should
    // name a single bundle.
    wsHandler = await loadHandler(cfg.handlersDir, 'ws');
    httpHandler = await loadHandler(cfg.handlersDir, 'http');
  } catch (err) {
    await Promise.all(servers.map(close));
    throw err;
  }

  const registry = new ConnectionRegistry();
  const stats = createStats();

  const gateway = new WebSocketGateway({
    registry,
    invoke: async (event) =>
      (await wsHandler(event, lambdaContext(WS_FUNCTION_NAME))) as { statusCode?: number },
    stats,
    stage: cfg.stage,
    domainName: `${cfg.publicHost}:${ws}`,
    logger,
  });
  wsServer.on('upgrade', (req, socket, head) => {
    gateway.handleUpgrade(req, socket, head).catch((err: unknown) => {
      logger.error({ err: String(err) }, 'upgrade failed');
      socket.destroy();
    });
  });

  const management = createManagementHandler({
    registry,
    stats,
    stage: cfg.stage,
    wsFunctionName: WS_FUNCTION_NAME,
    invokeWs: async (payload) => {
      stats.invocations.warmup++;
      return wsHandler(payload, lambdaContext(WS_FUNCTION_NAME));
    },
    logger,
  });
  mgmtServer.on('request', (req, res) => void management(req, res));

  const runtimeConfig = JSON.stringify(
    RuntimeConfig.parse({
      target: 'aws',
      apiBaseUrl: '',
      wsUrl: urls.ws,
      mediaBaseUrl: `${siteOrigin}/`,
      joinUrl: `${siteOrigin}/join`,
      auth: { mode: 'local' },
    }),
  );
  const api = createApiHandler({
    invoke: async (event) =>
      (await httpHandler(event, lambdaContext(HTTP_FUNCTION_NAME))) as HttpApiResult,
    domainName: `${cfg.publicHost}:${http}`,
    logger,
  });
  const staticFiles = createStaticHandler(cfg.webDist);
  httpServer.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    if (path === '/config.json') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
      return void res.end(runtimeConfig);
    }
    if (path === '/api' || path.startsWith('/api/')) return void api(req, res);
    void staticFiles(req, res);
  });

  return {
    ports: { http, ws, mgmt },
    urls,
    siteOrigin,
    tableName: cfg.tableName,
    async stop() {
      // The management API must outlive the sockets: each `$disconnect` may still post to hosts.
      await gateway.closeAll();
      await Promise.all(servers.map(close));
    },
  };
}
