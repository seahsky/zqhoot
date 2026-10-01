# W2-service: GameService and HTTP app (transport- and store-agnostic)

Owner: Sonnet implementation agent. Reviewer: independent Opus agent.

## Goal

Create `packages/service`, the only place that orchestrates the game:

- It turns WebSocket events and HTTP requests into engine calls.
- It loads and persists through the `Store` interface.
- It delivers messages through a `Transport` port.

Both servers (`apps/server-node`, `apps/server-lambda`) will be thin adapters that construct this service with platform-specific ports, so every piece of game behaviour must live here or in the engine.

Read first:

- `docs/ARCHITECTURE.md` and every ADR, especially 0003-0009 and 0013
- `packages/engine/src/index.ts` and its README/tests (the engine API is merged; use it, never re-implement it)
- `packages/store/src/store.ts` and `packages/store/README.md`
- `packages/protocol/src/*.ts`

## Files you own

- `packages/service/**` (new package `@zqhoot/service`).
- Dependencies: `@zqhoot/protocol`, `@zqhoot/engine`, `@zqhoot/store` (workspace) and `hono@4.13.10`.
- Dev: `@zqhoot/store` is used in tests via `MemoryStore` and `DynamoStore`.
- You may add exactly these to `packages/service/package.json` and run `pnpm install`. Nothing else.

## Ports (`src/ports.ts`)

```ts
export interface Transport {
  /** Serialise, stamp `ts` = clock.now() per recipient immediately before sending, send. Never throws for a gone peer. */
  send(
    batch: Array<{ connectionId: string; message: OutboundMessage }>,
  ): Promise<{ gone: string[] }>;
  close(connectionId: string, code?: number, reason?: string): Promise<void>;
}
export interface Clock {
  now(): number;
}
export interface Ids {
  sessionId(): string;
  playerId(): string;
  quizId(): string;
  /** 32 random bytes, base64url. */
  token(): string;
  /** 6 digits, first digit 1-9. */
  pin(): string;
  mediaId(): string;
}
export interface HostIdentity {
  hostId: string;
  displayName: string;
}
export interface HostAuth {
  verify(token: string): Promise<HostIdentity | null>;
}
export interface LocalLogin {
  login(username: string, password: string): Promise<{ token: string; expiresAt: number } | null>;
}
export interface MediaStorage {
  createUpload(host: HostIdentity, req: UploadRequest, now: number): Promise<UploadGrant>;
  /** VM only: verify the grant token for `key` and persist bytes; throws MediaError on type/size/token problems. */
  put?(
    key: string,
    token: string,
    contentType: string,
    body: ReadableStream<Uint8Array>,
  ): Promise<void>;
}
export interface Warmer {
  warm(): Promise<void>;
}
/** VM only; the Lambda adapter passes a no-op. */
export interface Scheduler {
  scheduleClose(sessionId: string, questionIndex: number, at: number): void;
  cancel(sessionId: string): void;
}
export interface Logger {
  debug(o: object, m?: string): void;
  info(o: object, m?: string): void;
  warn(o: object, m?: string): void;
  error(o: object, m?: string): void;
}
export type Sleep = (ms: number) => Promise<void>;
```

`src/transport-util.ts` exports `stampAndSerialize(message, ts)`, which the adapters use so the `ts` placement is identical on both targets. Adapters must not re-implement it.

## `GameService` (`src/game-service.ts`)

```ts
export interface GameServiceConfig {
  engine: EngineConfig; // minLeadMs per target, answerGraceMs, sessionTtlMs
  revealSettleMs: number; // Lambda 1000, VM 0 (ADR-0006)
  allowedOrigins: string[]; // exact origins accepted on connect (ADR-0013); empty = allow all (tests only)
  nicknameAttemptsPerConnection: number; // 10
}
export class GameService {
  constructor(deps: {
    store: Store;
    transport: Transport;
    clock: Clock;
    ids: Ids;
    hostAuth: HostAuth;
    scheduler?: Scheduler;
    logger?: Logger;
    sleep?: Sleep;
    config: GameServiceConfig;
  });
  onConnect(
    connectionId: string,
    info: { origin?: string; sourceIp?: string },
  ): Promise<{ accept: boolean }>;
  onDisconnect(connectionId: string): Promise<void>;
  /** `receivedAt`: API Gateway requestTimeEpoch or the Node receive time. `raw` is the frame text. */
  onMessage(
    connectionId: string,
    raw: string,
    receivedAt: number,
    info?: { sourceIp?: string },
  ): Promise<void>;
  onTimer(sessionId: string, questionIndex: number): Promise<void>;
  /** Establish store connections for warm-up invocations. */
  warm(): Promise<void>;
}
```

