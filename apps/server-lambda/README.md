# @zqhoot/server-lambda

The AWS target: two Lambda handlers that are thin adapters around [`@zqhoot/service`](../../packages/service/README.md),
the AWS implementations of its ports, the build that produces the zips Terraform deploys, and a
**local API Gateway emulator** that runs the built handlers so the real Lambda code path can be
exercised, end to end and under load, without an AWS account.

```
API Gateway WebSocket ($connect / $disconnect / $default) ──► ws handler  ─┐
API Gateway HTTP API (payload v2), called directly (CORS) ──► http handler ─┼─► GameService / Hono app
                                                                            │   (packages/service)
             DynamoStore ◄──────────────────────────────────────────────────┘
   PostToConnection (ApiGatewayTransport) ──► back to the clients
```

All game behaviour lives in `@zqhoot/service` and `@zqhoot/engine`. This package only translates
API Gateway events into service calls and supplies the ports. Design: ADRs
[0002](../../docs/adr/0002-realtime-transport.md), [0005](../../docs/adr/0005-timing-fairness-scoring.md),
[0007](../../docs/adr/0007-broadcast.md), [0009](../../docs/adr/0009-auth-and-identity.md),
[0010](../../docs/adr/0010-cold-starts.md), [0011](../../docs/adr/0011-media.md) and
[0013](../../docs/adr/0013-security.md).

## Commands

Run from the repository root.

