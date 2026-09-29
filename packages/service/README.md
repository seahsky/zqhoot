# @zqhoot/service

The only place that orchestrates a game. Both servers (`apps/server-node`, `apps/server-lambda`) are
thin adapters: they translate their runtime's events into calls on this package and supply the
platform-specific ports. All game rules live here or in `@zqhoot/engine`; the service adds none of
its own.

```
protocol <- engine <- store (interface) <- service <- server-node | server-lambda
```

- **`GameService`** ([`src/game-service.ts`](src/game-service.ts)) turns WebSocket events into engine
  calls, persists through `Store` and delivers through `Transport`.
- **`createHttpApp`** ([`src/http-app.ts`](src/http-app.ts)) is a [Hono](https://hono.dev) app that
  implements every route of [`packages/protocol/src/http.ts`](../protocol/src/http.ts).
- **Ports** ([`src/ports.ts`](src/ports.ts)) are the interfaces the adapters implement.
- **`stampAndSerialize`** ([`src/transport-util.ts`](src/transport-util.ts)) decides where `ts`
  goes on the wire, so both transports produce identical frames.

Design: [ADR-0001](../../docs/adr/0001-repo-layout-and-toolchain.md),
[0003](../../docs/adr/0003-state-model-and-dynamodb.md) to
[0009](../../docs/adr/0009-auth-and-identity.md) and
[0013](../../docs/adr/0013-security.md).

The source imports nothing from `node:*`, `@aws-sdk/*`, `ws` or `aws-jwt-verify`, and uses no
Node-only global. `test/boundary.test.ts` enforces this.

## Exports

| Export                                                                                     | Use                                                                                           |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `GameService`, `GameServiceConfig`, `GameServiceDeps`                                      | WebSocket side                                                                                |
| `createHttpApp`, `HttpAppDeps`                                                             | HTTP side; returns a `Hono<AppEnv>` app (`app.fetch`, `hono/aws-lambda`, `@hono/node-server`) |
| `Transport`, `Clock`, `Ids`, `HostAuth`, `HostIdentity`, `LocalLogin`, `MediaStorage`, ... | Port types                                                                                    |
| `MediaError`                                                                               | What `MediaStorage.put` throws for a refused upload                                           |
| `CLOSE_CODES`                                                                              | The WebSocket close codes the service passes to `Transport.close`                             |
| `stampAndSerialize(message, ts)`, `prepareStamped(message)`                                | Frame serialisation for adapters. `prepareStamped` serialises once and stamps per recipient   |
| `noopLogger`                                                                               | Default logger                                                                                |

## Ports

| Port           | Contract                                                                                                                                                                                                   | AWS                                     | VM                                     |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------- |
| `Transport`    | `send(batch)`: serialise, stamp `ts = clock.now()` **per recipient immediately before sending**, send; report unreachable connections in `gone`; never throw for a gone peer. `close(id, code?, reason?)`. | `PostToConnection` pool of 50           | `ws` sockets                           |
| `Clock`        | `now()` in epoch ms.                                                                                                                                                                                       | `Date.now`                              | `Date.now`                             |
| `Ids`          | `sessionId`, `playerId`, `quizId`, `mediaId` (match the protocol `Id` pattern, 6-32 of `A-Za-z0-9_-`), `token` (32 random bytes, base64url), `pin` (6 digits, first 1-9).                                  | nanoid + `crypto`                       | same                                   |
| `HostAuth`     | `verify(bearer)` returns `{hostId, displayName}` or `null`. Used by HTTP host routes and by `host.hello`.                                                                                                  | Cognito (`hostId = sub`)                | local JWT (`hostId = local:{user}`)    |
| `LocalLogin`   | `login(user, password)`. Pass it and `POST /api/auth/login` exists; omit it and that route is a 404.                                                                                                       | omitted                                 | scrypt + JWT                           |
| `MediaStorage` | `createUpload(host, req, now)` returns an `UploadGrant`. `put(key, token, contentType, body)` exists only where bytes pass through the server; it throws `MediaError` for a bad token, type, size or key.  | presigned POST, no `put`                | PUT grant + `put` to local disk        |
| `Warmer`       | `warm()`, called after a session is created (never awaited for more than 500 ms, failures are logged).                                                                                                     | invokes the ws Lambda                   | omitted                                |
| `Scheduler`    | `scheduleClose(sessionId, questionIndex, at)`, `cancel(sessionId)`. Called only when given.                                                                                                                | omitted (hosts send `host.close timer`) | `setTimeout` calling `service.onTimer` |
| `Logger`       | `debug/info/warn/error(object, message?)`.                                                                                                                                                                 | the adapter's logger                    | the adapter's logger                   |
| `Sleep`        | `(ms) => Promise<void>`, used for the reveal settle wait. Default `setTimeout`.                                                                                                                            | default                                 | default                                |

`GameServiceConfig`:

| Field                           | AWS                       | VM                          |
| ------------------------------- | ------------------------- | --------------------------- |
| `engine.minLeadMs`              | `TIMING.minLeadMs.lambda` | `TIMING.minLeadMs.node`     |
| `engine.answerGraceMs`          | `TIMING.answerGraceMs`    | same                        |
| `engine.sessionTtlMs`           | 30 days                   | `ZQ_SESSION_TTL_DAYS`       |
| `revealSettleMs`                | 1000                      | 0                           |
| `allowedOrigins`                | `[ZQ_SITE_ORIGIN]`        | `[origin of ZQ_PUBLIC_URL]` |
| `nicknameAttemptsPerConnection` | 10                        | 10                          |

## What an adapter must do

**WebSocket events**

| Runtime event            | Call                                                                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| connect / upgrade        | `onConnect(connectionId, {origin, sourceIp})`; refuse (403) when `accept` is false. A missing `Origin` is refused when origins are configured. |
| frame                    | `onMessage(connectionId, frameText, receivedAt, {sourceIp})`                                                                                   |
| close / `$disconnect`    | `onDisconnect(connectionId)`                                                                                                                   |
| timer fired (VM)         | `onTimer(sessionId, questionIndex)`                                                                                                            |
| warm-up invocation (AWS) | `warm()`                                                                                                                                       |

- **`receivedAt`** is API Gateway's `requestContext.requestTimeEpoch` on AWS and the receive time on
  Node. Never the Lambda's own clock: a cold start would delay it and cost the player points
  ([ADR-0005](../../docs/adr/0005-timing-fairness-scoring.md)). The service never reads a clock to
  judge an answer.
- The three handlers **never reject**. Unexpected failures are logged with the connection id and the
  message type, and the client gets `error {code:'internal'}` with a generic message. Stack traces
  stay in the log.
- The service refuses frames over `LIMITS.clientMessageMaxBytes` (4096 UTF-8 bytes) itself.
  Transport-level caps (`ws` `maxPayload`, API Gateway's 32 KB) are defence in depth, and the
  per-connection message rate limit on the VM is the adapter's job.
- Calls for one connection may overlap: the service is safe under concurrency (see the race rules
  below), so adapters need no per-connection queue for correctness. API Gateway serialises per
  connection anyway.
- **Transport**: use `stampAndSerialize` (or `prepareStamped` to serialise a shared payload once)
  instead of building frames yourself. Stamp `ts` immediately before each send, not once per batch.
  Report connections you could not deliver to in `gone`; the service deletes their records and
  updates the hosts' roster. Other send failures may be logged and swallowed, or thrown (the service
  logs them and tells the requester `internal`). Sends may run concurrently, but every promise must
  finish before the handler returns.
- **Close codes**: `CLOSE_CODES.normal` (1000, kicked), `.protocolError` (1002, wrong protocol
  version), `.policyViolation` (1008, rate limited or not authorised). An `error` message always
  precedes the close.
- **Timers (VM)**: when `scheduleClose(sessionId, i, at)` is called, call `onTimer(sessionId, i)` at
  `at` (a question's deadline plus the answer grace). Late or repeated timers are harmless: a timer
  for a question that is no longer open does nothing. `cancel(sessionId)` drops the pending timers
  of a session. After a restart, restore timers from the persisted `deadline` of sessions in phase
  `question`. On Lambda there is no scheduler and the host client sends `host.close {reason:'timer'}`.
- **HTTP**: mount the Hono app (`app.fetch`, or `hono/aws-lambda`'s `handle`). Provide `clientIp`
  (API Gateway `requestContext.http.sourceIp`, or the first `X-Forwarded-For` hop only behind a proxy
  you trust). Do not buffer request bodies for `PUT /api/media/*`: the app counts bytes while
  streaming and hands `media.put` a `ReadableStream`.
- **CORS**: pass `cors: { origins }` when the browser calls the API from another origin (the AWS
  target: the site is on CloudFront, the API on `execute-api`). Leave it out when the app and the API
  share one origin (the VM). Do not also configure CORS in front of the app: API Gateway with a
  `cors_configuration` would discard these headers.
- **Housekeeping**: the service does not sweep or flush anything. On the VM, call
  `MemoryStore.sweepExpired()` periodically and flush persistence on shutdown.

## Call sequences

Store calls, in order. `[x]` means conditional on the phase or the question type.

### `join`

1. `hitRateLimit('nick:'+connectionId, 10, 1 h)`. Over the limit: `error rate-limited`, close.
2. `getSessionIdByPin` -> `getSession` -> `countPlayers` -> engine `checkJoinable` -> engine
   `normalizeNickname`. Refusals: `not-found`, `session-ended`, `session-locked`, `session-full`,
   `nickname-invalid` (reason in `message`).
3. Mint `playerId` and `token`; store only `sha256Hex(token)` (WebCrypto).
4. `addPlayer` (`nickname-taken` gets that error) -> `putConnection` with
   `expiresAt = min(meta.expiresAt, now + 3 h)`.
5. `getSession` **again**, so the snapshot reflects the phase after the connection exists (a
   transition committed between the first read and `putConnection` would otherwise skip this player
   and nothing replays it).
6. `welcome {credentials, snapshot}` where the snapshot loads only what the phase shows: `getSnapshot`
   (cached), `[getScoreboard unless lobby]`, `[listPlayers in leaderboard/ended]`,
   `[getQuestionResult in reveal]`.
7. `listConnections` -> `roster {upsert:[{..., connected:true}]}` to hosts (skipped when the welcome
   was undeliverable).

`resume` is the same from step 5 on, after `getPlayer`, a constant-time compare of `sha256Hex(token)`
with `tokenHash`, the kicked check and `getSession`. It also loads `[listPlayerResponses]` for the
current question. An unknown player or an expired session is `not-found`, a wrong token
`unauthorized`, a kicked player gets `kicked` and a close.

### `answer`

1. `getConnection` (must be a player binding, else `unauthorized`).
2. `getSession` (consistent) -> `getSnapshot` (per-instance cache: 100 entries, LRU, one shared read
   for simultaneous misses).
3. `[listPlayerResponses]` only for word clouds and open questions **while the question is open**.
   Single-response types pass `existing = []` and let the conditional put find duplicates.
4. Engine `evaluateAnswer` with the adapter's `receivedAt`.
5. Accepted: `putResponse` (first write wins). `created: false` means a concurrent request of the
   same player got the slot: the answer is evaluated once more with that record included, giving
   `duplicate` (same answer), `rejected limit`, or the next slot.
6. `answer.ack {status, reason?, entries}` to the sender.

Nothing else is read or written: never META, never a counter, and hosts are not notified per answer
(they poll `host.stats`). The warm path is exactly `getConnection`, `getSession`, `putResponse`.

### `host.close` / `host.next` / timer -> reveal

1. `getConnection` (host binding) -> `getSession` + `getSnapshot` -> engine `applyHostCommand` (or
   `timerClose`). Not ok: the error goes to the requester. Effect `none`: `host.state` to the
   requester only.
2. Otherwise `updateSession(meta', previousVersion)`. `ConflictError` reloads and decides again, up to
   3 attempts, then `error conflict` (a timer just logs). A stale `from`, a repeated close or a timer
   racing a manual close therefore ends as a no-op.
3. Effect `closing`: `scheduler.cancel`, wait `revealSettleMs`, then the reveal. Effect
   `retry-reveal` (the host pressed next while `revealing`): the reveal without the wait.
4. **Reveal** (idempotent, [ADR-0006](../../docs/adr/0006-answers-aggregation-reveal.md)), up to 3 passes:
   1. `getSession`; it must still be `revealing` for that index, else stop.
   2. `getQuestionResult` + `getScoreboard`. A stored result with `appliedThrough >= i` means
      scoring happened: `listPlayers` -> `revealFromStored`.
   3. Otherwise `listResponses` + `listPlayers` -> `computeReveal`, then, **in this order**,
      `putQuestionResult` -> `putScoreboard(expectedVersion)` -> `updateSession(revealMeta)`.
   4. A `ConflictError` on the scoreboard or the meta means a concurrent run got there first: load
      again and reuse its stored result.
   5. For open-ended and word cloud questions, `listResponses` again after the `updateSession`. When
      a status differs from what the result was derived from (or the result came from an earlier
      run, so that is unknown), the result is re-derived and written as a moderation does, and the
      `reveal` and `host.state` messages are built from it. See "Moderation while the reveal is being written" below.
5. `listConnections` once; players get their own `reveal`, hosts get `host.state` with the result.

A crash between any two of the three writes leaves `revealing`; the next host command (or a repeat of
the reveal) finishes the job and `appliedThrough` guarantees nobody is scored twice.

The other effects: `question-opened` (`question` to every connection of every player, `host.state` to
hosts, `scheduleClose(sid, i, deadline + answerGraceMs)` when there is a deadline), `leaderboard`,
`ended` (`releasePin`, `scheduler.cancel`, `ended` to players, `host.state` to hosts) and
`lock-changed` (`host.state` to hosts).

## Behaviour worth knowing

- **Gone connections.** After every `Transport.send` the service deletes the connection record of each
  `gone` id, and sends hosts `roster {connected:false}` for players that have no other live
  connection. A player can hold several connections; every one receives player broadcasts.
- **Snapshot on connect.** `join`, `resume` and `host.hello` read the session after registering the
  connection, so a broadcast cannot be missed between the read and the registration.
- **PIN lookups.** `GET /api/join/:pin` counts only misses (`hitRateLimit('pin:'+ip, 30, 1 min)`), so a
  classroom behind one IP is never limited by successful lookups. The block itself lives in the store:
  every lookup first calls `peekRateLimit('pin:'+ip, 30, 1 min, now)`, which reads the same window
  counter without incrementing it, and an IP over the limit gets 429 for every lookup, hit or miss,
  before the PIN is read. The app keeps no per-instance block state, so any Lambda container refuses a
  blocked IP, and a live PIN cannot be told from a dead one by a 200 among 429s. A successful lookup
  never increments the counter. Malformed PINs get 400 before any store access and are not counted.
  A peek and a later miss are not atomic: requests in flight when the 31st miss lands may still be
  answered, but the next lookup from that IP is refused.
- **Moderation after the reveal.** `host.moderate` writes the response status, then, while the session
  shows that question's reveal, re-derives the stored result with the engine's `refreshModeration`
  (open-ended statuses, word cloud words) from the responses' current statuses and sends `host.state`
  to every host. Re-deriving instead of patching keeps concurrent moderation requests from losing
  each other's change, but the result is written unconditionally, so a slow request can still write
  last with an older read. Each request therefore lists the responses again after its write and, if
  a status moved, derives and writes again (at most 3 passes, then a warning). Whichever write lands
  last was checked after every earlier status change, so `RESULT#i` and the response records agree.
  `host.state` is sent only from that final result.
- **Moderation while the reveal is being written.** A `host.moderate` that reads `revealing` sets the
  status and stops, because the result may not exist yet. The reveal covers that window from its side:
  after its `updateSession` it lists the responses again, and any status set before that update is in
  the read, so it re-derives the result the same way. A moderation that reads `reveal` finds the
  result already stored and refreshes it itself.
- **Host authentication.** A host binding is created only by `host.hello`, after `HostAuth.verify`
  succeeded and the session's `hostId` matched. Later commands trust the binding (at most 3 h old).
- **Foreign resources are 404, never 403**, on every HTTP route.
- **Status codes.** Successful `POST`/`PUT` that return a body answer 200, `DELETE` and media `PUT` 204
  (the contract in `http.ts` lists only the exceptions to 200). Errors carry
  `ApiError {error, message}`; every response has `Cache-Control: no-store`,
  `X-Content-Type-Options: nosniff` and an `X-Request-Id`.
- **CSV file name.** `zqhoot-{pin}-{yyyy-mm-dd}.csv` uses the (UTC) day the session was created.
- **CORS** (only when `deps.cors` is set; [ADR-0013](../../docs/adr/0013-security.md)). Hono's
  `cors` middleware runs on `/api/*` ahead of the body limit and the bearer check, so a preflight
  needs no token and errors (401, 404, 413, 429) are readable too. An `Origin` that is exactly one
  of `origins` gets `Access-Control-Allow-Origin` (that origin, never `*`) and
  `Access-Control-Expose-Headers: content-disposition,retry-after,x-request-id`. A preflight from
  it is answered with 204, `Allow-Methods: GET,POST,PUT,DELETE,OPTIONS`,
  `Allow-Headers: authorization,content-type` and `Max-Age: 86400`. No credentials header is ever
  sent: hosts use a bearer token, not cookies. Any other origin, or none, gets no
  `Access-Control-*` header (a preflight from a stranger falls through to the 404) and only
  `Vary: Origin`. CORS is not authentication: every route still validates its input.

## Tests

```sh
pnpm --filter @zqhoot/service typecheck
pnpm --filter @zqhoot/service test
```

The suites run against `MemoryStore` and against `DynamoStore` on DynamoDB Local
(`ZQ_DDB_ENDPOINT`, default `http://localhost:8000`; start it as described in
[`packages/store/README.md`](../store/README.md)). `ZQ_SKIP_DYNAMO=1` skips the DynamoDB half; without
it an unreachable endpoint fails the run. Each DynamoDB suite creates its own table
(`zqhoot-test-service-*`) and drops it afterwards. Every harness uses its own ids, PINs, host ids and
IPs, and a fake clock in the year 2100 (so DynamoDB Local's TTL sweeper never touches test data).

| File                                                     | Covers                                                                                                                             |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `scenario.test.ts`                                       | A full game with every question type, 12 players, reconnects, a kick, moderation, hand-computed scores, the CSV and answer secrecy |
| `errors.test.ts`                                         | Every `ErrorCode`, oversize and bad frames, protocol version, bindings and roles                                                   |
| `timing.test.ts`                                         | The answer window, `revealSettleMs`, timers and the scheduler                                                                      |
| `races.test.ts`                                          | Double `host.next`, double close, timer vs manual close, a crash between reveal writes, concurrent answers                         |
| `players.test.ts`, `hosts.test.ts`, `edge-cases.test.ts` | join/resume/leave, host commands, kick, moderation, stats, gone connections, defensive paths                                       |
| `http.test.ts`                                           | Every route: happy path, 400, 401, 404 for foreign owners, 409, rate limits, body limits, media, CORS                              |
| `units.test.ts`, `boundary.test.ts`                      | Serialisation, hashing, the LRU, origin checks, the snapshot cache, and the import boundary                                        |

`test/harness.ts` builds a `GameService` and an HTTP app on a `FakeTransport` (records every message and
validates it against the protocol's `ServerMessage`, and can mark connections gone), a controllable
clock, deterministic ids, a fake `HostAuth`, an in-memory media fake and a `sleep` that advances the
clock. Its store is a proxy that counts calls and can replace methods, which the race and crash tests
use. The DynamoDB client and table helpers are borrowed from `packages/store/test`, because this
package may not depend on the AWS SDK.
