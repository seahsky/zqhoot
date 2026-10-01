import { TIMING, ServerMessage } from '@zqhoot/protocol';
import type { ClientMessage, OutboundMessage, QuizInput } from '@zqhoot/protocol';
import { DynamoStore } from '@zqhoot/store';
import { GameService, createHttpApp, stampAndSerialize } from '@zqhoot/service';
import type { Clock, HostAuth, Transport } from '@zqhoot/service';
import { createIds } from '../../src/ports/ids.ts';
import { createWsHandler } from '../../src/ws-handler.ts';
import type { HandlerResult, WebSocketEvent } from '../../src/ws-handler.ts';
import { createDocClient, createTable, dropTable, uniqueTableName } from './dynamo.ts';

/** Year 2100: DynamoDB Local's own TTL sweeper never touches these items. */
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
  to: string;
  message: ServerMessage;
}

/** Records what the API Gateway transport would put on the wire. */
export class StubTransport implements Transport {
  readonly log: Sent[] = [];
  readonly closed: string[] = [];
  readonly #clock: Clock;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  async send(batch: Array<{ connectionId: string; message: OutboundMessage }>) {
    for (const { connectionId, message } of batch) {
      const wire = JSON.parse(stampAndSerialize(message, this.#clock.now())) as unknown;
      this.log.push({ to: connectionId, message: ServerMessage.parse(wire) });
    }
    return { gone: [] };
  }

  async close(connectionId: string): Promise<void> {
    this.closed.push(connectionId);
  }

  to(connectionId: string): ServerMessage[] {
    return this.log.filter((s) => s.to === connectionId).map((s) => s.message);
  }

  last<T extends ServerMessage['type']>(
    connectionId: string,
    type: T,
  ): Extract<ServerMessage, { type: T }> {
    const found = this.to(connectionId)
      .filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type)
      .at(-1);
    if (found === undefined) {
      throw new Error(
        `no '${type}' to ${connectionId}; got [${this.to(connectionId).map((m) => m.type)}]`,
      );
    }
    return found;
  }
}

export const SITE_ORIGIN = 'https://quiz.example.com';
export const HOST_TOKEN = 'host-token';

export const twoQuestionQuiz = (timeLimitSec = 10): QuizInput => ({
  title: 'Handlers',
  settings: { streakBonus: false, showQuestionOnDevices: true, readSeconds: 0 },
  questions: [
    {
      id: 'q-first',
      type: 'single',
      prompt: 'Two plus two?',
      timeLimitSec,
      options: [
        { id: 'opt-three', text: '3' },
        { id: 'opt-four', text: '4' },
      ],
      correctOptionId: 'opt-four',
      points: 1,
    },
    {
      id: 'q-second',
      type: 'single',
      prompt: 'Two times three?',
      timeLimitSec,
      options: [
        { id: 'opt-five', text: '5' },
        { id: 'opt-six', text: '6' },
      ],
      correctOptionId: 'opt-six',
      points: 1,
    },
  ],
});

export interface Harness {
  clock: FakeClock;
  transport: StubTransport;
  store: DynamoStore;
  service: GameService;
  /** The ws handler, wired to `service`. */
  handler: ReturnType<typeof createWsHandler>;
  sleeps: number[];
  /** Unique per harness, so parallel files can share a table. */
  cid(name: string): string;
  /** `null` sends the event without a header map at all. */
  connect(name: string, headers?: Record<string, string> | null): Promise<HandlerResult>;
  /**
   * `sourceIp` is API Gateway's `requestContext.identity.sourceIp` of the frame: a fixed address
   * unless given, and no `identity` at all for `null`.
   */
  send(
    name: string,
    message: ClientMessage | Record<string, unknown> | string,
    epoch?: number,
    sourceIp?: string | null,
  ): Promise<HandlerResult>;
  disconnect(name: string): Promise<HandlerResult>;
  createSession(quiz?: QuizInput): Promise<{ sessionId: string; pin: string }>;
  close(): Promise<void>;
}

/**
 * The real ws handler on a real `GameService` and `DynamoStore` (DynamoDB Local), with a stub
 * transport and a controllable clock. Sessions are created through the shared HTTP app, as a host
 * would.
 */
export async function createHarness(label: string): Promise<Harness> {
  const doc = createDocClient();
  const tableName = uniqueTableName(label);
  await createTable(doc, tableName);

  const clock = new FakeClock();
  const nonce = Math.random().toString(36).slice(2, 8);
  const store = new DynamoStore({ tableName, client: doc, now: () => clock.now() });
  const transport = new StubTransport(clock);
  const ids = createIds();
  const hostAuth: HostAuth = {
    verify: async (token) =>
      token === HOST_TOKEN ? { hostId: `host-${nonce}`, displayName: 'Host' } : null,
  };
  const engine = {
    minLeadMs: TIMING.minLeadMs.lambda,
    answerGraceMs: TIMING.answerGraceMs,
    sessionTtlMs: 30 * 86_400_000,
  };
  // The settle wait advances the fake clock instead of sleeping.
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    clock.advance(ms);
  };
  const service = new GameService({
    store,
    transport,
    clock,
    ids,
    hostAuth,
    sleep,
    config: {
      engine,
      revealSettleMs: 1000,
      allowedOrigins: [SITE_ORIGIN],
      nicknameAttemptsPerConnection: 10,
    },
  });
  const handler = createWsHandler({ service, sleep });
  const app = createHttpApp({
    store,
    clock,
    ids,
    hostAuth,
    media: { createUpload: async () => Promise.reject(new Error('unused')) },
    engine,
    info: { target: 'aws', version: 'test' },
    clientIp: () => '203.0.113.7',
  });

  const cid = (name: string): string => `${nonce}-${name}=`;

  const event = (
    routeKey: string,
    name: string,
    extra: {
      body?: string;
      epoch?: number;
      headers?: Record<string, string> | undefined;
      sourceIp?: string | null;
    } = {},
  ): WebSocketEvent => ({
    ...(extra.headers !== undefined ? { headers: extra.headers } : {}),
    ...(extra.body !== undefined ? { body: extra.body } : {}),
    requestContext: {
      routeKey,
      connectionId: cid(name),
      requestTimeEpoch: extra.epoch ?? clock.now(),
      ...(extra.sourceIp === null
        ? {}
        : { identity: { sourceIp: extra.sourceIp ?? '198.51.100.9' } }),
    },
  });

  return {
    clock,
    transport,
    store,
    service,
    handler,
    sleeps,
    cid,
    connect: (name, headers = { Origin: SITE_ORIGIN }) =>
      handler(event('$connect', name, headers === null ? {} : { headers })),
    send: (name, message, epoch, sourceIp) =>
      handler(
        event('$default', name, {
          body: typeof message === 'string' ? message : JSON.stringify(message),
          ...(epoch !== undefined ? { epoch } : {}),
          ...(sourceIp !== undefined ? { sourceIp } : {}),
        }),
      ),
    disconnect: (name) => handler(event('$disconnect', name)),
    async createSession(quiz = twoQuestionQuiz()) {
      const auth = { authorization: `Bearer ${HOST_TOKEN}`, 'content-type': 'application/json' };
      const created = await app.request('/api/quizzes', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify(quiz),
      });
      if (created.status !== 200) throw new Error(`quiz create failed: ${await created.text()}`);
      const { id } = (await created.json()) as { id: string };
      const session = await app.request('/api/sessions', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ quizId: id }),
      });
      if (session.status !== 200) throw new Error(`session create failed: ${await session.text()}`);
      return (await session.json()) as { sessionId: string; pin: string };
    },
    close: () => dropTable(doc, tableName),
  };
}
