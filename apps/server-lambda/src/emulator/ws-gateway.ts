import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import type { RawData } from 'ws';
import type { Logger } from '@zqhoot/service';
import type { ConnectionRegistry, EmulatorStats, GatewayConnection } from './registry.ts';

/** API Gateway's frame limit for WebSocket APIs. */
const MAX_FRAME_BYTES = 32 * 1024;

type RouteKey = '$connect' | '$default' | '$disconnect';
const STAT_KEY = { $connect: 'connect', $default: 'message', $disconnect: 'disconnect' } as const;

export interface WebSocketEventShape {
  headers?: Record<string, string>;
  multiValueHeaders?: Record<string, string[]>;
  queryStringParameters?: Record<string, string>;
  requestContext: {
    routeKey: RouteKey;
    eventType: 'CONNECT' | 'MESSAGE' | 'DISCONNECT';
    connectionId: string;
    requestTimeEpoch: number;
    [key: string]: unknown;
  };
  body?: string;
  isBase64Encoded: boolean;
}

export type WsInvoker = (
  event: WebSocketEventShape,
) => Promise<{ statusCode?: number } | undefined>;

/** Looks like a real API Gateway id: 15 URL-safe base64 characters and a trailing `=`. */
const newConnectionId = (): string => `${randomBytes(11).toString('base64url')}=`;
const hex = (bytes: number): string => randomBytes(bytes).toString('hex');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function requestTime(epoch: number): string {
  const d = new Date(epoch);
  const two = (n: number): string => String(n).padStart(2, '0');
  const date = `${two(d.getUTCDate())}/${MONTHS[d.getUTCMonth()]}/${d.getUTCFullYear()}`;
  return `${date}:${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} +0000`;
}

/** `rawHeaders` keeps the client's letter case, as API Gateway does. */
function headersOf(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i] as string;
    const value = req.rawHeaders[i + 1] as string;
    headers[name] = headers[name] === undefined ? value : `${headers[name]},${value}`;
  }
  return headers;
}

export const cleanIp = (address: string | undefined): string =>
  (address ?? 'unknown').replace(/^::ffff:/, '');

export interface WebSocketGatewayOptions {
  registry: ConnectionRegistry;
  /** Calls the built ws handler with an API Gateway event. */
  invoke: WsInvoker;
  stats: EmulatorStats;
  stage: string;
  /** Host and port the client is told to use, for `domainName`. */
  domainName: string;
  logger: Logger;
}

/**
 * The WebSocket half of API Gateway: accepts sockets, runs `$connect` before the upgrade completes
 * and turns each frame and close into a Lambda invocation, one at a time per connection.
 */