| Command                                         | What it does                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------ |
| `pnpm --filter @zqhoot/server-lambda typecheck` | `tsc`, no emit, over `src` and `test`                                          |
| `pnpm --filter @zqhoot/server-lambda test`      | Vitest. Builds first (global setup) and needs DynamoDB Local ([Tests](#tests)) |
| `pnpm --filter @zqhoot/server-lambda build`     | Bundles and zips both handlers into `dist/` ([Build](#build))                  |
| `pnpm --filter @zqhoot/server-lambda emulate`   | Builds, then starts the local emulator ([Local emulator](#local-emulator))     |

## Handlers

### `src/ws.ts` (`export const handler`)

| Event                      | Behaviour                                                                                                                                                                               |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{"warmup": true}`         | `service.warm()`, then waits 200 ms so concurrent warm-ups land on separate execution environments ([ADR-0010](../../docs/adr/0010-cold-starts.md)).                                    |
| `$connect`                 | `service.onConnect(connectionId, {origin: headers.origin ?? headers.Origin, sourceIp})`. Returns `200`, or `403` when the Origin is not `ZQ_SITE_ORIGIN` (a missing Origin is refused). |
| `$disconnect`              | `service.onDisconnect(connectionId)`. Returns `200`.                                                                                                                                    |
| `$default` (every message) | `service.onMessage(connectionId, body, requestContext.requestTimeEpoch, {sourceIp})`. Always returns `200`; the service replies through the transport.                                  |

**`receivedAt` is `requestContext.requestTimeEpoch`, never a clock read in the Lambda.** A cold start
delays the invocation but not the score ([ADR-0005](../../docs/adr/0005-timing-fairness-scoring.md)).
`test/ws-handler.test.ts` enforces it two ways: behaviour (an answer stamped in time is accepted
when the invocation runs after the deadline; an answer stamped late is refused while the clock says
the question is open; points follow the stamped time) and a scan that `ws-handler.ts` reads no clock.

Everything expensive is built at module scope (`src/ws.ts`): the DynamoDB client and store, the
`ApiGatewayManagementApiClient`, the Cognito verifier (which caches the pool's JWKS) and the
`GameService`. The service is configured with `engine.minLeadMs = TIMING.minLeadMs.lambda` (1500),
`revealSettleMs = 1000` and `allowedOrigins = [ZQ_SITE_ORIGIN]`. `src/ws-handler.ts` holds the
event dispatch, so tests can drive it with a stub transport.

### `src/http.ts` (`export const handler = handle(app)`)

`hono/aws-lambda`'s `handle` around `createHttpApp` from `@zqhoot/service`. The client IP is
`requestContext.http.sourceIp`. Routes are exactly those of `packages/protocol/src/http.ts`; the
local login route exists only in emulator mode.

## Ports

| Port              | Implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Transport`       | `ApiGatewayTransport` (`src/ports/api-gateway-transport.ts`). One `ApiGatewayManagementApiClient` per container with `endpoint = ZQ_WS_CALLBACK_URL`. A pool of 50 `PostToConnection` calls; every promise is awaited before `send` returns. `ts` is stamped per call, immediately before it, with `stampAndSerialize`. `GoneException` or HTTP 410 marks the connection gone. Any other failure (after the SDK's retries) is logged and not thrown. `close` is `DeleteConnection`, ignoring 410. |
| `HostAuth`        | `CognitoHostAuth`: `CognitoJwtVerifier` with `tokenUse: 'id'` and the app client id. `hostId = sub`, `displayName = email ?? sub`; anything invalid is `null`. A failed JWKS download is logged as a warning, since it locks every host out.                                                                                                                                                                                                                                                      |
| `MediaStorage`    | `S3Media`: presigned POST for `media/{hostSlug}/{nanoid}.{ext}`, where `hostSlug` is the first 16 base64url characters of SHA-256(hostId). Conditions `content-length-range 1..5242880`, exact `Content-Type` and exact `key`; expiry 300 s. No `put`: bytes go browser to S3.                                                                                                                                                                                                                    |
| `Warmer`          | `LambdaWarmer`: `ZQ_WARM_CONCURRENCY` concurrent `InvokeCommand`s (`InvocationType: 'Event'`, payload `{"warmup":true}`) of `ZQ_WS_FUNCTION_NAME`. All calls are awaited even if one fails.                                                                                                                                                                                                                                                                                                       |
| `Ids`             | `nanoid` for ids, `randomBytes(32)` base64url tokens, `randomInt` PINs (six digits, first 1-9).                                                                                                                                                                                                                                                                                                                                                                                                   |
| `Store`           | `DynamoStore({tableName: ZQ_TABLE_NAME})` (plus `endpoint` when `ZQ_DDB_ENDPOINT` is set).                                                                                                                                                                                                                                                                                                                                                                                                        |
| `Clock`, `Logger` | `Date.now`; one JSON object per line on the console at `ZQ_LOG_LEVEL`.                                                                                                                                                                                                                                                                                                                                                                                                                            |

The management API and Lambda clients get a 2 s connect and 5 s request timeout. The SDK sets none,
and a hung socket would hold one of the 50 pool slots, and so the invocation, until the Lambda
timeout.

## Environment variables

Parsed with zod at cold start (`src/config.ts`). A bad or missing value fails initialisation with a
message that lists every problem. Empty strings count as unset. Names match the Lambda environment
contract in [`docs/tasks/W1-infra.md`](../../docs/tasks/W1-infra.md), which
`test/config.test.ts` checks against the doc itself.

| Variable                  | ws  | http | Meaning                                                                                                         |
| ------------------------- | --- | ---- | --------------------------------------------------------------------------------------------------------------- |
| `ZQ_TARGET`               | yes | yes  | Must be `aws`.                                                                                                  |
| `ZQ_TABLE_NAME`           | yes | yes  | DynamoDB table.                                                                                                 |
| `ZQ_SITE_ORIGIN`          | yes | yes  | Site origin, no path or trailing slash, e.g. `https://d111.cloudfront.net`. The only Origin `$connect` accepts. |
| `ZQ_COGNITO_USER_POOL_ID` | yes | yes  | Required unless local auth is on.                                                                               |
| `ZQ_COGNITO_CLIENT_ID`    | yes | yes  | Required unless local auth is on.                                                                               |
| `ZQ_SESSION_TTL_DAYS`     | yes | yes  | Session lifetime in days. Default 30.                                                                           |
| `ZQ_WS_CALLBACK_URL`      | yes |      | `https://{api}.execute-api.{region}.amazonaws.com/{stage}`.                                                     |
| `ZQ_MEDIA_BUCKET`         |     | yes  | Media bucket name.                                                                                              |
| `ZQ_WS_FUNCTION_NAME`     |     | yes  | The ws function, for warm-up.                                                                                   |
| `ZQ_WARM_CONCURRENCY`     |     | yes  | Warm-up invocations per session. Default 4; 0 turns warm-up off.                                                |
| `ZQ_LOG_LEVEL`            | yes | yes  | `debug`, `info`, `warn` or `error`. Default `info`.                                                             |
| `NODE_OPTIONS`            | yes | yes  | `--enable-source-maps` (set by Terraform; the zips carry the maps). Read by Node, not by this package.          |

Optional, never set by Terraform, for local use:

| Variable                                                                        | Meaning                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ZQ_DDB_ENDPOINT`                                                               | DynamoDB endpoint, e.g. DynamoDB Local.                                                                                                                                                                                                    |
| `ZQ_LAMBDA_ENDPOINT` (http)                                                     | Lambda endpoint for the warm-up `Invoke`; the emulator points it at itself.                                                                                                                                                                |
| `ZQ_AUTH_MODE=local`                                                            | Replaces Cognito with a single-admin login. See below.                                                                                                                                                                                     |
| `ZQ_ADMIN_USER`, `ZQ_ADMIN_PASSWORD_HASH`, `ZQ_ADMIN_PASSWORD`, `ZQ_JWT_SECRET` | Local auth only. Defaults: user `admin`, password `admin`, a fixed development secret (`ZQ_JWT_SECRET` must be at least 32 characters). The hash is `scrypt$N$r$p$saltB64$hashB64` ([ADR-0009](../../docs/adr/0009-auth-and-identity.md)). |

**Local auth cannot be switched on by accident in AWS.** `ZQ_AUTH_MODE=local` needs `ZQ_EMULATOR=1`
**and** none of `AWS_LAMBDA_FUNCTION_NAME`, `AWS_EXECUTION_ENV`, `AWS_LAMBDA_RUNTIME_API` or
`LAMBDA_TASK_ROOT` in the environment. Otherwise the function refuses to initialise, so a stray
variable shows up as a failed cold start and never as a login that skips Cognito. The emulator's
tokens are standard HS256 JWTs with the VM login's claims (`iss zqhoot`, `sub local:{user}`, 12 h).
The local-auth code (Node `crypto` only, a few KB) ships in both bundles and stays unreachable unless
that guard passes.

## Build

`pnpm --filter @zqhoot/server-lambda build` runs `scripts/build.mjs`:

- esbuild per handler: `bundle`, `platform: 'node'`, `target: 'node24'`, `format: 'esm'`, `.mjs`
  output, minified, linked source map. A `createRequire` banner covers CommonJS dependencies. The
  AWS SDK is **bundled** ([ADR-0010](../../docs/adr/0010-cold-starts.md)). `ws`, `@types/*` and test
  code are not in the bundles.
- Outputs `dist/ws/index.mjs` and `dist/http/index.mjs` (with `.map` files), zipped with `fflate` into
  **`dist/ws.zip`** and **`dist/http.zip`**, the paths Terraform expects. The handler file is at the
  zip root, so the Terraform handler is `index.handler`. Zips use a fixed timestamp and Unix mode
  0644, so an unchanged build is byte-identical and Terraform sees no change.
- Prints the sizes and fails if either zip exceeds 5 MB. Current sizes: ws about 1.1 MB, http about
  1.4 MB.
- Also builds `dist/emulator/main.mjs` (with `ws` left as a runtime dependency) and writes esbuild
  metafiles to `dist/meta/`, which `test/bundle.test.ts` reads.

## Local emulator

`pnpm --filter @zqhoot/server-lambda emulate` builds, then starts a Node process (`dist/emulator/main.mjs`)
that behaves like API Gateway around the **built** handlers:

```
browser / k6 / ws client                      the emulator process
   │  ws://localhost:3001  ─────────────►  WebSocket gateway ──► dist/ws/index.mjs   ($connect/$default/$disconnect events)
   │  http://localhost:3000/api/*  ─────►  HTTP API gateway  ──► dist/http/index.mjs (payload v2 events)
   │  http://localhost:3000/  ──────────►  apps/web/dist + /config.json
   ▲                                       management API (:3002) ◄── the real ApiGatewayTransport (PostToConnection / DeleteConnection)
   └── frames ◄────────────────────────────                     ◄── the real LambdaWarmer (Invoke)
                                           DynamoDB Local (:8000) ◄── the real DynamoStore
```

So the transport, the SDK clients, the store, the zod parsing and the bundle itself are the real
thing. Only the AWS services around them are stand-ins.

### Requirements

- DynamoDB Local on `ZQ_DDB_ENDPOINT` (default `http://localhost:8000`); start it as described in
  [`packages/store/README.md`](../store/README.md). The emulator creates its table with `ensureTable`
  and leaves it in place on exit.
- `apps/web/dist` for the web app (`pnpm --filter @zqhoot/web build`). Whatever is there is served;
  without it `/` answers 503 with a hint, and the API and WebSocket still work.

### Configuration

| Variable                                                                        | Default                                    | Meaning                                                                                                                              |
| ------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `ZQ_EMU_HTTP_PORT`                                                              | 3000                                       | Web app, `/config.json`, `/api/*`.                                                                                                   |
| `ZQ_EMU_WS_PORT`                                                                | 3001                                       | WebSocket endpoint. Any path is accepted.                                                                                            |
| `ZQ_EMU_MGMT_PORT`                                                              | 3002                                       | `@connections` management API, the Lambda `Invoke` route and the `/__emulator/*` endpoints.                                          |
| `ZQ_EMU_HOST`                                                                   | `127.0.0.1`                                | Bind address. Loopback because the default login is `admin` / `admin`; the emulator warns if you bind elsewhere with it.             |
| `ZQ_EMU_PUBLIC_HOST`                                                            | `localhost`                                | Host name used in `config.json` and in the default site origin.                                                                      |
| `ZQ_EMU_STAGE`                                                                  | `emu`                                      | API stage: the management API answers under `/{stage}/@connections/{id}`.                                                            |
| `ZQ_SITE_ORIGIN`                                                                | `http://{public host}:{http port}`         | The Origin `$connect` accepts. A browser opened on `http://127.0.0.1:3000` sends a different Origin and is refused: use `localhost`. |
| `ZQ_TABLE_NAME`                                                                 | `zqhoot-emulator`                          | Table. Use a unique name for tests and load runs.                                                                                    |
| `ZQ_DDB_ENDPOINT`                                                               | `http://localhost:8000`                    | DynamoDB Local.                                                                                                                      |
| `ZQ_WARM_CONCURRENCY`                                                           | 2                                          | Warm-up invocations per session; 0 turns them off.                                                                                   |
| `ZQ_EMU_WEB_DIST`                                                               | `apps/web/dist`                            | Static files.                                                                                                                        |
| `ZQ_EMU_HANDLERS_DIR`                                                           | `apps/server-lambda/dist`                  | Directory holding `ws/index.mjs` and `http/index.mjs`.                                                                               |
| `ZQ_ADMIN_USER`, `ZQ_ADMIN_PASSWORD`, `ZQ_ADMIN_PASSWORD_HASH`, `ZQ_JWT_SECRET` | `admin`, `admin`, none, a fixed dev secret | Host login for `POST /api/auth/login` (`auth.mode` is `local` in `/config.json`).                                                    |
| `ZQ_LOG_LEVEL`                                                                  | `info`                                     | Log level of the emulator and both handlers.                                                                                         |

A port of `0` picks a free one. The emulator overrides `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`
with dummy values and drops `AWS_SESSION_TOKEN`, so credentials in your shell never reach a local
endpoint. The management API does not check signatures.

### Starting it and waiting for it

When it is ready, the emulator prints one line on stdout and then serves:

```
ZQ_EMULATOR_READY {"http":"http://localhost:3000","ws":"ws://localhost:3001","mgmt":"http://127.0.0.1:3002","callback":"http://127.0.0.1:3002/emu","origin":"http://localhost:3000","table":"zqhoot-emulator","webDist":"..."}
```

Scripts can parse that line (the only way to learn the ports when they are `0`), or poll
`GET {http}/api/health` until it answers 200. `SIGINT` and `SIGTERM` close every socket with 1001
(each gets its `$disconnect` invocation) and exit 0.

```sh
# DynamoDB Local is already running on :8000
ZQ_TABLE_NAME="zqhoot-load-$(date +%s)" pnpm --filter @zqhoot/server-lambda emulate &
until curl -sf http://localhost:3000/api/health >/dev/null; do sleep 0.5; done
```

### For the load test and the E2E suite

- **Base URL** `http://localhost:3000`; **WebSocket URL** `ws://localhost:3001`. Both also come
  from `GET /config.json` (`wsUrl`, `joinUrl`).
- **Host login:** `POST /api/auth/login {username, password}` returns `{token, expiresAt}`; send the
  token as `Authorization: Bearer` and as `host.hello.authToken`. Default credentials are
  `admin` / `admin`; set `ZQ_ADMIN_USER` and `ZQ_ADMIN_PASSWORD` to change them.
- **Every WebSocket client must send `Origin: {origin}`** (the `origin` field of the ready line,
  `http://localhost:3000` by default). Real API Gateway `$connect` enforces the same check, so a
  script that works here without an Origin header would not work on AWS. k6 needs it set in the
  connection parameters.
- **A game step-by-step** is `test/emulator.e2e.test.ts`, with `test/support/emulator.ts` for
  spawning the built emulator on free ports and a protocol-validating WebSocket client.
- **Stats:** `GET {mgmt}/__emulator/stats` returns `connections`, the invocation counts per route
  (`connect`, `message`, `disconnect`, `warmup`), `inFlight`, `maxInFlight` and
  `maxInFlightPerConnection` (always 1). `GET {mgmt}/__emulator/connections` lists live connections.
- **Cleaning up:** the table stays. DynamoDB Local keeps one database per access key and region
  (unless it was started with `-sharedDb`), and the emulator always uses the access key
  `emulator` in `us-east-1`, so other tools only see its table with the same key:
  `AWS_ACCESS_KEY_ID=emulator AWS_SECRET_ACCESS_KEY=emulator AWS_REGION=us-east-1 aws dynamodb delete-table --endpoint-url http://localhost:8000 --table-name …`.
  Restarting DynamoDB Local (in-memory) also clears it.
- Raise `ulimit -n` for a 400-player run: each client is one socket, plus the SDK's keep-alive
  sockets to the management API.

### What it emulates

- **WebSocket API.** Per client a connection id shaped like a real one (15 URL-safe base64
  characters and a trailing `=`), then an invocation of the built ws handler for `$connect` (before
  the upgrade completes: a `403` refuses it), one for each frame (`$default`, with
  `requestTimeEpoch` taken when the frame arrives) and one for the close (`$disconnect`).
  Invocations are serialised per connection and run in parallel across connections, as API Gateway
  does. Headers keep the client's case. Frames over 32 KB close the socket with 1009.
- **Management API.** `POST` (send a text frame; up to 128 KB), `DELETE` (close) and `GET`
  on `/{stage}/@connections/{id}`. An unknown or closing connection answers `410` with
  `x-amzn-ErrorType: GoneException`, which the SDK turns into a `GoneException`.
- **HTTP API.** Node requests become payload v2 events for the built http handler (`sourceIp`, cookies,
  base64 bodies for non-text types) and the result is written back. `/api/*` goes to the handler,
  as the browser reaches the HTTP API directly on AWS ([ADR-0002](../../docs/adr/0002-realtime-transport.md)).
  A failing handler is a `502`.
- **Lambda `Invoke`.** `POST /2015-03-31/functions/zqhoot-emulator-ws/invocations` runs the ws
  handler (`202` for `Event`), which is how the warm-up is exercised.

### What it does not emulate

The emulator is for correctness and relative load, not for AWS numbers.

- **One execution environment.** All invocations share one module instance and one event loop:
  no cold starts, no per-container caches, no Lambda memory or timeout limits, and concurrency is
  the event loop's. The gateway, the handlers and the client share one process and one CPU.
- No throttling: no 429 from the management API, no 10,000 rps account limit, no 500/s connection burst.
- No 10-minute idle timeout and no 2-hour connection limit.
- No SigV4 or IAM checks. No API Gateway route or stage settings.
- No CloudFront: no security headers, no CSP. The API is same-origin (`apiBaseUrl` is empty), so the CORS allow-list and preflight that AWS uses are not exercised.
- No S3: the presigned POST from `/api/media/uploads` is well formed but points at a bucket that
  does not exist.
- No clock skew: API Gateway's `requestTimeEpoch` and the handler read the same machine clock.
- `DeleteConnection` closes with code 1000.
- DynamoDB Local is a single Java process and much slower than DynamoDB under a burst; a 400-answer
  burst shows acknowledgement times in the seconds here.

## Tests

```sh
pnpm --filter @zqhoot/server-lambda typecheck
pnpm --filter @zqhoot/server-lambda test
```

The tests need DynamoDB Local on `ZQ_DDB_ENDPOINT` (default `http://localhost:8000`, see
[`packages/store/README.md`](../store/README.md)); an unreachable endpoint fails the run. Each file
creates its own table (`zqhoot-test-lambda-*`) and drops it. Test clocks that drive the service
start in the year 2100 so DynamoDB Local's TTL sweeper never deletes their items. A global setup
runs the build once before any file, so `dist/` always matches the source.

| File                   | Covers                                                                                                                                                                                                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transport.test.ts`    | The pool never exceeds 50 calls and awaits all of them; 410 means gone; another error is logged and the rest still arrive; `ts` is stamped per call and rises with the clock; `close`.                                                                                                         |
| `ws-handler.test.ts`   | Against DynamoDB Local with a stub transport: `$connect` Origin checks; `receivedAt` is `requestTimeEpoch` (in time, too late, too early, and the resulting points); the warm-up event; `$disconnect`.                                                                                         |
| `http-handler.test.ts` | A v2 event to `/api/health`, auth and 404 behaviour, rate limiting keyed on `sourceIp`, the local login, and the refusals of local auth inside Lambda.                                                                                                                                         |
| `ports.test.ts`        | Cognito (real signed tokens against a cached JWKS), S3 presigned POST policy, warm-up calls, ids, local login.                                                                                                                                                                                 |
| `config.test.ts`       | The environment contract against `docs/tasks/W1-infra.md`, defaults, error messages and the local-auth guard.                                                                                                                                                                                  |
| `build.test.ts`        | The 5 MB gate fails the build, the sizes are printed, zips are reproducible.                                                                                                                                                                                                                   |
| `bundle.test.ts`       | Zips exist with `index.mjs` at the root and a source map; no `ws`, emulator or test code in either bundle; the AWS SDK is bundled; importing each `index.mjs` exposes `handler`.                                                                                                               |
| `emulator.e2e.test.ts` | The built emulator as a child process: a host and five players play three questions through join, answers, reveal, leaderboard and ended, with a reconnect (`resume`) and a kick; plus the management API with the real SDK, static serving, per-connection serialisation, 1009, and shutdown. |

## Known limits

- **Client IP.** The http handler reads `requestContext.http.sourceIp` and never a forwarded
  header. The browser calls the HTTP API directly, not through CloudFront, so on AWS that is the
  client's own address ([ADR-0002](../../docs/adr/0002-realtime-transport.md),
  [ADR-0013](../../docs/adr/0013-security.md)). A header such as `X-Forwarded-For` is client-supplied
  there and could be forged, so it is not used.
- The `PostToConnection` pool does not keep the order of two messages for the same connection
  inside one batch. The service never sends such a batch, and the protocol does not depend on
  ordering across message types ([ADR-0002](../../docs/adr/0002-realtime-transport.md)).
