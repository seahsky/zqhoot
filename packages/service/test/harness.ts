import { afterAll, beforeAll, describe, expect } from 'vitest';
import type { Hono } from 'hono';
import { ServerMessage } from '@zqhoot/protocol';
import type {
  ClientMessage,
  ImageContentType,
  OutboundMessage,
  Quiz,
  QuizInput,
  UploadGrant,
} from '@zqhoot/protocol';
import { DEFAULT_SESSION_TTL_MS } from '@zqhoot/engine';
import type { EngineConfig } from '@zqhoot/engine';
import { DynamoStore, MemoryStore, ensureTable } from '@zqhoot/store';
import type { Store } from '@zqhoot/store';
// The service may not depend on the AWS SDK, so the DynamoDB test plumbing is borrowed from the
// store package's own tests (client with local credentials, unique table names, cleanup).
import {
  SKIP_DYNAMO,
  assertDynamoReachable,
  createTestClient,
  dropTable,
  uniqueTableName,
} from '../../store/test/dynamo-helpers.ts';
import { GameService, MediaError, createHttpApp, stampAndSerialize } from '../src/index.ts';
import type {
  AppEnv,
  Clock,
  GameServiceConfig,
  HostAuth,
  HostIdentity,
  Ids,
  LocalLogin,
  Logger,
  MediaStorage,
  Scheduler,
  Transport,
  Warmer,
} from '../src/index.ts';

/** Year 2100, so DynamoDB Local's own TTL sweeper never deletes test data. */
export const CLOCK_START = 4_102_444_800_000;

export class FakeClock implements Clock {
  #t = CLOCK_START;
  now(): number {
    return this.#t;
  }
  set(t: number): void {
    this.#t = t;
  }
  advance(ms: number): void {
    this.#t += ms;
  }
}

export interface Sent {
  seq: number;
  to: string;
  message: ServerMessage;
}
type OfType<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;

