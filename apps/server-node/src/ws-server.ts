import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { nanoid } from 'nanoid';
import { WebSocketServer } from 'ws';
import type { RawData, WebSocket } from 'ws';
import type { ErrorCode } from '@zqhoot/protocol';
import { CLOSE_CODES } from '@zqhoot/service';
import type { Clock, GameService, Logger } from '@zqhoot/service';
import { clientIp } from './client-ip.ts';
import { rawPath } from './request-path.ts';
import { TokenBucket } from './token-bucket.ts';
import type { WsTransport } from './ws-transport.ts';

export const WS_PATH = '/ws';
/** ADR-0007: the service enforces 4 KB; this is the transport cap. */
export const WS_MAX_PAYLOAD_BYTES = 8192;
export const WS_RATE_PER_SECOND = 10;
export const WS_RATE_BURST = 20;
export const WS_PING_INTERVAL_MS = 30_000;
const GOING_AWAY = 1001;
const TERMINATE_WAIT_MS = 1000;

export interface WebSocketRuntimeOptions {
  server: Server;
  service: GameService;
  transport: WsTransport;
  clock: Clock;
  logger: Logger;
  trustProxy: boolean;
  pingIntervalMs?: number;
}

export interface WebSocketRuntime {
  connections(): number;
  /** Refuses new upgrades, closes every socket with 1001 and waits for `onDisconnect` to finish. */
  close(graceMs: number): Promise<void>;
}

interface SocketState {
  bucket: TokenBucket;
  alive: boolean;
  limited: boolean;
  /** Frames of one connection are handled in order, as API Gateway does. */
  tail: Promise<void>;
}

async function withTimeout(work: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const patience = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  await Promise.race([work, patience]);
  clearTimeout(timer);
}

/** Answers the handshake with a bare HTTP status and drops the socket. */
function refuse(socket: Duplex, status: string): void {
  socket.once('finish', () => socket.destroy());
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

const sourceIpInfo = (sourceIp: string | undefined): { sourceIp?: string } =>
  sourceIp === undefined ? {} : { sourceIp };

const textOf = (data: RawData): string =>
  Array.isArray(data)
    ? Buffer.concat(data).toString('utf8')
    : Buffer.isBuffer(data)
      ? data.toString('utf8')
      : Buffer.from(data).toString('utf8');

/**
 * Attaches the `/ws` endpoint to `server`. Only the network is handled here; every decision about a
 * message belongs to `GameService`.
 */
export function attachWebSocketServer(opts: WebSocketRuntimeOptions): WebSocketRuntime {
  const { server, service, transport, clock, logger } = opts;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: WS_MAX_PAYLOAD_BYTES,
    perMessageDeflate: false,
  });
  const states = new WeakMap<WebSocket, SocketState>();
  const disconnects = new Set<Promise<void>>();
  let closing = false;

  const sweep = setInterval(() => {
    for (const socket of wss.clients) {
      const state = states.get(socket);
      if (state === undefined || !state.alive) {
        socket.terminate();
        continue;
      }
      state.alive = false;
      try {
        socket.ping();
      } catch {
        socket.terminate();
      }
    }
  }, opts.pingIntervalMs ?? WS_PING_INTERVAL_MS);
  sweep.unref();

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    upgrade(req, socket, head).catch((err: unknown) => {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'upgrade failed');
      socket.destroy();
    });
  });

  async function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    // The handshake is answered asynchronously, so an early reset must not become an uncaught error.
    socket.on('error', () => undefined);
    if (rawPath(req.url) !== WS_PATH) {
      socket.destroy();
      return;
    }
    if (closing) {
      refuse(socket, '503 Service Unavailable');
      return;
    }
    const connectionId = nanoid();
    const sourceIp = clientIp(req, opts.trustProxy);
    const { accept } = await service.onConnect(connectionId, {
      ...(req.headers.origin !== undefined && { origin: req.headers.origin }),
      ...(sourceIp !== undefined && { sourceIp }),
    });
    if (!accept) {
      refuse(socket, '403 Forbidden');
      return;
    }
    if (socket.destroyed) return;
    wss.handleUpgrade(req, socket, head, (ws) => connected(ws, connectionId, sourceIp));
  }

  async function sendError(connectionId: string, code: ErrorCode, message: string): Promise<void> {
    try {
      await transport.send([{ connectionId, message: { type: 'error', code, message } }]);
    } catch (err) {
      logger.error(
        { connectionId, err: err instanceof Error ? err.message : String(err) },
        'send failed',
      );
    }
  }

  function connected(ws: WebSocket, connectionId: string, sourceIp: string | undefined): void {
    const state: SocketState = {
      bucket: new TokenBucket(WS_RATE_PER_SECOND, WS_RATE_BURST, clock.now()),
      alive: true,
      limited: false,
      tail: Promise.resolve(),
    };
    states.set(ws, state);
    transport.register(connectionId, ws);
    logger.debug({ connectionId, sourceIp }, 'websocket connected');

    const enqueue = (work: () => Promise<void>): Promise<void> => {
      state.tail = state.tail.then(work).catch((err: unknown) => {
        logger.error(
          { connectionId, err: err instanceof Error ? err.message : String(err) },
          'websocket handler failed',
        );
      });
      return state.tail;
    };

    ws.on('pong', () => {
      state.alive = true;
    });
    // `ws` reports protocol violations (an oversize frame, invalid UTF-8) here and then closes.
    ws.on('error', (err) => logger.debug({ connectionId, err: err.message }, 'websocket error'));

    ws.on('message', (data, isBinary) => {
      const receivedAt = clock.now();
      if (state.limited) return;
      if (!state.bucket.take(receivedAt)) {
        state.limited = true;
        logger.warn({ connectionId, sourceIp }, 'websocket message rate exceeded');
        void sendError(connectionId, 'rate-limited', 'too many messages').then(() =>
          transport.close(connectionId, CLOSE_CODES.policyViolation, 'rate-limited'),
        );
        return;
      }
      if (isBinary) {
        void sendError(connectionId, 'bad-request', 'text frames only');
        return;
      }
      const text = textOf(data);
      void enqueue(() => service.onMessage(connectionId, text, receivedAt, sourceIpInfo(sourceIp)));
    });

    ws.on('close', (code) => {
      logger.debug({ connectionId, code }, 'websocket closed');
      transport.unregister(connectionId);
      const done = enqueue(() => service.onDisconnect(connectionId)).finally(() => {
        disconnects.delete(done);
      });
      disconnects.add(done);
    });
  }

  /** Resolves once every socket has fired `close` (and `wss.clients` no longer lists it). */
  function untilEmpty(): Promise<void> {
    return new Promise<void>((resolve) => {
      const check = (): void => {
        if (wss.clients.size === 0) resolve();
      };
      for (const socket of wss.clients) socket.once('close', check);
      check();
    });
  }

  return {
    connections: () => wss.clients.size,
    async close(graceMs) {
      closing = true;
      clearInterval(sweep);
      const drained = untilEmpty();
      for (const socket of wss.clients) {
        try {
          socket.close(GOING_AWAY, 'server shutting down');
        } catch {
          socket.terminate();
        }
      }
      await withTimeout(drained, graceMs);
      // A peer that never answers the close frame is cut off.
      const rest = untilEmpty();
      for (const socket of wss.clients) socket.terminate();
      await withTimeout(rest, TERMINATE_WAIT_MS);
      await Promise.all([...disconnects]);
      wss.close();
    },
  };
}
