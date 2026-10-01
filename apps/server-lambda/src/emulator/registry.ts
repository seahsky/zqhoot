import type { WebSocket } from 'ws';

export interface GatewayConnection {
  id: string;
  socket: WebSocket;
  sourceIp: string;
  userAgent: string;
  connectedAt: number;
  lastActiveAt: number;
  /** Set as soon as a close starts, so the management API answers 410 from then on. */
  closing: boolean;
  /** Tail of this connection's invocations: API Gateway never overlaps them. */
  queue: Promise<void>;
}

export class ConnectionRegistry {
  readonly #connections = new Map<string, GatewayConnection>();

  get size(): number {
    return this.#connections.size;
  }
  get(id: string): GatewayConnection | undefined {
    return this.#connections.get(id);
  }
  add(conn: GatewayConnection): void {
    this.#connections.set(conn.id, conn);
  }
  remove(id: string): void {
    this.#connections.delete(id);
  }
  all(): IterableIterator<GatewayConnection> {
    return this.#connections.values();
  }
}

export interface EmulatorStats {
  invocations: { connect: number; message: number; disconnect: number; warmup: number };
  /** Concurrent invocations right now, and the highest seen. */
  inFlight: number;
  maxInFlight: number;
  /** Must stay 1: the gateway serialises invocations per connection. */
  maxInFlightPerConnection: number;
}

export const createStats = (): EmulatorStats => ({
  invocations: { connect: 0, message: 0, disconnect: 0, warmup: 0 },
  inFlight: 0,
  maxInFlight: 0,
  maxInFlightPerConnection: 0,
});