### Message handling (every rule is test-covered)

**Parsing**

- Reject frames larger than `LIMITS.clientMessageMaxBytes` UTF-8 bytes. Parse with `JSON.parse` in a try/catch, then `ClientMessage.safeParse`.
- A failure replies `error {code:'bad-request', ref}` to the sender.
- A `v` mismatch on join/resume/host.hello replies `protocol-version`, then `transport.close`.

**Binding**

- `join`, `resume`, `host.hello` and `ping` need no binding. Everything else requires `store.getConnection(connectionId)` with the right role (player: `answer`, `leave`; host: `host.*`), else `error unauthorized`.
- A host binding is only created after `HostAuth.verify` succeeds and the session's `hostId` matches.

**`ping`**

- Reply `pong {t}` with no store access.

**`join`**

1. Rate-limit nickname attempts per connection with `store.hitRateLimit('nick:'+connectionId, cfg.nicknameAttemptsPerConnection, 3_600_000, now)`. Exceeding it replies `rate-limited` and closes.
2. `getSessionIdByPin` → `getSession` → `countPlayers` → `engine.checkJoinable` → `engine.normalizeNickname`. `nickname-invalid` carries the reason in `message`.
3. Mint `playerId` and `token`; store `sha256Hex(token)` using WebCrypto (`globalThis.crypto.subtle`).
4. `store.addPlayer`. On `'nickname-taken'`, reply that error.
5. `putConnection`, with `expiresAt = min(meta.expiresAt, now + 3 h)`.
6. Send `welcome` with credentials and `buildPlayerSnapshot`. Load only what the phase needs: scoreboard unless lobby, players in leaderboard/ended, the current result in reveal.
7. Send hosts `roster {upsert:[entry]}`.

**`resume`**

1. `getPlayer`, then a constant-time compare of `sha256Hex(token)` with `tokenHash` (via a timing-safe comparison over equal-length hex strings, implemented without Node APIs). A mismatch replies `unauthorized`. A kicked player gets `error kicked`, then close.
2. Session missing or expired → `not-found`.
3. Otherwise:
   - `putConnection` and `updatePlayer {lastSeenAt}`.
   - Send `welcome` with a snapshot including this player's current-question responses and the stored result when in reveal. A session in the `ended` phase still gets a welcome with the ended snapshot.
   - Send hosts `roster {upsert:[{..., connected:true}]}`.

**`host.hello`**

- `verify` → null gives `unauthorized` + close; a different owner gives `forbidden` + close.
- `putConnection` (role host, client), then `welcome` with `buildHostSnapshot`. `connectedPlayerIds` comes from `listConnections`.

**`answer`**

- **Loads:** binding → `getSession` (consistent) → the snapshot, from a per-instance `Map` cache keyed by session ID (snapshots are immutable; cap the cache at 100 entries, LRU).
- **Existing responses:**
  - For `wordcloud` and `open`, load `listPlayerResponses` for `existing`.
  - For single-response types, pass `existing = []` and let the conditional put detect duplicates: on `created:false`, reply `duplicate` if the payload matches the stored one, else `rejected limit`.
- **Decision:** `engine.evaluateAnswer`.
  - accept → `putResponse`. On a lost race for a multi-entry slot, re-evaluate once with the returned existing record added.
  - Ack `answer.ack {status, reason?, entries}`.
- **No other reads or writes.** Specifically, never write META and never notify hosts per answer (hosts poll).

**`leave`**

- `deleteConnection`, then hosts `roster {upsert:[{..., connected:false}]}` unless the player has another live connection.

**`host.next` / `host.close` / `host.skip` / `host.end` / `host.lock`**

