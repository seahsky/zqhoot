import { ClientMessage, LIMITS, PROTOCOL_VERSION } from '@zqhoot/protocol';
import type {
  AnswerMsg,
  AnswerRejectReason,
  ErrorCode,
  HostCloseMsg,
  HostCommand,
  HostHelloMsg,
  HostKickMsg,
  HostModerateMsg,
  HostSnapshot,
  HostStatsMsg,
  JoinMsg,
  PlayerSnapshot,
  ResumeMsg,
} from '@zqhoot/protocol';
import {
  applyHostCommand,
  buildEnded,
  buildHostSnapshot,
  buildLeaderboard,
  buildPlayerSnapshot,
  buildQuestionMessage,
  checkJoinable,
  computeLiveStats,
  computeReveal,
  evaluateAnswer,
  isExpired,
  normalizeNickname,
  refreshModeration,
  revealFromStored,
  timerClose,
} from '@zqhoot/engine';
import type {
  ConnectionRecord,
  EngineConfig,
  PlayerMessage,
  PlayerRecord,
  QuizSnapshot,
  ResponseRecord,
  Scoreboard,
  SessionMeta,
  StoredQuestionResult,
  TransitionEffect,
  TransitionResult,
} from '@zqhoot/engine';
import { ConflictError, NotFoundError } from '@zqhoot/store';
import type { Store } from '@zqhoot/store';
import { exceedsUtf8Bytes, sha256Hex, timingSafeEqualHex } from './crypto.ts';
import { Delivery, describeError } from './delivery.ts';
import type { Audience } from './delivery.ts';
import { LruCache } from './lru.ts';
import { PIN_LOOKUP_LIMIT, PIN_LOOKUP_WINDOW_MS, UNKNOWN_IP, pinLookupCounter } from './limits.ts';
import { CLOSE_CODES, noopLogger } from './ports.ts';
import type { Clock, HostAuth, Ids, Logger, Scheduler, Sleep, Transport } from './ports.ts';

export interface GameServiceConfig {
  /** minLeadMs per target, answerGraceMs, sessionTtlMs. */
  engine: EngineConfig;
  /** Lambda 1000, VM 0 (ADR-0006). */
  revealSettleMs: number;
  /** Exact origins accepted on connect (ADR-0013); empty = allow all (tests only). */
  allowedOrigins: string[];
  /** 10. */
  nicknameAttemptsPerConnection: number;
}

export interface GameServiceDeps {
  store: Store;
  transport: Transport;
  clock: Clock;
  ids: Ids;
  hostAuth: HostAuth;
  scheduler?: Scheduler;
  logger?: Logger;
  sleep?: Sleep;
  config: GameServiceConfig;
}

const NICKNAME_WINDOW_MS = 3_600_000;
/** A little over API Gateway's 2 h connection limit (ADR-0007). */
const CONNECTION_TTL_MS = 3 * 3_600_000;
const SNAPSHOT_CACHE_SIZE = 100;
const TRANSITION_ATTEMPTS = 3;
const REVEAL_ATTEMPTS = 3;
/** Derive-write-verify rounds for one moderation of a revealed result. */
const MODERATION_PASSES = 3;
/** Evaluations of one answer: the second one sees the record a concurrent request wrote first. */
const ANSWER_ATTEMPTS = 2;
const VERSIONED_TYPES: ReadonlySet<string> = new Set(['join', 'resume', 'host.hello']);

type PlayerBinding = ConnectionRecord & { playerId: string };
type HostCommandMsg = Exclude<HostCommand, HostHelloMsg>;

/** Who asked for a host command, so errors and no-op state go back to them alone. */
interface Requester {
  connectionId: string;
  binding: ConnectionRecord;
  ref: string;
}

const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isConflict = (err: unknown): boolean =>
  err instanceof ConflictError || (err instanceof Error && err.name === 'ConflictError');
const isNotFound = (err: unknown): boolean =>
  err instanceof NotFoundError || (err instanceof Error && err.name === 'NotFoundError');