/** Records what would go on the wire, validated against the protocol's server schema. */
export class FakeTransport implements Transport {
  readonly log: Sent[] = [];
  readonly closes: Array<{ connectionId: string; code?: number; reason?: string }> = [];
  /** Connections the transport reports as gone. */
  readonly gone = new Set<string>();
  readonly #clock: Clock;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  async send(batch: Array<{ connectionId: string; message: OutboundMessage }>) {
    const gone: string[] = [];
    for (const { connectionId, message } of batch) {
      if (this.gone.has(connectionId)) {
        gone.push(connectionId);
        continue;
      }
      const wire = JSON.parse(stampAndSerialize(message, this.#clock.now())) as unknown;
      // `parse` strips unknown keys, so the raw object is what tests inspect; parsing only proves
      // that every message the service builds satisfies the wire schema.
      ServerMessage.parse(wire);
      this.log.push({ seq: this.log.length, to: connectionId, message: wire as ServerMessage });
    }
    return { gone };
  }

  async close(connectionId: string, code?: number, reason?: string): Promise<void> {
    this.closes.push({
      connectionId,
      ...(code !== undefined ? { code } : {}),
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  to(connectionId: string): ServerMessage[] {
    return this.log.filter((s) => s.to === connectionId).map((s) => s.message);
  }

  ofType<T extends ServerMessage['type']>(connectionId: string, type: T): OfType<T>[] {
    return this.to(connectionId).filter((m): m is OfType<T> => m.type === type);
  }

  last<T extends ServerMessage['type']>(connectionId: string, type: T): OfType<T> {
    const found = this.ofType(connectionId, type).at(-1);
    if (found === undefined) {
      throw new Error(
        `no '${type}' message to ${connectionId}; got [${this.to(connectionId).map((m) => m.type)}]`,
      );
    }
    return found;
  }

  closed(connectionId: string): boolean {
    return this.closes.some((c) => c.connectionId === connectionId);
  }

  clear(): void {
    this.log.length = 0;
    this.closes.length = 0;
  }
}

let nextPin = 100_000 + Math.floor(Math.random() * 800_000);

/** Deterministic per harness, unique per process, so harnesses can share one DynamoDB table. */
export class FakeIds implements Ids {
  readonly #nonce: string;
  readonly #counts = { session: 0, player: 0, quiz: 0, media: 0, token: 0 };

  constructor(nonce: string) {
    this.#nonce = nonce;
  }
  #next(kind: 'session' | 'player' | 'quiz' | 'media' | 'token', prefix: string): string {
    return `${prefix}${this.#nonce}-${String(++this.#counts[kind]).padStart(3, '0')}`;
  }
  sessionId(): string {
    return this.#next('session', 's');
  }
  playerId(): string {
    return this.#next('player', 'p');
  }
  quizId(): string {
    return this.#next('quiz', 'q');
  }
  mediaId(): string {
    return this.#next('media', 'm');
  }
  token(): string {
    return this.#next('token', 'tok').padEnd(43, 'x');
  }
  pin(): string {
    nextPin = nextPin >= 999_999 ? 100_000 : nextPin + 1;
    return String(nextPin);
  }
}

export const HOST_TOKENS = { a: 'token-host-a', b: 'token-host-b' } as const;
export type HostKey = keyof typeof HOST_TOKENS;

/** Host ids carry the harness nonce: quizzes and session lists are per host, and harnesses share a table. */
export class FakeHostAuth implements HostAuth {
  readonly ids: Record<HostKey, string>;
  readonly identities: Map<string, HostIdentity>;

  constructor(nonce: string) {
    this.ids = { a: `host-a-${nonce}`, b: `host-b-${nonce}` };
    this.identities = new Map<string, HostIdentity>([
      [HOST_TOKENS.a, { hostId: this.ids.a, displayName: 'Host A' }],
      [HOST_TOKENS.b, { hostId: this.ids.b, displayName: 'Host B' }],
    ]);
  }
  async verify(token: string): Promise<HostIdentity | null> {
    return this.identities.get(token) ?? null;
  }
}

const EXTENSIONS: Record<ImageContentType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export class FakeMedia implements MediaStorage {
  readonly uploads: Array<{ host: HostIdentity; contentType: string; size: number }> = [];
  readonly stored = new Map<string, { contentType: string; bytes: number }>();
  /** Replaces the storing step, to make it fail. */
  putOverride: MediaStorage['put'] | undefined;
  readonly #ids: Ids;
  put?: MediaStorage['put'];

  constructor(ids: Ids, withPut: boolean) {
    this.#ids = ids;
    if (withPut)
      this.put = (key, token, contentType, body) => this.#put(key, token, contentType, body);
  }

  async createUpload(
    host: HostIdentity,
    req: { contentType: ImageContentType; size: number },
    now: number,
  ): Promise<UploadGrant> {
    this.uploads.push({ host, contentType: req.contentType, size: req.size });
    const slug = host.hostId.replace(/[^A-Za-z0-9_-]/g, '_');
    const key =
      `media/${slug}/${this.#ids.mediaId()}.${EXTENSIONS[req.contentType]}` as UploadGrant['key'];
    return {
      key,
      upload: {
        method: 'PUT',
        url: `/api/media/${key}?t=grant-${key}`,
        headers: { 'Content-Type': req.contentType },
      },
      expiresAt: now + 300_000,
    };
  }

  async #put(
    key: string,
    token: string,
    contentType: string,
    body: ReadableStream<Uint8Array>,
  ): Promise<void> {
    if (this.putOverride !== undefined) return this.putOverride(key, token, contentType, body);
    if (token !== `grant-${key}`) throw new MediaError('token', 'bad upload token');
    if (!(contentType in EXTENSIONS)) throw new MediaError('type', 'unsupported type');
    const reader = body.getReader();
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
    }
    this.stored.set(key, { contentType, bytes });
  }
}

export class FakeScheduler implements Scheduler {
  readonly scheduled: Array<{ sessionId: string; questionIndex: number; at: number }> = [];
  readonly cancelled: string[] = [];
  scheduleClose(sessionId: string, questionIndex: number, at: number): void {
    this.scheduled.push({ sessionId, questionIndex, at });
  }
  cancel(sessionId: string): void {
    this.cancelled.push(sessionId);
  }
}

type Level = 'debug' | 'info' | 'warn' | 'error';
export class TestLogger implements Logger {
  readonly entries: Record<Level, Array<{ o: Record<string, unknown>; m?: string | undefined }>> = {
    debug: [],
    info: [],
    warn: [],
    error: [],
  };
  debug(o: object, m?: string) {
    this.entries.debug.push({ o: o as Record<string, unknown>, m });
  }
  info(o: object, m?: string) {
    this.entries.info.push({ o: o as Record<string, unknown>, m });
  }
  warn(o: object, m?: string) {
    this.entries.warn.push({ o: o as Record<string, unknown>, m });
  }
  error(o: object, m?: string) {
    this.entries.error.push({ o: o as Record<string, unknown>, m });
  }
}

export type RawBody = string | Uint8Array | ReadableStream<Uint8Array>;

export interface ApiResult {
  status: number;
  headers: Headers;
  text: string;
  json<T = any>(): T;
}

export interface HarnessOptions {
  revealSettleMs?: number;
  allowedOrigins?: string[];
  nicknameAttempts?: number;
  engine?: Partial<EngineConfig>;
  scheduler?: boolean;
  /** Media fake with or without the VM-only `put`. Default: with. */
  mediaPut?: boolean;
  localLogin?: LocalLogin;
  warmer?: Warmer;
  /** Runs while the service sleeps (the reveal settle window), before the fake clock advances. */
  onSleep?: (ms: number) => Promise<void>;
}

export type StoreKind = 'memory' | 'dynamo';

export interface Harness {
  kind: StoreKind;
  nonce: string;
  clock: FakeClock;
  transport: FakeTransport;
  ids: FakeIds;
  hostAuth: FakeHostAuth;
  /** The host ids behind the two bearer tokens. */
  hostIds: Record<HostKey, string>;
  media: FakeMedia;
  scheduler: FakeScheduler;
  logger: TestLogger;
  sleeps: number[];
  /** The store the service and app use: the real one behind a proxy that counts and can override calls. */
  store: Store;
  /** The store itself, for overrides that delegate to it. */
  real: Store;
  /** Replaces store methods for the calls that follow; assign `{}` to restore the real ones. */
  overrides: Partial<Record<keyof Store, (...args: any[]) => unknown>>;
  calls: string[];
  service: GameService;
  app: Hono<AppEnv>;
  engine: EngineConfig;
  config: GameServiceConfig;
  /** Unique connection id for this harness. */
  cid(name: string): string;
  ip: string;
  api(
    method: string,
    path: string,
    opts?: {
      token?: string;
      body?: unknown;
      ip?: string;
      headers?: Record<string, string>;
      raw?: RawBody;
    },
  ): Promise<ApiResult>;
  send(
    connectionId: string,
    message: ClientMessage | Record<string, unknown>,
    receivedAt?: number,
  ): Promise<void>;
  createQuiz(input: QuizInput, who?: HostKey): Promise<Quiz>;
  startSession(quizId: string, who?: HostKey): Promise<{ sessionId: string; pin: string }>;
  hostHello(
    name: string,
    sessionId: string,
    who?: HostKey,
    client?: 'control' | 'present',
  ): Promise<string>;
  join(
    name: string,
    pin: string,
    nickname: string,
  ): Promise<{
    connectionId: string;
    playerId: string;
    token: string;
    sessionId: string;
  }>;
  resetCalls(): void;
}

export type MakeHarness = (opts?: HarnessOptions) => Promise<Harness>;

export async function createHarness(
  kind: StoreKind,
  makeStore: (clock: Clock) => Store,
  opts: HarnessOptions = {},
): Promise<Harness> {
  const nonce = Math.random().toString(36).slice(2, 6);
  const clock = new FakeClock();
  const transport = new FakeTransport(clock);
  const ids = new FakeIds(nonce);
  const hostAuth = new FakeHostAuth(nonce);
  const media = new FakeMedia(ids, opts.mediaPut ?? true);
  const scheduler = new FakeScheduler();
  const logger = new TestLogger();
  const sleeps: number[] = [];
  const calls: string[] = [];
  const state: { overrides: Harness['overrides'] } = { overrides: {} };

  const real = makeStore(clock);
  const store = new Proxy(real, {
    get(target, prop) {
      const name = String(prop);
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.push(name);
        const replacement = state.overrides[name as keyof Store];
        return replacement !== undefined
          ? replacement(...args)
          : (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });

  const engine: EngineConfig = {
    minLeadMs: 750,
    answerGraceMs: 750,
    sessionTtlMs: DEFAULT_SESSION_TTL_MS,
    ...opts.engine,
  };
  const config: GameServiceConfig = {
    engine,
    revealSettleMs: opts.revealSettleMs ?? 0,
    allowedOrigins: opts.allowedOrigins ?? [],
    nicknameAttemptsPerConnection: opts.nicknameAttempts ?? 10,
  };
  const service = new GameService({
    store,
    transport,
    clock,
    ids,
    hostAuth,
    ...(opts.scheduler ? { scheduler } : {}),
    logger,
    sleep: async (ms) => {
      sleeps.push(ms);
      await opts.onSleep?.(ms);
      clock.advance(ms);
    },
    config,
  });
  const ip = `ip-${nonce}`;
  const app = createHttpApp({
    store,
    clock,
    ids,
    hostAuth,
    media,
    ...(opts.warmer ? { warmer: opts.warmer } : {}),
    ...(opts.localLogin ? { localLogin: opts.localLogin } : {}),
    logger,
    engine,
    info: { target: 'vm', version: 'test' },
    clientIp: (c) => c.req.header('x-test-ip') ?? ip,
  });

  const h: Harness = {
    kind,
    nonce,
    clock,
    transport,
    ids,
    hostAuth,
    hostIds: hostAuth.ids,
    media,
    scheduler,
    logger,
    sleeps,
    store,
    real,
    get overrides() {
      return state.overrides;
    },
    set overrides(value) {
      state.overrides = value;
    },
    calls,
    service,
    app,
    engine,
    config,
    ip,
    cid: (name) => `${nonce}-${name}`,
    resetCalls: () => {
      calls.length = 0;
    },
    async api(method, path, o = {}) {
      const headers: Record<string, string> = { ...o.headers };
      if (o.token !== undefined) headers.authorization = `Bearer ${o.token}`;
      if (o.ip !== undefined) headers['x-test-ip'] = o.ip;
      let body: RawBody | undefined = o.raw;
      if (o.body !== undefined) {
        body = JSON.stringify(o.body);
        headers['content-type'] = 'application/json';
      }
      const res = await app.request(path, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        // Node requires this for a streamed request body.
        ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
      } as RequestInit);
      // `res.text()` would drop a UTF-8 BOM, which the CSV export must keep.
      const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer());
      return {
        status: res.status,
        headers: res.headers,
        text,
        json: <T = any>() => JSON.parse(text) as T,
      };
    },
    async send(connectionId, message, receivedAt) {
      await service.onMessage(connectionId, JSON.stringify(message), receivedAt ?? clock.now());
    },
    async createQuiz(input, who = 'a') {
      const res = await h.api('POST', '/api/quizzes', { token: HOST_TOKENS[who], body: input });
      expect(res.status, res.text).toBe(200);
      return res.json<Quiz>();
    },
    async startSession(quizId, who = 'a') {
      const res = await h.api('POST', '/api/sessions', {
        token: HOST_TOKENS[who],
        body: { quizId },
      });
      expect(res.status, res.text).toBe(200);
      return res.json();
    },
    async hostHello(name, sessionId, who = 'a', client = 'control') {
      const connectionId = h.cid(name);
      await service.onConnect(connectionId, {});
      await h.send(connectionId, {
        type: 'host.hello',
        v: 1,
        sessionId,
        client,
        authToken: HOST_TOKENS[who],
      });
      expect(transport.last(connectionId, 'welcome').role).toBe('host');
      return connectionId;
    },
    async join(name, pin, nickname) {
      const connectionId = h.cid(name);
      await service.onConnect(connectionId, {});
      await h.send(connectionId, { type: 'join', v: 1, pin, nickname });
      const welcome = transport.last(connectionId, 'welcome');
      if (welcome.role !== 'player' || welcome.credentials === undefined) {
        throw new Error(`join of ${nickname} did not produce credentials`);
      }
      return { connectionId, ...welcome.credentials };
    },
  };
  return h;
}

/**
 * Defines the same tests against `MemoryStore` and, when DynamoDB Local is reachable, against
 * `DynamoStore` (`ZQ_DDB_ENDPOINT`, default http://localhost:8000; `ZQ_SKIP_DYNAMO=1` skips).
 * The DynamoDB table is created once per suite; every harness keeps its ids, PINs, IPs and
 * connection ids unique, so harnesses share it.
 */
export function describeWithStores(
  title: string,
  define: (make: MakeHarness, kind: StoreKind) => void,
): void {
  describe(`${title} [MemoryStore]`, () => {
    define(
      (opts) =>
        createHarness('memory', (clock) => new MemoryStore({ now: () => clock.now() }), opts),
      'memory',
    );
  });
  describe.skipIf(SKIP_DYNAMO)(`${title} [DynamoStore]`, () => {
    const client = createTestClient();
    let tableName = '';
    beforeAll(async () => {
      await assertDynamoReachable();
      tableName = uniqueTableName('service');
      await ensureTable(client, tableName);
    });
    afterAll(async () => {
      if (tableName !== '') await dropTable(client, tableName);
    });
    define(
      (opts) =>
        createHarness(
          'dynamo',
          (clock) => new DynamoStore({ tableName, client, now: () => clock.now() }),
          opts,
        ),
      'dynamo',
    );
  });
}
