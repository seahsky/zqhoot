import type { ErrorCode, OutboundMessage, RosterEntry } from '@zqhoot/protocol';
import type { ConnectionRecord, PlayerMessage, PlayerRecord } from '@zqhoot/engine';
import type { Store } from '@zqhoot/store';
import type { Logger, Transport } from './ports.ts';

export type Outbound = { connectionId: string; message: OutboundMessage };

export interface Audience {
  all: ConnectionRecord[];
  hosts: ConnectionRecord[];
  /** Connections per player; a player can hold several (a second tab, a reconnect racing a stale socket). */
  players: Map<string, ConnectionRecord[]>;
}

export const describeError = (err: unknown): { message: string; stack?: string } =>
  err instanceof Error
    ? { message: err.message, ...(err.stack !== undefined ? { stack: err.stack } : {}) }
    : { message: String(err) };

/**
 * Everything that leaves the service: batching, the gone-connection rules (ADR-0007) and the
 * roster updates hosts get when players come and go.
 */
export class Delivery {
  readonly #store: Store;
  readonly #transport: Transport;
  readonly #log: Logger;

  constructor(store: Store, transport: Transport, log: Logger) {
    this.#store = store;
    this.#transport = transport;
    this.#log = log;
  }

  /** One `listConnections` per broadcast (ADR-0007). */
  async audience(sessionId: string): Promise<Audience> {
    const all = await this.#store.listConnections(sessionId);
    const hosts: ConnectionRecord[] = [];
    const players = new Map<string, ConnectionRecord[]>();
    for (const conn of all) {
      if (conn.role === 'host') hosts.push(conn);
      else if (conn.playerId !== undefined) {
        const list = players.get(conn.playerId);
        if (list === undefined) players.set(conn.playerId, [conn]);
        else list.push(conn);
      }
    }
    return { all, hosts, players };
  }

  /**
   * Sends one batch and applies the gone-connection rules. `known` are the connection records the
   * caller has, used to tell which players lost their last connection; `announce` false skips the
   * roster update (used for the roster update itself and for kicks). Returns the gone ids.
   */
  async deliver(
    batch: Outbound[],
    known: ConnectionRecord[] = [],
    announce = true,
  ): Promise<Set<string>> {
    if (batch.length === 0) return new Set();
    const { gone } = await this.#transport.send(batch);
    if (gone.length > 0) await this.#handleGone(gone, known, announce);
    return new Set(gone);
  }

  /** Cleanup after the send: failures here are logged, never raised into the caller's flow. */
  async #handleGone(gone: string[], known: ConnectionRecord[], announce: boolean): Promise<void> {
    try {
      await Promise.all(gone.map((id) => this.#store.deleteConnection(id)));
      if (!announce) return;
      const goneIds = new Set(gone);
      const droppedBySession = new Map<string, Set<string>>();
      for (const conn of known) {
        if (!goneIds.has(conn.connectionId) || conn.role !== 'player') continue;
        if (conn.playerId === undefined) continue;
        const set = droppedBySession.get(conn.sessionId) ?? new Set<string>();
        set.add(conn.playerId);
        droppedBySession.set(conn.sessionId, set);
      }
      for (const [sessionId, playerIds] of droppedBySession) {
        await this.announceDisconnects(sessionId, [...playerIds]);
      }
    } catch (err) {
      this.#log.warn(
        { gone: gone.length, err: describeError(err) },
        'gone-connection cleanup failed',
      );
    }
  }

  /** Returns false when the connection turned out to be gone. */
  async send(
    connectionId: string,
    message: OutboundMessage,
    known: ConnectionRecord[] = [],
  ): Promise<boolean> {
    const gone = await this.deliver([{ connectionId, message }], known);
    return !gone.has(connectionId);
  }

  error(
    connectionId: string,
    code: ErrorCode,
    message: string,
    ref?: string,
    known: ConnectionRecord[] = [],
  ): Promise<boolean> {
    return this.send(
      connectionId,
      { type: 'error', code, message, ...(ref !== undefined ? { ref } : {}) },
      known,
    );
  }

  async close(connectionId: string, code: number, reason: string): Promise<void> {
    try {
      await this.#transport.close(connectionId, code, reason);
    } catch (err) {
      this.#log.warn({ connectionId, err: describeError(err) }, 'closing a connection failed');
    }
  }

  /** Hosts first (a handful of messages), then players. */
  async fanOut(
    aud: Audience,
    what: {
      hosts?: OutboundMessage;
      everyPlayer?: OutboundMessage;
      perPlayer?: PlayerMessage[];
    },
  ): Promise<void> {
    const batch: Outbound[] = [];
    if (what.hosts !== undefined) {
      for (const host of aud.hosts) {
        batch.push({ connectionId: host.connectionId, message: what.hosts });
      }
    }
    if (what.everyPlayer !== undefined) {
      for (const conns of aud.players.values()) {
        for (const conn of conns) {
          batch.push({ connectionId: conn.connectionId, message: what.everyPlayer });
        }
      }
    }
    for (const { playerId, message } of what.perPlayer ?? []) {
      for (const conn of aud.players.get(playerId) ?? []) {
        batch.push({ connectionId: conn.connectionId, message });
      }
    }
    await this.deliver(batch, aud.all);
  }

  async announceConnected(player: PlayerRecord): Promise<void> {
    const aud = await this.audience(player.sessionId);
    const entry: RosterEntry = {
      playerId: player.playerId,
      nickname: player.nickname,
      connected: true,
    };
    await this.fanOut(aud, { hosts: { type: 'roster', upsert: [entry], removed: [] } });
  }

  /** Tells hosts about players that no longer hold any connection. Call after the records are deleted. */
  async announceDisconnects(sessionId: string, playerIds: string[]): Promise<void> {
    const aud = await this.audience(sessionId);
    if (aud.hosts.length === 0) return;
    const dropped = playerIds.filter((id) => !aud.players.has(id));
    if (dropped.length === 0) return;
    const players = await Promise.all(dropped.map((id) => this.#store.getPlayer(sessionId, id)));
    const upsert: RosterEntry[] = [];
    for (const player of players) {
      // A kicked player was already removed from the roster; an upsert would bring them back.
      if (player === null || player.kicked) continue;
      upsert.push({ playerId: player.playerId, nickname: player.nickname, connected: false });
    }
    if (upsert.length === 0) return;
    const message: OutboundMessage = { type: 'roster', upsert, removed: [] };
    await this.deliver(
      aud.hosts.map((h) => ({ connectionId: h.connectionId, message })),
      aud.all,
      false,
    );
  }
}
