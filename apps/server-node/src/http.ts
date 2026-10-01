import { createServer } from 'node:http';
import type { IncomingMessage, RequestListener, Server, ServerResponse } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import type { Hono } from 'hono';
import { RuntimeConfig } from '@zqhoot/protocol';
import type { AppEnv, Logger } from '@zqhoot/service';
import type { PublicUrls } from './config.ts';
import { rawPath } from './request-path.ts';
import { createStaticHandler } from './static-files.ts';

/** Caddy keeps idle upstream connections for 2 minutes; closing one sooner makes it reuse a dead socket. */
const KEEP_ALIVE_TIMEOUT_MS = 125_000;

/** The body of `/config.json` for the VM target (local login, same-origin API). */
export function buildRuntimeConfig(publicUrl: PublicUrls): string {
  const config: RuntimeConfig = {
    target: 'vm',
    apiBaseUrl: '',
    wsUrl: publicUrl.wsUrl,
    mediaBaseUrl: publicUrl.mediaBaseUrl,
    joinUrl: publicUrl.joinUrl,
    auth: { mode: 'local' },
  };
  return JSON.stringify(RuntimeConfig.parse(config));
}

/**
 * Security headers of ADR-0013 for HTML responses. Caddy sets the same in front of the app; they are
 * repeated here so a deployment without the proxy is still covered.
 */
export function buildHtmlHeaders(publicUrl: PublicUrls): Record<string, string> {
  return {
    'Content-Security-Policy': [
      "default-src 'self'",
      `connect-src 'self' ${publicUrl.wsOrigin}`,
      "img-src 'self' data: blob:",
      "style-src 'self' 'unsafe-inline'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    // Browsers ignore HSTS sent over plain HTTP, and a local http:// setup must not pin itself to HTTPS.
    ...(publicUrl.secure && { 'Strict-Transport-Security': 'max-age=31536000' }),
  };
}

/** The service's own 429 shape (`ApiError`), so clients treat both limits alike. */
function tooManyRequests(res: ServerResponse): void {
  const body = JSON.stringify({
    error: 'rate-limited',
    message: 'too many requests, try again later',
  });
  res.writeHead(429, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Retry-After': '1',
  });
  res.end(body);
}

export interface HttpServerOptions {
  app: Hono<AppEnv>;
  publicUrl: PublicUrls;
  webDist: string;
  dataDir: string;
  logger: Logger;
  /** Spends one request of the caller's per-IP budget; false answers 429 before the API sees it. */
  allowApiRequest: (req: IncomingMessage) => boolean;
}

/**
 * The `node:http` server: `/api/*` goes to the Hono app of the service, everything else to the
 * static handler. The `upgrade` event is left to `attachWebSocketServer`.
 */
export function createHttpServer(opts: HttpServerOptions): Server {
  // `overrideGlobalObjects: false` keeps the adapter from replacing `Request`/`Response` process-wide.
  const api = getRequestListener(opts.app.fetch, { overrideGlobalObjects: false });
  const serveStatic = createStaticHandler({
    webDist: opts.webDist,
    dataDir: opts.dataDir,
    htmlHeaders: buildHtmlHeaders(opts.publicUrl),
    runtimeConfig: buildRuntimeConfig(opts.publicUrl),
  });

  const fail = (req: IncomingMessage, res: ServerResponse, err: unknown): void => {
    opts.logger.error(
      { method: req.method, err: err instanceof Error ? err.message : String(err) },
      'unhandled error while serving a request',
    );
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const body = 'Internal Server Error';
    res.writeHead(500, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    });
    res.end(body);
  };

  const listener: RequestListener = (req, res) => {
    const path = rawPath(req.url);
    if (path === null) {
      res.writeHead(400, { 'Content-Length': 0, Connection: 'close' });
      res.end();
      return;
    }
    const isApi = path === '/api' || path.startsWith('/api/');
    if (isApi && !opts.allowApiRequest(req)) {
      tooManyRequests(res);
      return;
    }
    const work = isApi ? api(req, res) : serveStatic(req, res, path);
    work.catch((err: unknown) => fail(req, res, err));
  };

  const server = createServer(listener);
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = KEEP_ALIVE_TIMEOUT_MS + 1000;
  return server;
}
