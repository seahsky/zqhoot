import type {
  ConnectionRecord,
  PlayerRecord,
  QuizSnapshot,
  ResponseRecord,
  Scoreboard,
  SessionMeta,
  StoredQuestionResult,
} from '@zqhoot/engine';
import type { ModerationStatus, Quiz, QuizSummary, SessionSummary } from '@zqhoot/protocol';
import { NotFoundError } from './errors.ts';
import { parseResponseId } from './keys.ts';
import {
  ConflictError,
  type AddPlayerResult,
  type PutResponseResult,
  type Store,
} from './store.ts';

export interface MemoryStoreOptions {
  /** Epoch-millisecond clock. Injected by tests; defaults to `Date.now`. */
  now?: () => number;
}

/** A record with the absolute time (epoch ms) at which it stops existing. */
interface Stamped<T> {
  expiresAt: number;
  value: T;
}

/**
 * Everything the store keeps for one session. Dependent records may exist without a META
 * record (DynamoDB does not enforce that either), so the bucket is created on first write.
 */
interface Bucket {
  meta?: Stamped<SessionMeta>;
  snapshot?: Stamped<QuizSnapshot>;
  players: Map<string, Stamped<PlayerRecord>>;
  /** nicknameKey -> playerId */
  nicknames: Map<string, Stamped<string>>;
  connections: Map<string, Stamped<ConnectionRecord>>;
  /** questionIndex -> playerId -> slot */
  responses: Map<number, Map<string, Map<number, Stamped<ResponseRecord>>>>;
  results: Map<number, Stamped<StoredQuestionResult>>;
  scoreboard?: Stamped<Scoreboard>;
}

interface RateWindow {
  key: string;
  windowStart: number;
  count: number;
  expiresAt: number;
}

/** Serialised form produced by `toJSON` and consumed by `fromJSON` (also the state file). */
export interface MemoryStoreData {
  format: 1;
  quizzes: Quiz[];
  pins: Array<{ pin: string; sessionId: string; expiresAt: number }>;
  sessions: Array<{
    sessionId: string;
    meta?: Stamped<SessionMeta>;
    snapshot?: Stamped<QuizSnapshot>;
    players: Array<Stamped<PlayerRecord>>;
    nicknames: Array<{ nicknameKey: string; playerId: string; expiresAt: number }>;
    connections: Array<Stamped<ConnectionRecord>>;
    responses: Array<Stamped<ResponseRecord>>;
    results: Array<Stamped<StoredQuestionResult>>;
    scoreboard?: Stamped<Scoreboard>;
  }>;
  rateLimits: RateWindow[];
}

const mutationListeners = new WeakMap<MemoryStore, Set<() => void>>();

