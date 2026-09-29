import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  CreateSessionRequest,
  Id,
  LIMITS,
  LoginRequest,
  MediaKey,
  Pin,
  QuizInput,
  QuizUpdate,
  UploadRequest,
} from '@zqhoot/protocol';
import type { PinLookupResponse, Quiz } from '@zqhoot/protocol';
import { buildResultsCsv, checkJoinable, createSession, isExpired } from '@zqhoot/engine';
import type { EngineConfig, ResponseRecord } from '@zqhoot/engine';
import { ConflictError } from '@zqhoot/store';
import type { Store } from '@zqhoot/store';
import { MediaError, noopLogger } from './ports.ts';
import type {
  Clock,
  HostAuth,
  HostIdentity,
  Ids,
  LocalLogin,
  Logger,
  MediaStorage,
  Warmer,
} from './ports.ts';

export interface HttpAppDeps {
  store: Store;
  clock: Clock;
  ids: Ids;
  hostAuth: HostAuth;
  media: MediaStorage;
  warmer?: Warmer;
  logger?: Logger;
  localLogin?: LocalLogin;
  engine: EngineConfig;
  info: { target: 'aws' | 'vm'; version: string };
  /** Adapters decide how to read it (API Gateway request context vs X-Forwarded-For). */
  clientIp: (c: Context) => string | undefined;
}

/** Per-request values the middleware sets; part of the returned app's type. */
export interface AppEnv {
  Variables: { host: HostIdentity; requestId: string };
}

const JSON_BODY_LIMIT = 256 * 1024;
const PIN_LOOKUP_LIMIT = 30;
const PIN_LOOKUP_WINDOW_MS = 60_000;
const LOGIN_LIMIT = 10;
const LOGIN_WINDOW_MS = 900_000;
const PIN_ALLOCATION_ATTEMPTS = 10;
const WARM_WAIT_MS = 500;
const SESSION_LIST_LIMIT = 20;
const MAX_BEARER_LENGTH = 4096;
const MEDIA_PREFIX = '/api/media/';

const JOIN_REASONS = {
  'session-ended': 'ended',
  'session-locked': 'locked',
  'session-full': 'full',
} as const;

/** Thrown by handlers and helpers; `onError` turns it into an `ApiError` body. */
class ApiFailure extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: string;
  readonly headers: Record<string, string> | undefined;

  constructor(
    status: ContentfulStatusCode,
    code: string,
    message: string,
    headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'ApiFailure';
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

const badRequest = (message: string) => new ApiFailure(400, 'bad-request', message);
const notFound = (message = 'not found') => new ApiFailure(404, 'not-found', message);

/** Start of the next fixed window, the same windows `Store.hitRateLimit` counts in. */
const windowEnd = (now: number, windowMs: number): number => now - (now % windowMs) + windowMs;

const tooManyRequests = (now: number, until: number) =>
  new ApiFailure(429, 'rate-limited', 'too many requests, try again later', {
    'Retry-After': String(Math.max(1, Math.ceil((until - now) / 1000))),
  });

function mediaFailure(err: MediaError): ApiFailure {
  switch (err.kind) {
    case 'token':
      return new ApiFailure(403, 'forbidden', err.message);
    case 'size':
      return new ApiFailure(413, 'payload-too-large', err.message);
    case 'type':
      return new ApiFailure(415, 'bad-request', err.message);
    case 'key':
      return badRequest(err.message);
  }
}

/** Counts bytes as they stream past and errors the stream once the limit is crossed. */
function limitStream(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
  onExceeded: () => void,
): ReadableStream<Uint8Array> {
  let seen = 0;
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes) {
          onExceeded();
          throw new MediaError('size', 'upload is too large');
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

/** The part of a zod schema this file uses; the service does not depend on zod itself. */
interface Parser<T> {
  safeParse(
    value: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } };
}

async function parseBody<T>(c: Context, schema: Parser<T>): Promise<T> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw badRequest('request body is not valid JSON');
  }
  return parseWith(schema, json);
}

function parseWith<T>(schema: Parser<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where =
      issue === undefined ? '' : ` (${issue.path.join('.') || 'body'}: ${issue.message})`;
    throw badRequest(`invalid request${where}`.slice(0, 300));
  }
  return parsed.data;
}

function idParam(c: Context, name: string): string {
  const parsed = Id.safeParse(c.req.param(name));
  if (!parsed.success) throw badRequest(`invalid ${name}`);
  return parsed.data;
}

