import { isUtf8 } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WebSocket } from 'ws';
import type { Logger } from '@zqhoot/service';
import type { ConnectionRegistry, EmulatorStats } from './registry.ts';

/** API Gateway's limit for `PostToConnection`. */
const MAX_POST_BYTES = 128 * 1024;
const CONNECTIONS_PATH = /^\/([^/]+)\/@connections\/([^/]+)$/;
const INVOKE_PATH = /^\/2015-03-31\/functions\/([^/]+)\/invocations$/;

export interface ManagementApiOptions {
  registry: ConnectionRegistry;
  stats: EmulatorStats;
  stage: string;
  /** Name of the function `Invoke` may target. */
  wsFunctionName: string;
  /** Runs the ws handler for an `Invoke` call. */
  invokeWs: (payload: unknown) => Promise<unknown>;
  logger: Logger;
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    // Keep draining so the client sees the 413 instead of a reset connection.
    if (size <= limit) chunks.push(chunk);
  }
  return size > limit ? null : Buffer.concat(chunks);
}

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

/** The SDK recognises the error class from `x-amzn-ErrorType`, as it does for the real API. */
const failure = (res: ServerResponse, status: number, type: string, message: string) =>
  json(res, status, { message }, { 'x-amzn-ErrorType': type });

const gone = (res: ServerResponse) => failure(res, 410, 'GoneException', 'Gone');

/** Text when the payload is UTF-8 (all of ours is), so browsers get a string, not a Blob. */
function sendFrame(socket: WebSocket, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    // The stream layer reports success as `undefined` or `null`, depending on the Node version.
    const done = (err?: Error | null): void => (err ? reject(err) : resolve());
    if (isUtf8(data)) socket.send(data.toString('utf8'), done);
    else socket.send(data, { binary: true }, done);
  });
}

/**
 * The `@connections` management API on its own port, plus the one Lambda `Invoke` route the http
 * function's warm-up uses. Requests are not signature-checked: the SDK signs with dummy
 * credentials.
 */
export function createManagementHandler(opts: ManagementApiOptions) {
  const { registry, stats } = opts;

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const path = new URL(req.url ?? '/', 'http://emulator').pathname;

      if (req.method === 'GET' && path === '/__emulator/stats') {
        return json(res, 200, { connections: registry.size, ...stats });
      }
      if (req.method === 'GET' && path === '/__emulator/connections') {
        return json(
          res,
          200,
          [...registry.all()].map((c) => ({
            id: c.id,
            sourceIp: c.sourceIp,
            connectedAt: c.connectedAt,
            closing: c.closing,
          })),
        );
      }

      const invoke = INVOKE_PATH.exec(path);
      if (invoke !== null && req.method === 'POST') {
        return await handleInvoke(req, res, decodeURIComponent(invoke[1] as string));
      }

      const match = CONNECTIONS_PATH.exec(path);
      if (match === null) return failure(res, 404, 'NotFoundException', 'no such route');
      if (decodeURIComponent(match[1] as string) !== opts.stage) {
        return failure(res, 404, 'NotFoundException', `no such stage, use /${opts.stage}`);
      }
      const conn = registry.get(decodeURIComponent(match[2] as string));

      switch (req.method) {
        case 'POST': {
          const body = await readBody(req, MAX_POST_BYTES);
          if (body === null) {
            return failure(res, 413, 'PayloadTooLargeException', 'payload too large');
          }
          if (conn === undefined || conn.closing) return gone(res);
          try {
            await sendFrame(conn.socket, body);
          } catch {
            return gone(res);
          }
          res.writeHead(200, { 'Content-Length': 0 });
          return void res.end();
        }
        case 'DELETE': {
          if (conn === undefined || conn.closing) return gone(res);
          conn.closing = true;
          conn.socket.close(1000);
          res.writeHead(204);
          return void res.end();
        }
        case 'GET': {
          if (conn === undefined || conn.closing) return gone(res);
          return json(res, 200, {
            connectedAt: new Date(conn.connectedAt).toISOString(),
            identity: { sourceIp: conn.sourceIp, userAgent: conn.userAgent },
            lastActiveAt: new Date(conn.lastActiveAt).toISOString(),
          });
        }
        default:
          return failure(res, 405, 'MethodNotAllowed', 'method not allowed');
      }
    } catch (err) {
      opts.logger.error({ err: String(err) }, 'management api failed');
      if (!res.headersSent) failure(res, 500, 'InternalFailure', 'internal error');
    }
  };

  async function handleInvoke(req: IncomingMessage, res: ServerResponse, name: string) {
    if (name !== opts.wsFunctionName) {
      return failure(res, 404, 'ResourceNotFoundException', `Function not found: ${name}`);
    }
    const body = await readBody(req, 6 * 1024 * 1024);
    let payload: unknown;
    try {
      payload = body === null || body.length === 0 ? {} : JSON.parse(body.toString('utf8'));
    } catch {
      return failure(res, 400, 'InvalidRequestContentException', 'payload is not JSON');
    }
    const asynchronous = req.headers['x-amz-invocation-type'] === 'Event';
    const run = opts.invokeWs(payload);
    if (asynchronous) {
      run.catch((err: unknown) => {
        opts.logger.error({ err: String(err) }, 'async invocation failed');
      });
      res.writeHead(202, { 'Content-Length': 0 });
      return void res.end();
    }
    return json(res, 200, (await run) ?? null);
  }
}