const sameStatuses = (a: ResponseRecord[], b: ResponseRecord[]): boolean => {
  const latest = new Map(b.map((r) => [r.responseId, r.status]));
  return a.length === b.length && a.every((r) => latest.get(r.responseId) === r.status);
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const connectionExpiry = (meta: SessionMeta, now: number): number =>
  Math.min(meta.expiresAt, now + CONNECTION_TTL_MS);

const JOIN_REFUSALS = {
  'not-found': 'no game with that PIN',
  'session-ended': 'this game has ended',
  'session-locked': 'this game is not accepting new players',
  'session-full': 'this game is full',
} as const;

/**
 * Turns WebSocket events into engine calls, persists through `Store` and delivers through
 * `Transport` (ADR-0001). Holds no game state between calls except an immutable snapshot cache,
 * so any number of instances can serve one session.
 */
export class GameService {
  readonly #store: Store;
  readonly #out: Delivery;
  readonly #clock: Clock;
  readonly #ids: Ids;
  readonly #hostAuth: HostAuth;
  readonly #scheduler: Scheduler | undefined;
  readonly #log: Logger;
  readonly #sleep: Sleep;
  readonly #cfg: GameServiceConfig;
  /** Promises rather than values, so a burst of answers on a cold instance shares one read. */
  readonly #snapshots = new LruCache<string, Promise<QuizSnapshot | null>>(SNAPSHOT_CACHE_SIZE);

  constructor(deps: GameServiceDeps) {
    this.#store = deps.store;
    this.#clock = deps.clock;
    this.#ids = deps.ids;
    this.#hostAuth = deps.hostAuth;
    this.#scheduler = deps.scheduler;
    this.#log = deps.logger ?? noopLogger;
    this.#out = new Delivery(deps.store, deps.transport, this.#log);
    this.#sleep = deps.sleep ?? defaultSleep;
    this.#cfg = deps.config;
  }

  // ---------------------------------------------------------------------------
  // Entry points
  // ---------------------------------------------------------------------------

  async onConnect(
    connectionId: string,
    info: { origin?: string; sourceIp?: string },
  ): Promise<{ accept: boolean }> {
    const allowed = this.#cfg.allowedOrigins;
    const accept =
      allowed.length === 0 || (info.origin !== undefined && allowed.includes(info.origin));
    if (!accept) {
      this.#log.warn(
        { connectionId, origin: info.origin, sourceIp: info.sourceIp },
        'websocket origin rejected',
      );
    }
    return { accept };
  }

  async onDisconnect(connectionId: string): Promise<void> {
    try {
      const binding = await this.#store.getConnection(connectionId);
      if (binding === null) return;
      await this.#store.deleteConnection(connectionId);
      if (binding.role === 'player' && binding.playerId !== undefined) {
        await this.#out.announceDisconnects(binding.sessionId, [binding.playerId]);
      }
    } catch (err) {
      this.#log.error({ connectionId, err: describeError(err) }, 'disconnect handling failed');
    }
  }

  /** `receivedAt`: API Gateway requestTimeEpoch or the Node receive time. `raw` is the frame text. */
  async onMessage(
    connectionId: string,
    raw: string,
    receivedAt: number,
    info?: { sourceIp?: string },
  ): Promise<void> {
    const frame: { type?: string } = {};
    try {
      await this.#handleFrame(connectionId, raw, receivedAt, frame, info?.sourceIp);
    } catch (err) {
      this.#log.error(
        { connectionId, type: frame.type, sourceIp: info?.sourceIp, err: describeError(err) },
        'unhandled error while handling a message',
      );
      // Clients only ever see a generic message; the stack stays in the log.
      await this.#out
        .error(connectionId, 'internal', 'internal error', frame.type)
        .catch(() => undefined);
    }
  }

  async onTimer(sessionId: string, questionIndex: number): Promise<void> {
    try {
      await this.#transition(
        sessionId,
        (meta, _snapshot, now) => timerClose(meta, questionIndex, now),
        null,
      );
    } catch (err) {
      this.#log.error({ sessionId, questionIndex, err: describeError(err) }, 'timer close failed');
    }
  }

  /** Establish store connections for warm-up invocations. */
  async warm(): Promise<void> {
    try {
      // A read that can never hit (PINs start with 1-9) but opens the store connection.
      await this.#store.getSessionIdByPin('000000');
    } catch (err) {
      this.#log.warn({ err: describeError(err) }, 'warm-up read failed');
    }
  }

  // ---------------------------------------------------------------------------
  // Parsing and dispatch
  // ---------------------------------------------------------------------------

  /** Records the message type in `frame` as soon as it is known, so a failure below can be logged with it. */
  async #handleFrame(
    connectionId: string,
    raw: string,
    receivedAt: number,
    frame: { type?: string },
    sourceIp: string | undefined,
  ): Promise<void> {
    if (exceedsUtf8Bytes(raw, LIMITS.clientMessageMaxBytes)) {
      await this.#out.error(connectionId, 'bad-request', 'message too large');
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      await this.#out.error(connectionId, 'bad-request', 'message is not valid JSON');
      return;
    }
    const type =
      isRecord(json) && typeof json.type === 'string' ? json.type.slice(0, 40) : undefined;
    if (type !== undefined) frame.type = type;

    if (
      type !== undefined &&
      VERSIONED_TYPES.has(type) &&
      isRecord(json) &&
      json.v !== PROTOCOL_VERSION
    ) {
      await this.#out.error(
        connectionId,
        'protocol-version',
        `unsupported protocol version, expected ${PROTOCOL_VERSION}`,
        type,
      );
      await this.#out.close(connectionId, CLOSE_CODES.protocolError, 'protocol-version');
      return;
    }

    const parsed = ClientMessage.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where =
        issue === undefined ? '' : ` (${issue.path.join('.') || 'message'}: ${issue.message})`;
      await this.#out.error(
        connectionId,
        'bad-request',
        `invalid message${where}`.slice(0, 200),
        type,
      );
      return;
    }
    const msg = parsed.data;

    switch (msg.type) {
      case 'ping':
        await this.#out.send(connectionId, { type: 'pong', t: msg.t });
        return;
      case 'join':
        await this.#join(connectionId, msg, sourceIp ?? UNKNOWN_IP);
        return;
      case 'resume':
        await this.#resume(connectionId, msg);
        return;
      case 'host.hello':
        await this.#hostHello(connectionId, msg);
        return;
      case 'answer':
      case 'leave': {
        const binding = await this.#store.getConnection(connectionId);
        if (binding === null || binding.role !== 'player' || binding.playerId === undefined) {
          await this.#out.error(connectionId, 'unauthorized', 'not a player connection', msg.type);
          return;
        }
        const player = { ...binding, playerId: binding.playerId };
        if (msg.type === 'answer') await this.#answer(connectionId, player, msg, receivedAt);
        else await this.#leave(connectionId, player);
        return;
      }
      default: {
        // Everything left is a host command.
        const binding = await this.#store.getConnection(connectionId);
        if (binding === null || binding.role !== 'host') {
          await this.#out.error(connectionId, 'unauthorized', 'not a host connection', msg.type);
          return;
        }
        await this.#hostCommand(connectionId, binding, msg);
        return;
      }
    }
  }

  async #hostCommand(
    connectionId: string,
    binding: ConnectionRecord,
    msg: HostCommandMsg,
  ): Promise<void> {
    switch (msg.type) {
      case 'host.kick':
        return this.#kick(connectionId, binding, msg);
      case 'host.moderate':
        return this.#moderate(connectionId, binding, msg);
      case 'host.stats':
        return this.#stats(connectionId, binding, msg);
      default:
        // A timer close that comes early must not cut the answer grace short (ADR-0005).
        if (
          msg.type === 'host.close' &&
          msg.reason === 'timer' &&
          !(await this.#awaitGraceEnd(binding.sessionId, msg))
        ) {
          return;
        }
        return this.#transition(
          binding.sessionId,
          (meta, snapshot, now) => applyHostCommand(meta, snapshot, msg, now, this.#cfg.engine),
          { connectionId, binding, ref: msg.type },
        );
    }
  }

  /**
   * Holds a `host.close {reason:'timer'}` back until `deadline + answerGraceMs`, the last instant
   * an answer is accepted. Clients close at that time by their own clock, which can run a little
   * fast, and an answer that arrives after the close commits is refused whatever its `receivedAt`.
   * Returns false when the close was left to the scheduler and the caller has nothing to do.
   */
  async #awaitGraceEnd(sessionId: string, msg: HostCloseMsg): Promise<boolean> {
    const meta = await this.#store.getSession(sessionId);
    if (
      meta === null ||
      meta.phase !== 'question' ||
      meta.questionIndex !== msg.questionIndex ||
      meta.deadline === null
    ) {
      return true;
    }
    const grace = this.#cfg.engine.answerGraceMs;
    const wait = meta.deadline + grace - this.#clock.now();
    if (wait <= 0) return true;
    // The VM armed its own close for that instant when the question opened; a second one would
    // only hold this frame's connection for nothing.
    if (this.#scheduler !== undefined) return false;
    await this.#sleep(Math.min(wait, grace));
    return true;
  }

  // ---------------------------------------------------------------------------
  // Player: join, resume, answer, leave
  // ---------------------------------------------------------------------------

  async #join(connectionId: string, msg: JoinMsg, ip: string): Promise<void> {
    const store = this.#store;
    const now = this.#clock.now();

    const withinLimit = await store.hitRateLimit(
      `nick:${connectionId}`,
      this.#cfg.nicknameAttemptsPerConnection,
      NICKNAME_WINDOW_MS,
      now,
    );
    if (!withinLimit) {
      await this.#out.error(connectionId, 'rate-limited', 'too many nickname attempts', 'join');
      await this.#out.close(connectionId, CLOSE_CODES.policyViolation, 'rate-limited');
      return;
    }

    // Same budget and same order as `GET /api/join/:pin`: a blocked IP is refused before the PIN
    // is looked up, so a live PIN and a dead one look alike, and only a miss spends the budget
    // (a classroom behind one NAT joins with valid PINs all day).
    const counter = pinLookupCounter(ip);
    if (!(await store.peekRateLimit(counter, PIN_LOOKUP_LIMIT, PIN_LOOKUP_WINDOW_MS, now))) {
      await this.#refuseForPinGuessing(connectionId);
      return;
    }

    const sessionId = await store.getSessionIdByPin(msg.pin);
    const meta = sessionId === null ? null : await store.getSession(sessionId);
    const count = sessionId === null || meta === null ? 0 : await store.countPlayers(sessionId);
    const check = checkJoinable(meta, count, now);
    if (!check.ok || sessionId === null || meta === null) {
      const code = check.ok ? 'not-found' : check.code;
      if (
        code === 'not-found' &&
        !(await store.hitRateLimit(counter, PIN_LOOKUP_LIMIT, PIN_LOOKUP_WINDOW_MS, now))
      ) {
        await this.#refuseForPinGuessing(connectionId);
        return;
      }
      await this.#out.error(connectionId, code, JOIN_REFUSALS[code], 'join');
      return;
    }

    const nick = normalizeNickname(msg.nickname);
    if (!nick.ok) {
      await this.#out.error(connectionId, 'nickname-invalid', nick.reason, 'join');
      return;
    }

    const playerId = this.#ids.playerId();
    const token = this.#ids.token();
    const player: PlayerRecord = {
      sessionId,
      playerId,
      nickname: nick.nickname,
      nicknameKey: nick.key,
      tokenHash: await sha256Hex(token),
      joinedAt: now,
      kicked: false,
      lastSeenAt: now,
    };
    // The count read above only turns a full session away early: the cap itself is enforced by
    // the store, atomically, because any number of joins can pass that read together.
    const admission = await store.addPlayer(player, meta.expiresAt, meta.maxPlayers);
    if (admission === 'session-full') {
      await this.#out.error(connectionId, 'session-full', JOIN_REFUSALS['session-full'], 'join');
      return;
    }
    if (admission === 'nickname-taken') {
      await this.#out.error(
        connectionId,
        'nickname-taken',
        'that nickname is already taken',
        'join',
      );
      return;
    }

    const binding: ConnectionRecord = {
      connectionId,
      sessionId,
      role: 'player',
      playerId,
      connectedAt: now,
      expiresAt: connectionExpiry(meta, now),
    };
    await store.putConnection(binding);

    // Read the session again now that this connection is registered: a transition committed
    // between the first read and putConnection would otherwise have skipped this player, and
    // nothing replays it (ADR-0004: level-triggered state).
    const current = await store.getSession(sessionId);
    if (current === null || isExpired(current, this.#clock.now())) {
      await store.deleteConnection(connectionId);
      await this.#out.error(connectionId, 'not-found', JOIN_REFUSALS['not-found'], 'join');
      return;
    }
    const snapshot = await this.#playerSnapshot(current, player, { withResponses: false });
    const delivered = await this.#out.send(
      connectionId,
      {
        type: 'welcome',
        role: 'player',
        credentials: { sessionId, playerId, token },
        snapshot,
      },
      [binding],
    );
    if (delivered) await this.#out.announceConnected(player);
  }

  #refuseForPinGuessing(connectionId: string): Promise<boolean> {
    return this.#out.error(
      connectionId,
      'rate-limited',
      'too many wrong PINs from this network, try again in a minute',
      'join',
    );
  }

  async #resume(connectionId: string, msg: ResumeMsg): Promise<void> {
    const store = this.#store;
    const now = this.#clock.now();

    const player = await store.getPlayer(msg.sessionId, msg.playerId);
    if (player === null) {
      await this.#out.error(connectionId, 'not-found', 'unknown player or session', 'resume');
      return;
    }
    const presented = await sha256Hex(msg.token);
    if (!timingSafeEqualHex(presented, player.tokenHash)) {
      await this.#out.error(connectionId, 'unauthorized', 'invalid resume token', 'resume');
      return;
    }
    if (player.kicked) {
      await this.#out.error(connectionId, 'kicked', 'you were removed from this game', 'resume');
      await this.#out.close(connectionId, CLOSE_CODES.normal, 'kicked');
      return;
    }
    const meta = await store.getSession(msg.sessionId);
    if (meta === null || isExpired(meta, now)) {
      await this.#out.error(
        connectionId,
        'not-found',
        'this game is no longer available',
        'resume',
      );
      return;
    }

    const binding: ConnectionRecord = {
      connectionId,
      sessionId: msg.sessionId,
      role: 'player',
      playerId: msg.playerId,
      connectedAt: now,
      expiresAt: connectionExpiry(meta, now),
    };
    // Both writes run to completion before the outcome is looked at, so cleaning up after a
    // failed `updatePlayer` cannot race with the `putConnection` it has to undo.
    const [registered, touched] = await Promise.allSettled([
      store.putConnection(binding),
      store.updatePlayer(msg.sessionId, msg.playerId, { lastSeenAt: now }),
    ]);
    if (registered.status === 'rejected') throw registered.reason;
    if (touched.status === 'rejected') {
      if (!isNotFound(touched.reason)) throw touched.reason;
      await store.deleteConnection(connectionId);
      await this.#out.error(
        connectionId,
        'not-found',
        'this game is no longer available',
        'resume',
      );
      return;
    }

    // Same reasoning as in join: read the phase after the connection exists.
    const current = await store.getSession(msg.sessionId);
    if (current === null || isExpired(current, this.#clock.now())) {
      await store.deleteConnection(connectionId);
      await this.#out.error(
        connectionId,
        'not-found',
        'this game is no longer available',
        'resume',
      );
      return;
    }
    const snapshot = await this.#playerSnapshot(current, player, { withResponses: true });
    const delivered = await this.#out.send(
      connectionId,
      { type: 'welcome', role: 'player', snapshot },
      [binding],
    );
    if (delivered) await this.#out.announceConnected(player);
  }

  async #answer(
    connectionId: string,
    binding: PlayerBinding,
    msg: AnswerMsg,
    receivedAt: number,
  ): Promise<void> {
    const store = this.#store;
    const { sessionId, playerId } = binding;
    const ack = (
      status: 'accepted' | 'duplicate' | 'rejected',
      entries: number,
      reason?: AnswerRejectReason,
    ) =>
      this.#out.send(
        connectionId,
        {
          type: 'answer.ack',
          index: msg.questionIndex,
          status,
          ...(reason !== undefined ? { reason } : {}),
          entries,
        },
        [binding],
      );

    const meta = await store.getSession(sessionId);
    const snapshot = meta === null ? null : await this.#snapshot(sessionId);
    if (meta === null || snapshot === null || isExpired(meta, this.#clock.now())) {
      await this.#out.error(
        connectionId,
        'not-found',
        'this game is no longer available',
        'answer',
        [binding],
      );
      return;
    }

    // Only word clouds and open questions take several entries, so only they need the player's
    // earlier ones. Single-response types let the conditional put find a duplicate. An answer
    // for a question that is not open is refused by the engine before `existing` matters.
    const question = snapshot.questions[msg.questionIndex];
    const collectsEntries = question?.type === 'wordcloud' || question?.type === 'open';
    const isOpen = meta.phase === 'question' && meta.questionIndex === msg.questionIndex;
    let known =
      collectsEntries && isOpen
        ? await store.listPlayerResponses(sessionId, msg.questionIndex, playerId)
        : [];

    for (let attempt = 0; attempt < ANSWER_ATTEMPTS; attempt++) {
      const decision = evaluateAnswer({
        meta,
        snapshot,
        playerId,
        questionIndex: msg.questionIndex,
        payload: msg.payload,
        receivedAt,
        existing: known,
        cfg: this.#cfg.engine,
      });
      if (decision.kind === 'reject') {
        await ack('rejected', known.length, decision.reason);
        return;
      }
      if (decision.kind === 'duplicate') {
        await ack('duplicate', known.length);
        return;
      }
      const put = await store.putResponse(decision.response, meta.expiresAt);
      if (put.created) {
        await ack('accepted', decision.response.slot + 1);
        return;
      }
      // Lost the race for this slot to a concurrent request of the same player: judge the answer
      // again with that record included (a same-answer duplicate, the entry limit, or the next slot).
      known = [...known, put.existing];
    }
    await ack('rejected', known.length, 'limit');
  }

  async #leave(connectionId: string, binding: PlayerBinding): Promise<void> {
    await this.#store.deleteConnection(connectionId);
    await this.#out.announceDisconnects(binding.sessionId, [binding.playerId]);
  }

  // ---------------------------------------------------------------------------
  // Host: hello, transitions, reveal
  // ---------------------------------------------------------------------------

  async #hostHello(connectionId: string, msg: HostHelloMsg): Promise<void> {
    const store = this.#store;
    const now = this.#clock.now();

    const identity = await this.#hostAuth.verify(msg.authToken);
    if (identity === null) {
      await this.#out.error(connectionId, 'unauthorized', 'invalid or expired token', 'host.hello');
      await this.#out.close(connectionId, CLOSE_CODES.policyViolation, 'unauthorized');
      return;
    }
    const meta = await store.getSession(msg.sessionId);
    if (meta === null || isExpired(meta, now)) {
      await this.#out.error(connectionId, 'not-found', 'no such session', 'host.hello');
      return;
    }
    if (meta.hostId !== identity.hostId) {
      await this.#out.error(
        connectionId,
        'forbidden',
        'this session belongs to another host',
        'host.hello',
      );
      await this.#out.close(connectionId, CLOSE_CODES.policyViolation, 'forbidden');
      return;
    }

    const binding: ConnectionRecord = {
      connectionId,
      sessionId: meta.sessionId,
      role: 'host',
      client: msg.client,
      connectedAt: now,
      expiresAt: connectionExpiry(meta, now),
    };
    await store.putConnection(binding);

    // Read the phase after the connection exists, so a broadcast cannot slip past unseen.
    const current = await store.getSession(meta.sessionId);
    const snapshot = current === null ? null : await this.#snapshot(meta.sessionId);
    if (current === null || snapshot === null) {
      await store.deleteConnection(connectionId);
      await this.#out.error(connectionId, 'not-found', 'no such session', 'host.hello');
      return;
    }
    const view = await this.#hostSnapshot(current, snapshot, {});
    await this.#out.send(connectionId, { type: 'welcome', role: 'host', snapshot: view }, [
      binding,
    ]);
  }

  /**
   * Applies a host command or the question timer: load, decide in the engine, write with a
   * version check, then run the effect. A lost race reloads and decides again, so a stale
   * `from` or an already-closed question ends as a no-op.
   */
  async #transition(
    sessionId: string,
    decide: (meta: SessionMeta, snapshot: QuizSnapshot, now: number) => TransitionResult,
    requester: Requester | null,
  ): Promise<void> {
    const fail = async (code: ErrorCode, message: string) => {
      if (requester !== null) {
        await this.#out.error(requester.connectionId, code, message, requester.ref, [
          requester.binding,
        ]);
      }
    };

    for (let attempt = 0; attempt < TRANSITION_ATTEMPTS; attempt++) {
      const meta = await this.#store.getSession(sessionId);
      const snapshot = meta === null ? null : await this.#snapshot(sessionId);
      if (meta === null || snapshot === null || isExpired(meta, this.#clock.now())) {
        await fail('not-found', 'no such session');
        return;
      }
      const result = decide(meta, snapshot, this.#clock.now());
      if (!result.ok) {
        await fail(result.code, result.message);
        return;
      }
      if (result.effect.kind === 'none') {
        if (requester !== null) {
          const view = await this.#hostSnapshot(meta, snapshot, {});
          await this.#out.send(requester.connectionId, { type: 'host.state', snapshot: view }, [
            requester.binding,
          ]);
        }
        return;
      }
      try {
        await this.#store.updateSession(result.meta, meta.version);
      } catch (err) {
        if (isConflict(err)) continue;
        throw err;
      }
      await this.#applyEffect(result.effect, result.meta, snapshot);
      return;
    }
    if (requester === null) {
      this.#log.warn({ sessionId }, 'transition abandoned after repeated version conflicts');
    }
    await fail('conflict', 'the session changed while handling the command, try again');
  }

  async #applyEffect(
    effect: TransitionEffect,
    meta: SessionMeta,
    snapshot: QuizSnapshot,
  ): Promise<void> {
    const sessionId = meta.sessionId;
    switch (effect.kind) {
      case 'none':
        return;
      case 'question-opened': {
        // Schedule before the fan-out: a failed send must not leave a timed question without a timer.
        if (meta.deadline !== null) {
          this.#scheduler?.scheduleClose(
            sessionId,
            effect.questionIndex,
            meta.deadline + this.#cfg.engine.answerGraceMs,
          );
        }
        const [aud, players] = await Promise.all([
          this.#out.audience(sessionId),
          this.#store.listPlayers(sessionId),
        ]);
        const view = await this.#hostSnapshot(meta, snapshot, { aud, players });
        await this.#out.fanOut(aud, {
          hosts: { type: 'host.state', snapshot: view },
          everyPlayer: buildQuestionMessage(meta, snapshot),
        });
        return;
      }
      case 'closing':
        this.#scheduler?.cancel(sessionId);
        if (this.#cfg.revealSettleMs > 0) await this.#sleep(this.#cfg.revealSettleMs);
        await this.#reveal(sessionId, effect.questionIndex);
        return;
      case 'retry-reveal': {
        // The settle is measured from the close: an answer acknowledged as accepted may still be
        // on its way to the store, and a second Next pressed inside the interval must not reveal
        // without it. The cap keeps a close stamped by a clock that runs ahead from stalling us.
        const settle = this.#cfg.revealSettleMs;
        const wait = (meta.closedAt ?? 0) + settle - this.#clock.now();
        if (wait > 0) await this.#sleep(Math.min(wait, settle));
        await this.#reveal(sessionId, effect.questionIndex);
        return;
      }
      case 'leaderboard': {
        const [aud, players, scoreboard] = await Promise.all([
          this.#out.audience(sessionId),
          this.#store.listPlayers(sessionId),
          this.#store.getScoreboard(sessionId),
        ]);
        if (scoreboard === null) throw new Error('scoreboard missing at leaderboard');
        const board = buildLeaderboard({ meta, scoreboard, players });
        const view = await this.#hostSnapshot(meta, snapshot, { aud, players, scoreboard });
        await this.#out.fanOut(aud, {
          hosts: { type: 'host.state', snapshot: view },
          perPlayer: board.playerMessages,
        });
        return;
      }
      case 'ended': {
        // Cleanup first: the PIN and the timer must not outlive the session even if delivery fails.
        await this.#store.releasePin(meta.pin, sessionId);
        this.#scheduler?.cancel(sessionId);
        const [aud, players, scoreboard] = await Promise.all([
          this.#out.audience(sessionId),
          this.#store.listPlayers(sessionId),
          this.#store.getScoreboard(sessionId),
        ]);
        const ended = buildEnded({ meta, snapshot, scoreboard, players });
        const view = await this.#hostSnapshot(meta, snapshot, { aud, players, scoreboard });
        await this.#out.fanOut(aud, {
          hosts: { type: 'host.state', snapshot: view },
          perPlayer: ended.playerMessages,
        });
        return;
      }
      case 'lock-changed': {
        const aud = await this.#out.audience(sessionId);
        const view = await this.#hostSnapshot(meta, snapshot, { aud });
        await this.#out.fanOut(aud, { hosts: { type: 'host.state', snapshot: view } });
        return;
      }
    }
  }

  /**
   * Idempotent reveal (ADR-0006). Writes result, then scoreboard, then meta; each step can be
   * repeated after a crash because the scoreboard's `appliedThrough` says what was already scored.
   */
  async #reveal(sessionId: string, questionIndex: number): Promise<void> {
    const store = this.#store;
    for (let attempt = 0; attempt < REVEAL_ATTEMPTS; attempt++) {
      const meta = await store.getSession(sessionId);
      if (meta === null || meta.phase !== 'revealing' || meta.questionIndex !== questionIndex) {
        return;
      }
      const snapshot = await this.#snapshot(sessionId);
      if (snapshot === null) return;
      const [stored, board] = await Promise.all([
        store.getQuestionResult(sessionId, questionIndex),
        store.getScoreboard(sessionId),
      ]);

      let next: SessionMeta;
      let result: StoredQuestionResult;
      let playerMessages: PlayerMessage[];
      let players: PlayerRecord[];
      /** The responses `result` was derived from; null when a previous run stored it. */
      let reflected: ResponseRecord[] | null = null;
      if (stored !== null && board !== null && board.appliedThrough >= questionIndex) {
        players = await store.listPlayers(sessionId);
        const rebuilt = revealFromStored({ meta, stored, players });
        next = rebuilt.meta;
        playerMessages = rebuilt.playerMessages;
        result = stored;
      } else {
        let responses: ResponseRecord[];
        [responses, players] = await Promise.all([
          store.listResponses(sessionId, questionIndex),
          store.listPlayers(sessionId),
        ]);
        const out = computeReveal({
          meta,
          snapshot,
          responses,
          players,
          scoreboard: board,
          now: this.#clock.now(),
        });
        try {
          await store.putQuestionResult(out.stored, meta.expiresAt);
          await store.putScoreboard(out.scoreboard, board?.version, meta.expiresAt);
        } catch (err) {
          // A concurrent run scored this question first; the next pass takes its stored result.
          if (isConflict(err)) continue;
          throw err;
        }
        next = out.meta;
        playerMessages = out.playerMessages;
        result = out.stored;
        reflected = responses;
      }

      try {
        await store.updateSession(next, meta.version);
      } catch (err) {
        if (isConflict(err)) continue;
        throw err;
      }

      // A moderation that read 'revealing' changed a status and left the result alone, expecting
      // this run to pick it up. It changed that status before the update above, so this read sees
      // it; a moderation that comes after finds the result stored and refreshes it itself.
      if (result.result.type === 'open' || result.result.type === 'wordcloud') {
        const latest = await store.listResponses(sessionId, questionIndex);
        if (reflected === null || !sameStatuses(reflected, latest)) {
          result = await this.#syncResult({
            sessionId,
            expiresAt: meta.expiresAt,
            stored: result,
            players,
            responses: latest,
          });
          playerMessages = revealFromStored({ meta, stored: result, players }).playerMessages;
        }
      }
      const aud = await this.#out.audience(sessionId);
      const view = await this.#hostSnapshot(next, snapshot, { aud, players, result });
      await this.#out.fanOut(aud, {
        hosts: { type: 'host.state', snapshot: view },
        perPlayer: playerMessages,
      });
      return;
    }
    this.#log.warn({ sessionId, questionIndex }, 'reveal abandoned after repeated conflicts');
  }

  // ---------------------------------------------------------------------------
  // Host: kick, moderate, stats
  // ---------------------------------------------------------------------------

  async #kick(connectionId: string, binding: ConnectionRecord, msg: HostKickMsg): Promise<void> {
    const store = this.#store;
    const sessionId = binding.sessionId;
    try {
      await store.updatePlayer(sessionId, msg.playerId, { kicked: true });
    } catch (err) {
      if (!isNotFound(err)) throw err;
      await this.#out.error(connectionId, 'not-found', 'no such player', msg.type, [binding]);
      return;
    }

    const aud = await this.#out.audience(sessionId);
    const targets = aud.players.get(msg.playerId) ?? [];
    await this.#out.deliver(
      targets.map((c) => ({ connectionId: c.connectionId, message: { type: 'kicked' } })),
      aud.all,
      false,
    );
    for (const target of targets) {
      await this.#out.close(target.connectionId, CLOSE_CODES.normal, 'kicked');
      await store.deleteConnection(target.connectionId);
    }
    await this.#out.fanOut(aud, {
      hosts: { type: 'roster', upsert: [], removed: [msg.playerId] },
    });
  }

  async #moderate(
    connectionId: string,
    binding: ConnectionRecord,
    msg: HostModerateMsg,
  ): Promise<void> {
    const store = this.#store;
    const sessionId = binding.sessionId;
    const snapshot = await this.#snapshot(sessionId);
    const question = snapshot?.questions[msg.questionIndex];
    if (snapshot === null || question === undefined) {
      await this.#out.error(connectionId, 'not-found', 'no such question', msg.type, [binding]);
      return;
    }
    if (question.type !== 'open' && question.type !== 'wordcloud') {
      await this.#out.error(
        connectionId,
        'bad-request',
        'this question has nothing to moderate',
        msg.type,
        [binding],
      );
      return;
    }
    try {
      await store.setResponseStatus(sessionId, msg.questionIndex, msg.responseId, msg.status);
    } catch (err) {
      if (!isNotFound(err)) throw err;
      await this.#out.error(connectionId, 'not-found', 'no such response', msg.type, [binding]);
      return;
    }

    // While the question is open the host sees the change on the next stats poll; a reveal still
    // being written re-reads the statuses after its own update, so it needs nothing from us.
    const meta = await store.getSession(sessionId);
    if (meta === null || meta.phase !== 'reveal' || meta.questionIndex !== msg.questionIndex)
      return;
    const [stored, initial, players] = await Promise.all([
      store.getQuestionResult(sessionId, msg.questionIndex),
      store.listResponses(sessionId, msg.questionIndex),
      store.listPlayers(sessionId),
    ]);

    const result =
      stored === null
        ? null
        : await this.#syncResult({
            sessionId,
            expiresAt: meta.expiresAt,
            stored,
            players,
            responses: initial,
          });

    const aud = await this.#out.audience(sessionId);
    const view = await this.#hostSnapshot(meta, snapshot, { aud, players, result });
    await this.#out.fanOut(aud, { hosts: { type: 'host.state', snapshot: view } });
  }

  /**
   * Re-derives the moderated parts of a stored result from `responses` and writes it. The write is
   * unconditional, so a request that read before another one's status change can still write last
   * and undo it. Every writer therefore reads again after its own write and rewrites when a status
   * moved: the last write in time then reflects every status change made before it, because a
   * change made after a writer's check is followed by its own write. Returns what was written
   * last, or `stored` for a question with nothing to moderate.
   */
  async #syncResult(i: {
    sessionId: string;
    expiresAt: number;
    stored: StoredQuestionResult;
    players: PlayerRecord[];
    responses: ResponseRecord[];
  }): Promise<StoredQuestionResult> {
    const { sessionId, stored, players } = i;
    let responses = i.responses;
    let result = stored;
    for (let pass = 1; ; pass++) {
      const refreshed = refreshModeration({ stored, players, responses });
      if (refreshed === null) break;
      await this.#store.putQuestionResult(refreshed, i.expiresAt);
      result = refreshed;
      const latest = await this.#store.listResponses(sessionId, stored.questionIndex);
      if (sameStatuses(responses, latest)) break;
      if (pass === MODERATION_PASSES) {
        this.#log.warn(
          { sessionId, questionIndex: stored.questionIndex },
          'moderation result still changing after repeated passes',
        );
        break;
      }
      responses = latest;
    }
    return result;
  }

  async #stats(connectionId: string, binding: ConnectionRecord, msg: HostStatsMsg): Promise<void> {
    const sessionId = binding.sessionId;
    const snapshot = await this.#snapshot(sessionId);
    if (snapshot === null) {
      await this.#out.error(connectionId, 'not-found', 'no such session', msg.type, [binding]);
      return;
    }
    const question = snapshot.questions[msg.questionIndex];
    if (question === undefined) {
      await this.#out.error(connectionId, 'bad-request', 'no such question', msg.type, [binding]);
      return;
    }
    const [responses, players, aud] = await Promise.all([
      this.#store.listResponses(sessionId, msg.questionIndex),
      this.#store.listPlayers(sessionId),
      this.#out.audience(sessionId),
    ]);
    const stats = computeLiveStats({
      question,
      responses,
      players,
      connectedPlayerIds: new Set(aud.players.keys()),
      ...(msg.after !== undefined ? { after: msg.after } : {}),
    });
    await this.#out.send(connectionId, { type: 'stats', questionIndex: msg.questionIndex, stats }, [
      binding,
    ]);
  }

  // ---------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------

  #snapshot(sessionId: string): Promise<QuizSnapshot | null> {
    const cached = this.#snapshots.get(sessionId);
    if (cached !== undefined) return cached;
    const loading: Promise<QuizSnapshot | null> = this.#store.getSnapshot(sessionId).then(
      (snapshot) => {
        // A missing snapshot may exist a moment later (session just created elsewhere): do not cache absence.
        if (snapshot === null) this.#snapshots.deleteIf(sessionId, loading);
        return snapshot;
      },
      (err: unknown) => {
        this.#snapshots.deleteIf(sessionId, loading);
        throw err;
      },
    );
    this.#snapshots.set(sessionId, loading);
    return loading;
  }

  /** Loads only what the phase shows; anything passed in is used as is. */
  async #hostSnapshot(
    meta: SessionMeta,
    snapshot: QuizSnapshot,
    given: {
      aud?: Audience;
      players?: PlayerRecord[];
      scoreboard?: Scoreboard | null;
      result?: StoredQuestionResult | null;
    },
  ): Promise<HostSnapshot> {
    const sessionId = meta.sessionId;
    const [aud, players, scoreboard, result] = await Promise.all([
      given.aud ?? this.#out.audience(sessionId),
      given.players ?? this.#store.listPlayers(sessionId),
      given.scoreboard !== undefined
        ? given.scoreboard
        : meta.phase === 'leaderboard' || meta.phase === 'ended'
          ? this.#store.getScoreboard(sessionId)
          : null,
      given.result !== undefined
        ? given.result
        : meta.phase === 'reveal'
          ? this.#store.getQuestionResult(sessionId, meta.questionIndex)
          : null,
    ]);
    return buildHostSnapshot({
      meta,
      snapshot,
      players,
      connectedPlayerIds: new Set(aud.players.keys()),
      scoreboard,
      result,
    });
  }

  async #playerSnapshot(
    meta: SessionMeta,
    player: PlayerRecord,
    opts: { withResponses: boolean },
  ): Promise<PlayerSnapshot> {
    const sessionId = meta.sessionId;
    const phase = meta.phase;
    const showsQuestion = phase === 'question' || phase === 'revealing' || phase === 'reveal';
    const [snapshot, scoreboard, players, responses, result] = await Promise.all([
      this.#snapshot(sessionId),
      phase === 'lobby' ? null : this.#store.getScoreboard(sessionId),
      phase === 'leaderboard' || phase === 'ended' ? this.#store.listPlayers(sessionId) : [player],
      opts.withResponses && showsQuestion
        ? this.#store.listPlayerResponses(sessionId, meta.questionIndex, player.playerId)
        : [],
      phase === 'reveal' ? this.#store.getQuestionResult(sessionId, meta.questionIndex) : null,
    ]);
    if (snapshot === null) throw new Error(`snapshot missing for session ${sessionId}`);
    return buildPlayerSnapshot({ meta, snapshot, player, players, scoreboard, responses, result });
  }
}