/** UTF-16 truncation that never leaves half of a surrogate pair behind. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end).trimEnd();
}

export function createHttpApp(deps: HttpAppDeps): Hono<AppEnv> {
  const { store, clock, ids, hostAuth, media } = deps;
  const log = deps.logger ?? noopLogger;
  const app = new Hono<AppEnv>();

  // ---- Cross-cutting -----------------------------------------------------------------

  app.use('*', async (c, next) => {
    const incoming = c.req.header('x-request-id');
    const requestId =
      incoming !== undefined && /^[\w-]{1,64}$/.test(incoming) ? incoming : crypto.randomUUID();
    c.set('requestId', requestId);
    await next();
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Request-Id', requestId);
  });

  const jsonLimit = bodyLimit({
    maxSize: JSON_BODY_LIMIT,
    onError: (c) =>
      c.json({ error: 'payload-too-large', message: 'request body is too large' }, 413),
  });
  app.use('/api/*', (c, next) =>
    // Media uploads are bounded while they stream, by the PUT handler itself.
    c.req.method === 'PUT' && c.req.path.startsWith(MEDIA_PREFIX) ? next() : jsonLimit(c, next),
  );

  app.onError((err, c) => {
    if (err instanceof ApiFailure) {
      return c.json({ error: err.code, message: err.message }, err.status, err.headers);
    }
    if (err instanceof HTTPException) return err.getResponse();
    log.error(
      {
        requestId: c.get('requestId'),
        method: c.req.method,
        path: c.req.path,
        err: err instanceof Error ? { message: err.message, stack: err.stack } : String(err),
      },
      'unhandled error in http handler',
    );
    return c.json({ error: 'internal', message: 'internal error' }, 500);
  });

  app.notFound((c) => c.json({ error: 'not-found', message: 'not found' }, 404));

  const requireHost: MiddlewareHandler<AppEnv> = async (c, next) => {
    const header = c.req.header('authorization');
    const match = header === undefined ? null : /^Bearer\s+(\S+)$/i.exec(header);
    const token = match?.[1];
    const identity =
      token === undefined || token.length > MAX_BEARER_LENGTH ? null : await hostAuth.verify(token);
    if (identity === null) {
      throw new ApiFailure(401, 'unauthorized', 'missing or invalid bearer token', {
        'WWW-Authenticate': 'Bearer',
      });
    }
    c.set('host', identity);
    await next();
  };

  const clientIp = (c: Context): string => deps.clientIp(c) ?? 'unknown';

  // ---- Public ------------------------------------------------------------------------

  app.get('/api/health', (c) =>
    c.json({ ok: true as const, version: deps.info.version, target: deps.info.target }),
  );

  app.get('/api/join/:pin', async (c) => {
    const parsed = Pin.safeParse(c.req.param('pin'));
    if (!parsed.success) throw badRequest('invalid PIN');
    const ip = clientIp(c);
    const now = clock.now();

    const counter = `pin:${ip}`;

    // The block lives in the store, not in this instance: another Lambda container must refuse
    // a valid PIN from an IP that went over the limit, or a 200 among 429s would still tell an
    // attacker which guesses are live.
    if (!(await store.peekRateLimit(counter, PIN_LOOKUP_LIMIT, PIN_LOOKUP_WINDOW_MS, now))) {
      throw tooManyRequests(now, windowEnd(now, PIN_LOOKUP_WINDOW_MS));
    }

    const found = await lookupPin(parsed.data, now);
    if (found !== null) return c.json(found);

    // Only misses count: a classroom shares one IP and every phone looks up a valid PIN.
    if (!(await store.hitRateLimit(counter, PIN_LOOKUP_LIMIT, PIN_LOOKUP_WINDOW_MS, now))) {
      throw tooManyRequests(now, windowEnd(now, PIN_LOOKUP_WINDOW_MS));
    }
    throw notFound('no game with that PIN');
  });

  async function lookupPin(pin: string, now: number): Promise<PinLookupResponse | null> {
    const sessionId = await store.getSessionIdByPin(pin);
    if (sessionId === null) return null;
    const meta = await store.getSession(sessionId);
    if (meta === null || isExpired(meta, now)) return null;
    const check = checkJoinable(meta, await store.countPlayers(sessionId), now);
    if (check.ok) return { sessionId, quizTitle: meta.quizTitle, joinable: true };
    if (check.code === 'not-found') return null;
    return {
      sessionId,
      quizTitle: meta.quizTitle,
      joinable: false,
      reason: JOIN_REASONS[check.code],
    };
  }

  const localLogin = deps.localLogin;
  if (localLogin !== undefined) {
    app.post('/api/auth/login', async (c) => {
      const now = clock.now();
      // Counted before the body is read: scrypt is the expensive part, and every attempt counts.
      const within = await store.hitRateLimit(
        `login:${clientIp(c)}`,
        LOGIN_LIMIT,
        LOGIN_WINDOW_MS,
        now,
      );
      if (!within) throw tooManyRequests(now, windowEnd(now, LOGIN_WINDOW_MS));
      const body = await parseBody(c, LoginRequest);
      const session = await localLogin.login(body.username, body.password);
      if (session === null) {
        throw new ApiFailure(401, 'unauthorized', 'invalid username or password');
      }
      return c.json({ token: session.token, expiresAt: session.expiresAt });
    });
  }

  // ---- Host: identity and quizzes ------------------------------------------------------

  app.get('/api/me', requireHost, (c) => {
    const host = c.get('host');
    return c.json({ hostId: host.hostId, displayName: host.displayName });
  });

  app.get('/api/quizzes', requireHost, async (c) =>
    c.json(await store.listQuizzes(c.get('host').hostId)),
  );

  app.post('/api/quizzes', requireHost, async (c) => {
    const input = await parseBody(c, QuizInput);
    const now = clock.now();
    const quiz: Quiz = {
      id: ids.quizId(),
      ownerId: c.get('host').hostId,
      title: input.title,
      questions: input.questions,
      settings: input.settings,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await store.putQuiz(quiz);
    return c.json(quiz);
  });

  app.get('/api/quizzes/:id', requireHost, async (c) => {
    const quiz = await store.getQuiz(c.get('host').hostId, idParam(c, 'id'));
    if (quiz === null) throw notFound('no such quiz');
    return c.json(quiz);
  });

  app.put('/api/quizzes/:id', requireHost, async (c) => {
    const id = idParam(c, 'id');
    const update = await parseBody(c, QuizUpdate);
    const input = parseWith(QuizInput, update.quiz);
    const existing = await store.getQuiz(c.get('host').hostId, id);
    if (existing === null) throw notFound('no such quiz');
    const conflict = new ApiFailure(409, 'conflict', 'the quiz was changed elsewhere');
    if (existing.version !== update.expectedVersion) throw conflict;
    const quiz: Quiz = {
      ...existing,
      title: input.title,
      questions: input.questions,
      settings: input.settings,
      version: existing.version + 1,
      updatedAt: clock.now(),
    };
    try {
      await store.putQuiz(quiz, update.expectedVersion);
    } catch (err) {
      // Someone saved between our read and our write.
      if (err instanceof ConflictError) throw conflict;
      throw err;
    }
    return c.json(quiz);
  });

  app.delete('/api/quizzes/:id', requireHost, async (c) => {
    const hostId = c.get('host').hostId;
    const id = idParam(c, 'id');
    // Sessions keep their own snapshot, so deleting the quiz never touches them.
    if ((await store.getQuiz(hostId, id)) === null) throw notFound('no such quiz');
    await store.deleteQuiz(hostId, id);
    return c.body(null, 204);
  });

  app.post('/api/quizzes/:id/duplicate', requireHost, async (c) => {
    const hostId = c.get('host').hostId;
    const source = await store.getQuiz(hostId, idParam(c, 'id'));
    if (source === null) throw notFound('no such quiz');
    const now = clock.now();
    const copy: Quiz = {
      ...source,
      id: ids.quizId(),
      title: truncate(`Copy of ${source.title}`, LIMITS.quizTitleMax),
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await store.putQuiz(copy);
    return c.json(copy);
  });

  // ---- Host: media ---------------------------------------------------------------------

  app.post('/api/media/uploads', requireHost, async (c) => {
    const request = await parseBody(c, UploadRequest);
    try {
      return c.json(await media.createUpload(c.get('host'), request, clock.now()));
    } catch (err) {
      if (err instanceof MediaError) throw mediaFailure(err);
      throw err;
    }
  });

  const putMedia = media.put?.bind(media);
  if (putMedia !== undefined) {
    // Authorised by the grant token in the query string, not by a bearer token: the browser
    // sends this request to the URL returned from `POST /api/media/uploads`.
    app.put(`${MEDIA_PREFIX}*`, async (c) => {
      const key = MediaKey.safeParse(c.req.path.slice(MEDIA_PREFIX.length));
      if (!key.success) throw badRequest('invalid media key');
      const token = c.req.query('t');
      if (token === undefined || token === '') {
        throw new ApiFailure(403, 'forbidden', 'missing upload token');
      }
      const declared = Number(c.req.header('content-length'));
      const tooLarge = () => new ApiFailure(413, 'payload-too-large', 'upload is too large');
      if (declared > LIMITS.imageMaxBytes) throw tooLarge();
      const body = c.req.raw.body;
      if (body === null) throw badRequest('missing upload body');

      let exceeded = false;
      const limited = limitStream(body, LIMITS.imageMaxBytes, () => {
        exceeded = true;
      });
      try {
        await putMedia(key.data, token, c.req.header('content-type') ?? '', limited);
      } catch (err) {
        // The storage may wrap or replace the error it saw on the stream.
        if (exceeded) throw tooLarge();
        if (err instanceof MediaError) throw mediaFailure(err);
        throw err;
      }
      return c.body(null, 204);
    });
  }

  // ---- Host: sessions ------------------------------------------------------------------

  app.post('/api/sessions', requireHost, async (c) => {
    const hostId = c.get('host').hostId;
    const { quizId } = await parseBody(c, CreateSessionRequest);
    const quiz = await store.getQuiz(hostId, quizId);
    if (quiz === null) throw notFound('no such quiz');
    const now = clock.now();
    const sessionId = ids.sessionId();

    // Built once: only the PIN differs between attempts.
    const { meta: draft, snapshot } = createSession({
      sessionId,
      pin: ids.pin(),
      hostId,
      quiz,
      now,
      cfg: deps.engine,
    });
    for (let attempt = 0; attempt < PIN_ALLOCATION_ATTEMPTS; attempt++) {
      const pin = attempt === 0 ? draft.pin : ids.pin();
      const meta = { ...draft, pin };
      if (!(await store.reservePin(pin, sessionId, meta.expiresAt))) continue;
      try {
        await store.createSession(meta, snapshot);
      } catch (err) {
        await store.releasePin(pin, sessionId).catch(() => undefined);
        throw err;
      }
      await warmUp();
      return c.json({ sessionId, pin });
    }
    throw new ApiFailure(503, 'unavailable', 'could not allocate a PIN, try again', {
      'Retry-After': '1',
    });
  });

  app.get('/api/sessions', requireHost, async (c) =>
    c.json(await store.listSessionsByHost(c.get('host').hostId, SESSION_LIST_LIMIT)),
  );

  app.get('/api/sessions/:id/results.csv', requireHost, async (c) => {
    const sessionId = idParam(c, 'id');
    const meta = await store.getSession(sessionId);
    // 404 for another host's session as well, so its existence is not disclosed.
    if (meta === null || meta.hostId !== c.get('host').hostId) throw notFound('no such session');
    const [snapshot, players, scoreboard, results] = await Promise.all([
      store.getSnapshot(sessionId),
      store.listPlayers(sessionId),
      store.getScoreboard(sessionId),
      store.listQuestionResults(sessionId),
    ]);
    if (snapshot === null) throw notFound('no such session');
    const responsesByQuestion: ResponseRecord[][] = snapshot.questions.map(() => []);
    await Promise.all(
      results.map(async (result) => {
        responsesByQuestion[result.questionIndex] = await store.listResponses(
          sessionId,
          result.questionIndex,
        );
      }),
    );
    const csv = buildResultsCsv({
      meta,
      snapshot,
      players,
      scoreboard,
      results,
      responsesByQuestion,
    });
    const day = new Date(meta.createdAt).toISOString().slice(0, 10);
    return c.body(csv, 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="zqhoot-${meta.pin}-${day}.csv"`,
    });
  });

  /** Waits at most 500 ms for the warm-up: on Lambda the invocations must be issued before the response. */
  async function warmUp(): Promise<void> {
    const warmer = deps.warmer;
    if (warmer === undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const warming = Promise.resolve()
      .then(() => warmer.warm())
      .catch((err: unknown) => {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, 'warm-up failed');
      });
    const patience = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, WARM_WAIT_MS);
    });
    try {
      await Promise.race([warming, patience]);
    } finally {
      clearTimeout(timer);
    }
  }

  return app;
}
