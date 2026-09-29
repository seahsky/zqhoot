import {
  DeleteConnectionCommand,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import type { OutboundMessage } from '@zqhoot/protocol';
import { noopLogger, stampAndSerialize } from '@zqhoot/service';
import type { Clock, Logger, Transport } from '@zqhoot/service';

/** The one method of `ApiGatewayManagementApiClient` used here, so tests can stub it. */
export interface ManagementApiClient {
  send(command: PostToConnectionCommand | DeleteConnectionCommand): Promise<unknown>;
}

export interface ApiGatewayTransportOptions {
  client: ManagementApiClient;
  clock: Clock;
  logger?: Logger;
  /** Concurrent `PostToConnection` calls (ADR-0007). */
  concurrency?: number;
}

export const POST_CONCURRENCY = 50;

const encoder = new TextEncoder();

function isGone(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { name, $metadata } = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return name === 'GoneException' || $metadata?.httpStatusCode === 410;
}

const describe = (error: unknown): { name?: string; message: string } =>
  error instanceof Error
    ? { name: error.name, message: error.message }
    : { message: String(error) };

/**
 * `Transport` over API Gateway's management API (ADR-0007). The invocation that handles a command
 * does its own fan-out: a pool of `concurrency` calls, all awaited before `send` returns, because
 * Lambda freezes anything still pending when the handler returns.
 */
export class ApiGatewayTransport implements Transport {
  readonly #client: ManagementApiClient;
  readonly #clock: Clock;
  readonly #log: Logger;
  readonly #concurrency: number;

  constructor(opts: ApiGatewayTransportOptions) {
    this.#client = opts.client;
    this.#clock = opts.clock;
    this.#log = opts.logger ?? noopLogger;
    this.#concurrency = opts.concurrency ?? POST_CONCURRENCY;
  }

  async send(
    batch: Array<{ connectionId: string; message: OutboundMessage }>,
  ): Promise<{ gone: string[] }> {
    const gone = new Set<string>();
    let next = 0;
    const worker = async (): Promise<void> => {
      for (let item = batch[next++]; item !== undefined; item = batch[next++]) {
        if (!(await this.#post(item.connectionId, item.message))) gone.add(item.connectionId);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.#concurrency, batch.length) }, worker));
    return { gone: [...gone] };
  }

  async close(connectionId: string): Promise<void> {
    try {
      await this.#client.send(new DeleteConnectionCommand({ ConnectionId: connectionId }));
    } catch (error) {
      if (!isGone(error)) throw error;
    }
  }

  /** Resolves false when the connection is gone. Never rejects. */
  async #post(connectionId: string, message: OutboundMessage): Promise<boolean> {
    try {
      // Stamped after any wait for a free slot, so `ts` is as close to the wire as we can get it.
      const data = encoder.encode(stampAndSerialize(message, this.#clock.now()));
      await this.#client.send(
        new PostToConnectionCommand({ ConnectionId: connectionId, Data: data }),
      );
      return true;
    } catch (error) {
      if (isGone(error)) return false;
      // Level-triggered state lets the client catch up on its next message or reconnect.
      this.#log.warn({ connectionId, type: message.type, err: describe(error) }, 'post failed');
      return true;
    }
  }
}