- **Transition.**
  - Load meta + snapshot → `engine.applyHostCommand`. On `!ok`, reply an error.
  - Effect `none` → reply `host.state` to the requester only.
  - Else `updateSession(meta, prevVersion)`. On `ConflictError`, reload and re-apply, up to 3 attempts; then reply `conflict`.
- **Effects:**
  - `question-opened`: send `buildQuestionMessage` to every player connection and `host.state` to hosts. Call `scheduler?.scheduleClose(sid, i, deadline + answerGraceMs)` when there is a deadline.
  - `closing`: `await sleep(revealSettleMs)`, then run the reveal (below).
  - `retry-reveal`: run the reveal.
  - `leaderboard`: `buildLeaderboard` → per-player messages + `host.state`.
  - `ended`: `buildEnded` → per-player messages + `host.state`; `releasePin`; `scheduler?.cancel(sid)`.
  - `lock-changed`: `host.state`.
- **Reveal** (idempotent, ADR-0006):
  1. Reload meta; it must be `revealing` for index i, else do nothing.
  2. If a stored result exists and `scoreboard.appliedThrough >= i`, use `revealFromStored`.
  3. Else load responses, players and scoreboard, then `computeReveal`. Write `putQuestionResult` → `putScoreboard(expectedVersion)` → `updateSession(meta', prevVersion)`, in that order.
  4. On a scoreboard `ConflictError`, reload and fall back to `revealFromStored` if the result was stored by a concurrent run.
  5. Send per-player `reveal` messages and `host.state` (with the result) to hosts.

**`host.kick`**

- `updatePlayer {kicked:true}`, then send `kicked` to that player's connections, `transport.close` them, `deleteConnection` them, and send hosts `roster {removed:[pid]}`.

**`host.moderate`**

- `setResponseStatus`.
- If the session is in reveal for that question, update the stored result's open-ended response status and `putQuestionResult`. Use an engine helper; add one to the engine if missing, and report it.
- Reply `host.state` to hosts in reveal. Otherwise the change shows on the next stats poll.

**`host.stats`**

- Snapshot question + `listResponses` + `listPlayers` → `computeLiveStats` → `stats` to the requester only.

**Disconnect and delivery**

- **`onDisconnect`:** `getConnection` → `deleteConnection` → for a player, a roster update as for leave.
- **`onTimer`:** `engine.timerClose`, then as close.
- **Audiences:** resolve with one `listConnections(sessionId)` per broadcast: players by `playerId`, hosts by role. A player may have several connections; send to all of them.
- **Gone handling:** after every `transport.send`, `deleteConnection` each gone ID. For gone players with no remaining connection, send hosts a roster update (`connected:false`).
- **Unexpected errors:** log with the connection ID and message type, reply `error internal`, never crash the process, and never leak stack traces to clients.

## HTTP app (`src/http-app.ts`)

```ts
export function createHttpApp(deps: {
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
  clientIp: (c: Context) => string | undefined; // adapters decide how to read it (API Gateway vs X-Forwarded-For)
}): Hono;
```

Implement every route in `packages/protocol/src/http.ts`, with these rules:

