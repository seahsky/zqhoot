import { WebSocket } from 'ws';
import type { OutboundMessage } from '@zqhoot/protocol';
import { prepareStamped } from '@zqhoot/service';
import type { Clock, Logger, Transport } from '@zqhoot/service';

/** ADR-0007: above this a socket is skipped for state messages, since state is level-triggered. */
export const SKIP_STATE_ABOVE_BYTES = 256 * 1024;
/** Above this the client is too far behind; it reconnects and resumes. */
export const TERMINATE_ABOVE_BYTES = 1024 * 1024;

/**
 * Never dropped for a slow socket: replies to the peer's own request, the message before a close,
 * and `roster`, which is a delta (upsert/removed) rather than level-triggered state, so a skipped
 * one would leave the host's roster wrong until the next `host.state`.
 */
const DIRECT: ReadonlySet<OutboundMessage['type']> = new Set([
  'welcome',
  'error',
  'pong',
  'answer.ack',
  'stats',
  'kicked',
  'roster',
]);

/** The subset of `ws.WebSocket` the transport uses. */
export type TransportSocket = Pick<
  WebSocket,
  'readyState' | 'bufferedAmount' | 'send' | 'close' | 'terminate'
>;

/** `Transport` over the in-process `ws` sockets (ADR-0007). */
export class WsTransport implements Transport {
  readonly #sockets = new Map<string, TransportSocket>();
  readonly #clock: Clock;
  readonly #log: Logger;

  constructor(clock: Clock, log: Logger) {
    this.#clock = clock;
    this.#log = log;
  }

  register(connectionId: string, socket: TransportSocket): void {
    this.#sockets.set(connectionId, socket);
  }

  unregister(connectionId: string): void {
    this.#sockets.delete(connectionId);
  }

  async send(
    batch: Array<{ connectionId: string; message: OutboundMessage }>,
  ): Promise<{ gone: string[] }> {
    const gone: string[] = [];
    // A broadcast passes one message object to many connections: serialise it once.
    const prepared = new Map<OutboundMessage, (ts: number) => string>();
    for (const { connectionId, message } of batch) {
      const socket = this.#sockets.get(connectionId);
      if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
        gone.push(connectionId);
        continue;
      }
      const buffered = socket.bufferedAmount;
      if (buffered > TERMINATE_ABOVE_BYTES) {
        this.#log.warn({ connectionId, buffered }, 'terminating a socket that cannot keep up');
        socket.terminate();
        gone.push(connectionId);
        continue;
      }
      if (buffered > SKIP_STATE_ABOVE_BYTES && !DIRECT.has(message.type)) {
        this.#log.debug({ connectionId, buffered, type: message.type }, 'skipped a slow socket');
        continue;
      }
      let stamp = prepared.get(message);
      if (stamp === undefined) {
        stamp = prepareStamped(message);
        prepared.set(message, stamp);
      }
      try {
        // `ts` is read per recipient, as late as possible (ADR-0005). The callback only logs: a
        // failed write ends in the socket's own `close`, which runs `onDisconnect`.
        socket.send(stamp(this.#clock.now()), { binary: false }, (err) => {
          // `ws` passes `null` on success although its typings say `undefined`.
          if (err) {
            this.#log.debug({ connectionId, err: err.message }, 'websocket send failed');
          }
        });
      } catch {
        gone.push(connectionId);
      }
    }
    return { gone };
  }

  async close(connectionId: string, code?: number, reason?: string): Promise<void> {
    const socket = this.#sockets.get(connectionId);
    if (socket === undefined) return;
    try {
      socket.close(code ?? 1000, reason);
    } catch {
      // An invalid code or an over-long reason: the socket must still go.
      socket.terminate();
    }
  }
}