/** Package-internal (not re-exported from index.ts): lets persistence learn about writes. */
export function onMutation(store: MemoryStore, listener: () => void): () => void {
  let set = mutationListeners.get(store);
  if (!set) {
    set = new Set();
    mutationListeners.set(store, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

/** Set by the static block of `MemoryStore`, the only code that can reach its private state. */
let readState: (store: MemoryStore) => MemoryStoreData;

/**
 * Package-internal: the state as JSON text. Stringifying already yields an independent copy, so
 * unlike `toJSON()` this skips the deep clone, one whole pass less on the event loop per save.
 */
export function serializeState(store: MemoryStore): string {
  return JSON.stringify(readState(store));
}

const copy = <T>(value: T): T => structuredClone(value);
const compare = (a: string | number, b: string | number): number => (a < b ? -1 : a > b ? 1 : 0);

function newBucket(): Bucket {
  return {
    players: new Map(),
    nicknames: new Map(),
    connections: new Map(),
    responses: new Map(),
    results: new Map(),
  };
}

/**
 * In-memory `Store` for the single-VM target and for tests. Every method is synchronous inside
 * (so conditional operations are trivially atomic) and returns a promise only to fit the contract.
 * Records are deep-copied on write and on read.
 */
export class MemoryStore implements Store {
  readonly #now: () => number;
  readonly #quizzes = new Map<string, Map<string, Quiz>>();
  readonly #pins = new Map<string, Stamped<string>>();
  readonly #sessions = new Map<string, Bucket>();
  readonly #connectionSession = new Map<string, string>();
  readonly #rateWindows = new Map<string, RateWindow>();

  static {
    readState = (store) => store.#state();
  }

  constructor(opts: MemoryStoreOptions = {}) {
    this.#now = opts.now ?? Date.now;
  }

  static fromJSON(data: MemoryStoreData, opts: MemoryStoreOptions = {}): MemoryStore {
    if (data?.format !== 1) throw new Error('unsupported MemoryStore data format');
    const store = new MemoryStore(opts);
    const d = copy(data);
    for (const quiz of d.quizzes) store.#quizMap(quiz.ownerId).set(quiz.id, quiz);
    for (const p of d.pins) store.#pins.set(p.pin, { expiresAt: p.expiresAt, value: p.sessionId });
    for (const s of d.sessions) {
      const b = newBucket();
      b.meta = s.meta;
      b.snapshot = s.snapshot;
      b.scoreboard = s.scoreboard;
      for (const p of s.players) b.players.set(p.value.playerId, p);
      for (const n of s.nicknames) {
        b.nicknames.set(n.nicknameKey, { expiresAt: n.expiresAt, value: n.playerId });
      }
      for (const c of s.connections) {
        b.connections.set(c.value.connectionId, c);
        store.#connectionSession.set(c.value.connectionId, s.sessionId);
      }
      for (const r of s.responses) store.#responseSlots(b, r.value).set(r.value.slot, r);
      for (const r of s.results) b.results.set(r.value.questionIndex, r);
      store.#sessions.set(s.sessionId, b);
    }
    for (const w of d.rateLimits) store.#rateWindows.set(`${w.windowStart}#${w.key}`, w);
    return store;
  }

  toJSON(): MemoryStoreData {
    return copy(this.#state());
  }

  /** The serialisable state, sharing objects with the store: read it, never keep it. */
  #state(): MemoryStoreData {
    return {
      format: 1,
      quizzes: [...this.#quizzes.values()].flatMap((byId) => [...byId.values()]),
      pins: [...this.#pins].map(([pin, e]) => ({
        pin,
        sessionId: e.value,
        expiresAt: e.expiresAt,
      })),
      sessions: [...this.#sessions].map(([sessionId, b]) => ({
        sessionId,
        ...(b.meta && { meta: b.meta }),
        ...(b.snapshot && { snapshot: b.snapshot }),
        players: [...b.players.values()],
        nicknames: [...b.nicknames].map(([nicknameKey, e]) => ({
          nicknameKey,
          playerId: e.value,
          expiresAt: e.expiresAt,
        })),
        connections: [...b.connections.values()],
        responses: [...b.responses.values()].flatMap((byPlayer) =>
          [...byPlayer.values()].flatMap((bySlot) => [...bySlot.values()]),
        ),
        results: [...b.results.values()],
        ...(b.scoreboard && { scoreboard: b.scoreboard }),
      })),
      rateLimits: [...this.#rateWindows.values()],
    };
  }

  /**
   * Deletes expired sessions together with everything that depends on them, and any other
   * record whose own expiry has passed. Reads already hide expired records; this frees memory.
   * The hosting process is expected to call it periodically (ADR-0003 suggests once a minute).
   */
  sweepExpired(): void {
    const t = this.#now();
    let removed = false;
    const sweptSessions = new Set<string>();
    for (const [sessionId, b] of this.#sessions) {
      if (b.meta && b.meta.expiresAt <= t) {
        sweptSessions.add(sessionId);
        this.#dropSession(sessionId, b);
        removed = true;
        continue;
      }
      if (this.#pruneBucket(b, t)) removed = true;
      if (!b.meta && !b.snapshot && !b.scoreboard && this.#isEmpty(b)) {
        this.#sessions.delete(sessionId);
      }
    }
    for (const [pin, e] of this.#pins) {
      if (e.expiresAt <= t || sweptSessions.has(e.value)) {
        this.#pins.delete(pin);
        removed = true;
      }
    }
    for (const [id, w] of this.#rateWindows) {
      if (w.expiresAt <= t) {
        this.#rateWindows.delete(id);
        removed = true;
      }
    }
    if (removed) this.#changed();
  }

  // --- Quizzes ---------------------------------------------------------------------

  async listQuizzes(ownerId: string): Promise<QuizSummary[]> {
    const quizzes = [...(this.#quizzes.get(ownerId)?.values() ?? [])];
    // Same order as DynamoStore, which sorts after reading its projection.
    quizzes.sort((a, b) => compare(b.updatedAt, a.updatedAt) || compare(a.id, b.id));
    return quizzes.map((q) => ({
      id: q.id,
      title: q.title,
      questionCount: q.questions.length,
      updatedAt: q.updatedAt,
      version: q.version,
    }));
  }

  async getQuiz(ownerId: string, quizId: string): Promise<Quiz | null> {
    const quiz = this.#quizzes.get(ownerId)?.get(quizId);
    return quiz ? copy(quiz) : null;
  }

  async putQuiz(quiz: Quiz, expectedVersion?: number): Promise<void> {
    const existing = this.#quizzes.get(quiz.ownerId)?.get(quiz.id);
    if (expectedVersion === undefined ? existing : existing?.version !== expectedVersion) {
      throw new ConflictError();
    }
    this.#quizMap(quiz.ownerId).set(quiz.id, copy(quiz));
    this.#changed();
  }

  async deleteQuiz(ownerId: string, quizId: string): Promise<void> {
    const byId = this.#quizzes.get(ownerId);
    if (!byId?.delete(quizId)) return;
    if (byId.size === 0) this.#quizzes.delete(ownerId);
    this.#changed();
  }

  // --- Sessions --------------------------------------------------------------------

  async reservePin(pin: string, sessionId: string, expiresAt: number): Promise<boolean> {
    const held = this.#live(this.#pins.get(pin));
    if (held && held.value !== sessionId) return false;
    this.#pins.set(pin, { expiresAt, value: sessionId });
    this.#changed();
    return true;
  }

  async releasePin(pin: string, sessionId: string): Promise<void> {
    if (this.#pins.get(pin)?.value !== sessionId) return;
    this.#pins.delete(pin);
    this.#changed();
  }

  async getSessionIdByPin(pin: string): Promise<string | null> {
    return this.#live(this.#pins.get(pin))?.value ?? null;
  }

  async createSession(meta: SessionMeta, snapshot: QuizSnapshot): Promise<void> {
    let b = this.#sessions.get(meta.sessionId);
    if (this.#live(b?.meta)) throw new ConflictError();
    // An expired session with this ID may still be waiting for the sweeper: do its job now.
    // Records written before META (no meta at all) are live and stay, as in DynamoStore.
    if (b?.meta) {
      this.#dropSession(meta.sessionId, b);
      b = undefined;
    }
    b ??= this.#bucket(meta.sessionId);
    b.meta = { expiresAt: meta.expiresAt, value: copy(meta) };
    b.snapshot = { expiresAt: meta.expiresAt, value: copy(snapshot) };
    this.#changed();
  }

  async getSession(sessionId: string): Promise<SessionMeta | null> {
    const e = this.#live(this.#sessions.get(sessionId)?.meta);
    return e ? copy(e.value) : null;
  }

  async updateSession(meta: SessionMeta, expectedVersion: number): Promise<void> {
    const b = this.#sessions.get(meta.sessionId);
    const current = this.#live(b?.meta);
    if (!b || current?.value.version !== expectedVersion) throw new ConflictError();
    b.meta = { expiresAt: meta.expiresAt, value: copy(meta) };
    this.#changed();
  }

  async getSnapshot(sessionId: string): Promise<QuizSnapshot | null> {
    const e = this.#live(this.#sessions.get(sessionId)?.snapshot);
    return e ? copy(e.value) : null;
  }

  async listSessionsByHost(hostId: string, limit: number): Promise<SessionSummary[]> {
    const metas: SessionMeta[] = [];
    for (const b of this.#sessions.values()) {
      const e = this.#live(b.meta);
      if (e?.value.hostId === hostId) metas.push(e.value);
    }
    metas.sort((a, b) => compare(b.createdAt, a.createdAt) || compare(b.sessionId, a.sessionId));
    return metas.slice(0, Math.max(0, Math.floor(limit))).map((m) => ({
      sessionId: m.sessionId,
      pin: m.pin,
      quizId: m.quizId,
      quizTitle: m.quizTitle,
      phase: m.phase,
      createdAt: m.createdAt,
      expiresAt: m.expiresAt,
    }));
  }

  // --- Players ---------------------------------------------------------------------

  async addPlayer(player: PlayerRecord, expiresAt: number): Promise<AddPlayerResult> {
    const b = this.#bucket(player.sessionId);
    if (this.#live(b.nicknames.get(player.nicknameKey))) return 'nickname-taken';
    if (this.#live(b.players.get(player.playerId))) throw new ConflictError('player exists');
    b.nicknames.set(player.nicknameKey, { expiresAt, value: player.playerId });
    b.players.set(player.playerId, { expiresAt, value: copy(player) });
    this.#changed();
    return 'ok';
  }

  async getPlayer(sessionId: string, playerId: string): Promise<PlayerRecord | null> {
    const e = this.#live(this.#sessions.get(sessionId)?.players.get(playerId));
    return e ? copy(e.value) : null;
  }

  async updatePlayer(
    sessionId: string,
    playerId: string,
    patch: Partial<Pick<PlayerRecord, 'kicked' | 'lastSeenAt'>>,
  ): Promise<void> {
    const e = this.#live(this.#sessions.get(sessionId)?.players.get(playerId));
    if (!e) throw new NotFoundError(`player ${playerId} not found`);
    if (patch.kicked !== undefined) e.value.kicked = patch.kicked;
    if (patch.lastSeenAt !== undefined) e.value.lastSeenAt = patch.lastSeenAt;
    this.#changed();
  }

  async listPlayers(sessionId: string): Promise<PlayerRecord[]> {
    return this.#livePlayers(sessionId)
      .sort((a, b) => compare(a.playerId, b.playerId))
      .map(copy);
  }

  async countPlayers(sessionId: string): Promise<number> {
    return this.#livePlayers(sessionId).length;
  }

  // --- Connections -----------------------------------------------------------------

  async putConnection(conn: ConnectionRecord): Promise<void> {
    const previous = this.#connectionSession.get(conn.connectionId);
    if (previous !== undefined && previous !== conn.sessionId) {
      this.#sessions.get(previous)?.connections.delete(conn.connectionId);
    }
    this.#bucket(conn.sessionId).connections.set(conn.connectionId, {
      expiresAt: conn.expiresAt,
      value: copy(conn),
    });
    this.#connectionSession.set(conn.connectionId, conn.sessionId);
    this.#changed();
  }

  async getConnection(connectionId: string): Promise<ConnectionRecord | null> {
    const sessionId = this.#connectionSession.get(connectionId);
    if (sessionId === undefined) return null;
    const e = this.#live(this.#sessions.get(sessionId)?.connections.get(connectionId));
    return e ? copy(e.value) : null;
  }

  async deleteConnection(connectionId: string): Promise<void> {
    const sessionId = this.#connectionSession.get(connectionId);
    if (sessionId === undefined) return;
    this.#connectionSession.delete(connectionId);
    this.#sessions.get(sessionId)?.connections.delete(connectionId);
    this.#changed();
  }

  async listConnections(sessionId: string): Promise<ConnectionRecord[]> {
    const b = this.#sessions.get(sessionId);
    if (!b) return [];
    return [...b.connections.values()]
      .filter((e) => this.#live(e))
      .map((e) => e.value)
      .sort((x, y) => compare(x.connectionId, y.connectionId))
      .map(copy);
  }

  // --- Responses -------------------------------------------------------------------

  async putResponse(response: ResponseRecord, expiresAt: number): Promise<PutResponseResult> {
    const slots = this.#responseSlots(this.#bucket(response.sessionId), response);
    const existing = this.#live(slots.get(response.slot));
    if (existing) return { created: false, existing: copy(existing.value) };
    slots.set(response.slot, { expiresAt, value: copy(response) });
    this.#changed();
    return { created: true };
  }

  async listResponses(sessionId: string, questionIndex: number): Promise<ResponseRecord[]> {
    const byPlayer = this.#sessions.get(sessionId)?.responses.get(questionIndex);
    if (!byPlayer) return [];
    const out: ResponseRecord[] = [];
    for (const bySlot of byPlayer.values()) {
      for (const e of bySlot.values()) if (this.#live(e)) out.push(e.value);
    }
    out.sort((a, b) => compare(a.receivedAt, b.receivedAt) || compare(a.responseId, b.responseId));
    return out.map(copy);
  }

  async listPlayerResponses(
    sessionId: string,
    questionIndex: number,
    playerId: string,
  ): Promise<ResponseRecord[]> {
    const bySlot = this.#sessions.get(sessionId)?.responses.get(questionIndex)?.get(playerId);
    if (!bySlot) return [];
    return [...bySlot.values()]
      .filter((e) => this.#live(e))
      .map((e) => e.value)
      .sort((a, b) => compare(a.slot, b.slot))
      .map(copy);
  }

  async setResponseStatus(
    sessionId: string,
    questionIndex: number,
    responseId: string,
    status: ModerationStatus,
  ): Promise<void> {
    const parsed = parseResponseId(responseId);
    const e =
      parsed &&
      this.#live(
        this.#sessions
          .get(sessionId)
          ?.responses.get(questionIndex)
          ?.get(parsed.playerId)
          ?.get(parsed.slot),
      );
    if (!e) throw new NotFoundError(`response ${responseId} not found`);
    e.value.status = status;
    this.#changed();
  }

  // --- Results ---------------------------------------------------------------------

  async putQuestionResult(result: StoredQuestionResult, expiresAt: number): Promise<void> {
    this.#bucket(result.sessionId).results.set(result.questionIndex, {
      expiresAt,
      value: copy(result),
    });
    this.#changed();
  }

  async getQuestionResult(
    sessionId: string,
    questionIndex: number,
  ): Promise<StoredQuestionResult | null> {
    const e = this.#live(this.#sessions.get(sessionId)?.results.get(questionIndex));
    return e ? copy(e.value) : null;
  }

  async listQuestionResults(sessionId: string): Promise<StoredQuestionResult[]> {
    const b = this.#sessions.get(sessionId);
    if (!b) return [];
    return [...b.results.values()]
      .filter((e) => this.#live(e))
      .map((e) => e.value)
      .sort((x, y) => compare(x.questionIndex, y.questionIndex))
      .map(copy);
  }

  async getScoreboard(sessionId: string): Promise<Scoreboard | null> {
    const e = this.#live(this.#sessions.get(sessionId)?.scoreboard);
    return e ? copy(e.value) : null;
  }

  async putScoreboard(
    scoreboard: Scoreboard,
    expectedVersion: number | undefined,
    expiresAt: number,
  ): Promise<void> {
    const b = this.#bucket(scoreboard.sessionId);
    const existing = this.#live(b.scoreboard);
    if (expectedVersion === undefined ? existing : existing?.value.version !== expectedVersion) {
      throw new ConflictError();
    }
    b.scoreboard = { expiresAt, value: copy(scoreboard) };
    this.#changed();
  }

  // --- Rate limiting ---------------------------------------------------------------

  async hitRateLimit(key: string, limit: number, windowMs: number, now: number): Promise<boolean> {
    if (!(windowMs > 0)) throw new RangeError('windowMs must be positive');
    const windowStart = now - (now % windowMs);
    const id = `${windowStart}#${key}`;
    const current = this.#rateWindows.get(id);
    const live = current !== undefined && current.expiresAt > this.#now();
    const count = live ? current.count + 1 : 1;
    this.#rateWindows.set(id, {
      key,
      windowStart,
      count,
      expiresAt: windowStart + windowMs + 60_000,
    });
    this.#changed();
    return count <= limit;
  }

  async peekRateLimit(key: string, limit: number, windowMs: number, now: number): Promise<boolean> {
    if (!(windowMs > 0)) throw new RangeError('windowMs must be positive');
    const windowStart = now - (now % windowMs);
    const current = this.#rateWindows.get(`${windowStart}#${key}`);
    const count = current !== undefined && current.expiresAt > this.#now() ? current.count : 0;
    return count <= limit;
  }

  // --- Internals -------------------------------------------------------------------

  #live<T>(entry: Stamped<T> | undefined): Stamped<T> | undefined {
    return entry !== undefined && entry.expiresAt > this.#now() ? entry : undefined;
  }

  #changed(): void {
    const listeners = mutationListeners.get(this);
    if (listeners) for (const l of listeners) l();
  }

  #quizMap(ownerId: string): Map<string, Quiz> {
    let byId = this.#quizzes.get(ownerId);
    if (!byId) {
      byId = new Map();
      this.#quizzes.set(ownerId, byId);
    }
    return byId;
  }

  #dropSession(sessionId: string, b: Bucket): void {
    for (const id of b.connections.keys()) this.#connectionSession.delete(id);
    this.#sessions.delete(sessionId);
  }

  #bucket(sessionId: string): Bucket {
    let b = this.#sessions.get(sessionId);
    if (!b) {
      b = newBucket();
      this.#sessions.set(sessionId, b);
    }
    return b;
  }

  #responseSlots(b: Bucket, r: ResponseRecord): Map<number, Stamped<ResponseRecord>> {
    let byPlayer = b.responses.get(r.questionIndex);
    if (!byPlayer) {
      byPlayer = new Map();
      b.responses.set(r.questionIndex, byPlayer);
    }
    let bySlot = byPlayer.get(r.playerId);
    if (!bySlot) {
      bySlot = new Map();
      byPlayer.set(r.playerId, bySlot);
    }
    return bySlot;
  }

  #livePlayers(sessionId: string): PlayerRecord[] {
    const b = this.#sessions.get(sessionId);
    if (!b) return [];
    return [...b.players.values()].filter((e) => this.#live(e)).map((e) => e.value);
  }

  #isEmpty(b: Bucket): boolean {
    return (
      b.players.size === 0 &&
      b.nicknames.size === 0 &&
      b.connections.size === 0 &&
      b.responses.size === 0 &&
      b.results.size === 0
    );
  }

  /** Drops expired records of one bucket; returns whether anything was removed. */
  #pruneBucket(b: Bucket, t: number): boolean {
    let removed = false;
    const prune = <K, V>(map: Map<K, Stamped<V>>, onDelete?: (key: K) => void) => {
      for (const [k, e] of map) {
        if (e.expiresAt <= t) {
          map.delete(k);
          onDelete?.(k);
          removed = true;
        }
      }
    };
    prune(b.players);
    prune(b.nicknames);
    prune(b.connections, (id) => this.#connectionSession.delete(id));
    prune(b.results);
    for (const [q, byPlayer] of b.responses) {
      for (const [playerId, bySlot] of byPlayer) {
        prune(bySlot);
        if (bySlot.size === 0) byPlayer.delete(playerId);
      }
      if (byPlayer.size === 0) b.responses.delete(q);
    }
    if (b.snapshot && b.snapshot.expiresAt <= t) {
      b.snapshot = undefined;
      removed = true;
    }
    if (b.scoreboard && b.scoreboard.expiresAt <= t) {
      b.scoreboard = undefined;
      removed = true;
    }
    return removed;
  }
}