- **Validation.** Every body and parameter is parsed with its zod schema. Invalid input gets 400 `ApiError {error:'bad-request', message}`.
- **Auth.** Host routes use `Authorization: Bearer` → `hostAuth.verify`. Missing or invalid gets 401. Resources owned by another host get **404**, so existence isn't leaked.
- **Headers.** Every response carries `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.
- **Body limits.** `hono/body-limit` at 256 KB for JSON routes. Media PUT is limited to `LIMITS.imageMaxBytes` while streaming.
- **`GET /api/join/:pin`:**
  - Returns `PinLookupResponse`, including `joinable:false` + reason for locked/ended/full.
  - Unknown or expired PIN → 404. Only failed lookups count toward `hitRateLimit('pin:'+ip, 30, 60_000)`; once over the limit, every lookup from that IP gets 429 until the window passes. Classrooms share one IP, so successful lookups must never count.
- **`POST /api/auth/login`:** only if `localLogin` is present (else 404). `hitRateLimit('login:'+ip, 10, 900_000)`.
- **Quizzes:**
  - `ownerId = hostId`; `version` starts at 1 and increments by 1 per PUT.
  - PUT with a stale `expectedVersion` → 409 `conflict`.
  - Duplicate creates a new ID with title `Copy of {title}`, truncated to `LIMITS.quizTitleMax`, and version 1.
  - Deleting a quiz does not affect sessions: they hold snapshots.
- **`POST /api/sessions`:**
  - Load the quiz (404 if not owned). Allocate a PIN with `ids.pin()` + `reservePin`, up to 10 attempts, else 503.
  - `engine.createSession` → `store.createSession`.
  - `warmer?.warm()`, not awaited for more than 500 ms; failures are logged, not surfaced.
  - Returns `{sessionId, pin}`.
- **`GET /api/sessions`:** `listSessionsByHost(hostId, 20)`.
- **`GET /api/sessions/:id/results.csv`:**
  - Owner only.
  - `engine.buildResultsCsv` with results for revealed questions and their responses.
  - `Content-Type: text/csv; charset=utf-8` and `Content-Disposition: attachment; filename="zqhoot-{pin}-{yyyy-mm-dd}.csv"`.
- **Media:**
  - `POST /api/media/uploads` → `media.createUpload`.
  - `PUT /api/media/*` exists only if `media.put` is defined; the token comes from query `t`.
  - `GET /api/me` returns the host identity.
- **Errors.** Unknown errors return 500 `internal` with a generic message, and are logged with a request ID.

## Tests (Vitest)

- **Fixtures.** `test/harness.ts` builds a `GameService` + HTTP app from:
  - a `MemoryStore` or a `DynamoStore` (DynamoDB Local at `ZQ_DDB_ENDPOINT`, default `http://localhost:8000`, unique table via `ensureTable`)
  - a `FakeTransport` that records messages per connection and can mark connections gone
  - a controllable clock, deterministic IDs, a fake `HostAuth`, an in-memory media fake, and `sleep` that advances the fake clock.
- **Full game scenario, run against BOTH stores.**
  - Host creates a quiz (one question of every type) over HTTP (`app.request`), creates a session, and says hello.
  - 12 players join, including a nickname collision and an invalid nickname.
  - Every question type is played through open, answers, close, reveal, leaderboard and ended. Two players reconnect mid-question and mid-reveal and get correct snapshots. One is kicked and can't resume. A word-cloud player uses all entries and hits the limit. An open-ended response is moderated.
  - Scores match hand-computed values. CSV export matches expected rows.
- **Secrecy.** Across the whole scenario, no message sent to a player connection before its question's reveal contains `correctOptionId` or a `correct` answer field (a recursive key scan).
- **Idempotency and races:**
  - double `host.next` with the same `from`
  - `host.close` twice
  - a timer close racing a manual close
  - a reveal retried after a simulated crash between the scoreboard write and the meta write (wrap the store to throw once) → no double scoring
  - two concurrent answer submissions for the same player → one accepted, one duplicate
- **Timing:**
  - an answer at `openAt - 300` → `too-early`
  - `deadline + grace + 1` → `too-late`
  - `revealSettleMs` is honoured (the fake sleep observes it)
- **Errors:** every `ErrorCode` path reachable from the service is triggered at least once. Also: oversize frame, bad JSON, wrong `v`, an unbound connection sending `answer`, a player sending `host.next`, a foreign host.
- **Gone handling:** transport marks connections gone → records deleted and hosts get a roster update.
- **HTTP:** each route's happy path, validation 400, 401, foreign-owner 404, 409 conflict, PIN rate limiting (failures only), login rate limit, body limit.
- **Boundary scan:** `src/` imports nothing from `node:*`, `@aws-sdk/*`, `ws` or `aws-jwt-verify`.

## Acceptance criteria

1. `pnpm --filter @zqhoot/service typecheck` and `test` pass, with the full scenario green on both `MemoryStore` and `DynamoStore` (DynamoDB Local).
2. Every behaviour rule above is implemented and covered. The service contains no game rules that belong in the engine; if an engine gap was found, it was fixed in `packages/engine` with tests and reported.
3. `packages/service/README.md` documents the ports, the adapter responsibilities (what a server must provide), and the call sequences for answer, close/reveal and join.
4. `pnpm exec prettier --check packages/service` passes. Comments explain non-obvious _why_ only.