export class WebSocketGateway {
  readonly #opts: WebSocketGatewayOptions;
  readonly #wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: false,
  });
  readonly #apiId = hex(5);
  readonly #inFlightByConnection = new Map<string, number>();

  constructor(opts: WebSocketGatewayOptions) {
    this.#opts = opts;
  }

  /** Listener for the HTTP server's `upgrade` event. */
  async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const id = newConnectionId();
    const connectedAt = Date.now();
    const sourceIp = cleanIp(req.socket.remoteAddress);
    const query = Object.fromEntries(new URL(req.url ?? '/', 'http://emulator').searchParams);

    // Node drops its own error handler when it hands over an upgrade; a client that aborts while
    // `$connect` runs would otherwise crash the process with an unhandled 'error'.
    const ignoreSocketError = (): void => {};
    socket.on('error', ignoreSocketError);

    let status: number;
    try {
      const result = await this.#run(
        this.#event('$connect', id, connectedAt, sourceIp, {
          headers: headersOf(req),
          ...(Object.keys(query).length > 0 ? { queryStringParameters: query } : {}),
        }),
      );
      status = result?.statusCode ?? 200;
    } catch (err) {
      this.#opts.logger.error({ connectionId: id, err: String(err) }, '$connect failed');
      status = 500;
    }
    if (status !== 200 || socket.destroyed) {
      if (!socket.destroyed) {
        const code = status >= 400 && status < 600 ? status : 500;
        socket.write(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      }
      socket.destroy();
      return;
    }

    socket.off('error', ignoreSocketError);
    this.#wss.handleUpgrade(req, socket, head, (ws) => {
      const conn: GatewayConnection = {
        id,
        socket: ws,
        sourceIp,
        userAgent: req.headers['user-agent'] ?? '',
        connectedAt,
        lastActiveAt: connectedAt,
        closing: false,
        queue: Promise.resolve(),
      };
      this.#opts.registry.add(conn);
      ws.on('message', (data, isBinary) => this.#onFrame(conn, data, isBinary));
      ws.on('close', () => this.#onClose(conn));
      ws.on('error', (err) => {
        this.#opts.logger.debug({ connectionId: id, err: String(err) }, 'socket error');
      });
    });
  }

  /**
   * Closes every socket with 1001 and resolves once each one's `$disconnect` invocation has run.
   * A client that ignores the close is terminated after `timeoutMs`.
   */
  async closeAll(timeoutMs = 5000): Promise<void> {
    const conns = [...this.#opts.registry.all()];
    // Registered after the gateway's own 'close' handler, so by the time these resolve the
    // `$disconnect` is already queued and `conn.queue` includes it.
    const closed = conns.map(
      (conn) => new Promise<void>((resolve) => conn.socket.once('close', () => resolve())),
    );
    for (const conn of conns) {
      conn.closing = true;
      conn.socket.close(1001);
    }
    const timer = setTimeout(() => conns.forEach((conn) => conn.socket.terminate()), timeoutMs);
    await Promise.all(closed);
    clearTimeout(timer);
    await Promise.all(conns.map((conn) => conn.queue));
    this.#wss.close();
  }

  #onFrame(conn: GatewayConnection, data: RawData, isBinary: boolean): void {
    // Taken on arrival, not when the invocation starts: behind a slow earlier invocation the frame
    // has still arrived now, and this is the time answers are scored on (ADR-0005).
    const receivedAt = Date.now();
    conn.lastActiveAt = receivedAt;
    const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
    this.#enqueue(
      conn,
      this.#event('$default', conn.id, conn.connectedAt, conn.sourceIp, {
        body: isBinary ? buffer.toString('base64') : buffer.toString('utf8'),
        isBase64Encoded: isBinary,
        requestTimeEpoch: receivedAt,
      }),
    );
  }

  #onClose(conn: GatewayConnection): void {
    conn.closing = true;
    this.#opts.registry.remove(conn.id);
    this.#enqueue(conn, this.#event('$disconnect', conn.id, conn.connectedAt, conn.sourceIp, {}));
  }

  /** Runs after the connection's earlier invocations; failures are logged, never propagated. */
  #enqueue(conn: GatewayConnection, event: WebSocketEventShape): void {
    conn.queue = conn.queue.then(async () => {
      try {
        await this.#run(event);
      } catch (err) {
        this.#opts.logger.error(
          { connectionId: conn.id, route: event.requestContext.routeKey, err: String(err) },
          'invocation failed',
        );
      }
    });
  }

  async #run(event: WebSocketEventShape) {
    const { stats } = this.#opts;
    const id = event.requestContext.connectionId;
    const mine = (this.#inFlightByConnection.get(id) ?? 0) + 1;
    this.#inFlightByConnection.set(id, mine);
    stats.invocations[STAT_KEY[event.requestContext.routeKey]]++;
    stats.inFlight++;
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    stats.maxInFlightPerConnection = Math.max(stats.maxInFlightPerConnection, mine);
    try {
      return await this.#opts.invoke(event);
    } finally {
      stats.inFlight--;
      const left = (this.#inFlightByConnection.get(id) ?? 1) - 1;
      if (left === 0) this.#inFlightByConnection.delete(id);
      else this.#inFlightByConnection.set(id, left);
    }
  }

  #event(
    routeKey: RouteKey,
    connectionId: string,
    connectedAt: number,
    sourceIp: string,
    extra: {
      headers?: Record<string, string>;
      queryStringParameters?: Record<string, string>;
      body?: string;
      isBase64Encoded?: boolean;
      requestTimeEpoch?: number;
    },
  ): WebSocketEventShape {
    const requestTimeEpoch = extra.requestTimeEpoch ?? Date.now();
    const eventType = { $connect: 'CONNECT', $default: 'MESSAGE', $disconnect: 'DISCONNECT' }[
      routeKey
    ] as WebSocketEventShape['requestContext']['eventType'];
    return {
      ...(extra.headers !== undefined
        ? {
            headers: extra.headers,
            multiValueHeaders: Object.fromEntries(
              Object.entries(extra.headers).map(([name, value]) => [name, value.split(',')]),
            ),
          }
        : {}),
      ...(extra.queryStringParameters !== undefined
        ? { queryStringParameters: extra.queryStringParameters }
        : {}),
      requestContext: {
        routeKey,
        eventType,
        extendedRequestId: hex(8),
        requestTime: requestTime(requestTimeEpoch),
        messageDirection: 'IN',
        stage: this.#opts.stage,
        connectedAt,
        requestTimeEpoch,
        identity: { sourceIp },
        requestId: hex(8),
        domainName: this.#opts.domainName,
        connectionId,
        apiId: this.#apiId,
        ...(routeKey === '$default' ? { messageId: hex(8) } : {}),
      },
      ...(extra.body !== undefined ? { body: extra.body } : {}),
      isBase64Encoded: extra.isBase64Encoded ?? false,
    };
  }
}
