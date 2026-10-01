import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, ServerMessage } from '@zqhoot/protocol';
import type { ClientMessage, CreateSessionResponse, Quiz, QuizInput } from '@zqhoot/protocol';
import { ADMIN_PASSWORD, ADMIN_USER } from './server.ts';
import type { TestServer } from './server.ts';

type OfType<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** A WebSocket that records every server message, validated against the protocol schema. */
export class TestSocket {
  readonly ws: WebSocket;
  readonly inbox: ServerMessage[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  #waiters: Array<() => void> = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.closed = new Promise((resolve) => {
      ws.on('close', (code, reason) => {
        resolve({ code, reason: reason.toString('utf8') });
        this.#wake();
      });
    });
    ws.on('message', (data) => {
      // `parse` throws on a frame the wire schema rejects, which fails the test that received it.
      this.inbox.push(ServerMessage.parse(JSON.parse(data.toString('utf8'))));
      this.#wake();
    });
  }

  static async connect(
    url: string,
    origin: string | null,
    headers: Record<string, string> = {},
  ): Promise<TestSocket> {
    const ws = new WebSocket(url, {
      headers: { ...headers, ...(origin === null ? {} : { origin }) },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
      ws.once('unexpected-response', (_req, res) =>
        reject(new Error(`unexpected response ${res.statusCode}`)),
      );
    });
    return new TestSocket(ws);
  }

  static async connectTo(
    server: TestServer,
    headers: Record<string, string> = {},
  ): Promise<TestSocket> {
    return TestSocket.connect(server.ws, server.origin, headers);
  }

  send(message: ClientMessage | Record<string, unknown>): void {
    this.ws.send(JSON.stringify(message));
  }

  #wake(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const wake of waiters) wake();
  }

  /** Removes and returns the first inbox message of `type` (matching `where`), waiting for it if needed. */
  async next<T extends ServerMessage['type']>(
    type: T,
    where: (message: OfType<T>) => boolean = () => true,
    timeoutMs = 10_000,
  ): Promise<OfType<T>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.inbox.findIndex((m) => m.type === type && where(m as OfType<T>));
      if (index !== -1) return this.inbox.splice(index, 1)[0] as OfType<T>;
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new Error(
          `no '${type}' message within ${timeoutMs} ms; inbox: [${this.inbox.map((m) => m.type)}]`,
        );
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.#waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  close(): void {
    this.ws.close();
  }
}

export interface Api {
  (method: string, path: string, opts?: { token?: string; body?: unknown }): Promise<Response>;
}

export function apiFor(server: TestServer): Api {
  return (method, path, opts = {}) =>
    fetch(`${server.http}${path}`, {
      method,
      headers: {
        ...(opts.token !== undefined && { Authorization: `Bearer ${opts.token}` }),
        ...(opts.body !== undefined && { 'Content-Type': 'application/json' }),
      },
      ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
    });
}

export async function login(api: Api): Promise<string> {
  const res = await api('POST', '/api/auth/login', {
    body: { username: ADMIN_USER, password: ADMIN_PASSWORD },
  });
  if (res.status !== 200) throw new Error(`login failed with ${res.status}`);
  return ((await res.json()) as { token: string }).token;
}

export const OPTION_A = 'opt-aaaaaa';
export const OPTION_B = 'opt-bbbbbb';

/** Two scored questions: a single choice (A is right) and a true/false question with a 5 s limit. */
export function miniQuiz(
  firstLimitSec: number | null = 10,
  secondLimitSec: number | null = 5,
): QuizInput {
  return {
    title: 'Mini game',
    settings: { streakBonus: false, showQuestionOnDevices: true, readSeconds: 0 },
    questions: [
      {
        id: 'question-one',
        type: 'single',
        prompt: 'Pick A',
        timeLimitSec: firstLimitSec,
        options: [
          { id: OPTION_A, text: 'A' },
          { id: OPTION_B, text: 'B' },
        ],
        correctOptionId: OPTION_A,
        points: 1,
      },
      {
        id: 'question-two',
        type: 'truefalse',
        prompt: 'The sky is blue',
        timeLimitSec: secondLimitSec,
        correct: true,
        points: 1,
      },
    ],
  };
}

export async function createQuiz(
  api: Api,
  token: string,
  quiz: QuizInput = miniQuiz(),
): Promise<Quiz> {
  const res = await api('POST', '/api/quizzes', { token, body: quiz });
  if (res.status !== 200)
    throw new Error(`create quiz failed with ${res.status}: ${await res.text()}`);
  return (await res.json()) as Quiz;
}

export async function createSession(
  api: Api,
  token: string,
  quizId: string,
): Promise<CreateSessionResponse> {
  const res = await api('POST', '/api/sessions', { token, body: { quizId } });
  if (res.status !== 200) throw new Error(`create session failed with ${res.status}`);
  return (await res.json()) as CreateSessionResponse;
}

export async function joinPlayer(
  server: TestServer,
  pin: string,
  nickname: string,
): Promise<{ socket: TestSocket; sessionId: string; playerId: string; token: string }> {
  const socket = await TestSocket.connectTo(server);
  socket.send({ type: 'join', v: PROTOCOL_VERSION, pin, nickname });
  const welcome = await socket.next('welcome');
  if (welcome.role !== 'player' || welcome.credentials === undefined) {
    throw new Error('expected a player welcome with credentials');
  }
  return { socket, ...welcome.credentials };
}

export async function connectHost(
  server: TestServer,
  sessionId: string,
  authToken: string,
): Promise<TestSocket> {
  const socket = await TestSocket.connectTo(server);
  socket.send({ type: 'host.hello', v: PROTOCOL_VERSION, sessionId, client: 'control', authToken });
  await socket.next('welcome');
  return socket;
}
