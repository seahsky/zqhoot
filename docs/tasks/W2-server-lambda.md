# W2-server-lambda: API Gateway + Lambda adapters (AWS target)

Owner: Sonnet implementation agent. Reviewer: independent Opus agent.

## Goal

`apps/server-lambda` provides two Lambda handlers:

- `ws`: API Gateway WebSocket `$connect`, `$disconnect` and `$default`, plus warm-up events.
- `http`: API Gateway HTTP API, payload v2.

Both are thin adapters around `@zqhoot/service`. The package also contains:

- AWS port implementations
- the esbuild bundling + zipping that produces `dist/ws.zip` and `dist/http.zip` (the paths Terraform expects)
- a **local API Gateway WebSocket emulator**, so the real Lambda code path, including the real `@connections` HTTP calls, can be exercised end to end and load tested without an AWS account

Read first:

- `docs/ARCHITECTURE.md`
- ADRs 0002, 0005, 0007, 0009, 0010, 0011, 0013
- `docs/tasks/W1-infra.md`, section "Lambda environment contract" (the env var names are fixed)
- `packages/service/README.md` and `packages/store/README.md`

## Files you own

- `apps/server-lambda/**` (new package `@zqhoot/server-lambda`).
- Dependencies (exact versions): workspace `@zqhoot/service`, `@zqhoot/store`, `@zqhoot/protocol`, `@zqhoot/engine`; `hono@4.13.10`; `@aws-sdk/client-apigatewaymanagementapi@3.1142.0`, `@aws-sdk/client-dynamodb@3.1142.0`, `@aws-sdk/lib-dynamodb@3.1142.0`, `@aws-sdk/client-s3@3.1142.0`, `@aws-sdk/s3-presigned-post@3.1142.0`, `@aws-sdk/client-lambda@3.1142.0`; `aws-jwt-verify@5.2.1`; `nanoid@6.0.1`.
- Dev: `@types/aws-lambda@8.10.164`, `esbuild@0.28.2`, `fflate@0.8.3` (zip writing, no native tools), `ws@8.22.0` + `@types/ws@8.18.1` (emulator and tests only; never bundled into the Lambdas).

## Handlers

- **`src/ws.ts` → `export const handler`**
  - Warm-up: event `{warmup:true}` → `service.warm()`, then wait 200 ms (ADR-0010), return.
  - `$connect`: `service.onConnect(connectionId, {origin: headers.origin ?? headers.Origin, sourceIp})` → `{statusCode: 200}` or `{statusCode: 403}`.
  - `$disconnect`: `service.onDisconnect`.
  - `$default`: `service.onMessage(connectionId, body, requestContext.requestTimeEpoch, {sourceIp})`. **`receivedAt` must be `requestTimeEpoch`, never `Date.now()`** (ADR-0005).
  - Always `{statusCode: 200}` for messages. The service replies through the transport.
  - Module-scope construction of the store, transport, verifier and service. Config:
    - `engine.minLeadMs = TIMING.minLeadMs.lambda`
    - `revealSettleMs = 1000`
    - `allowedOrigins = [ZQ_SITE_ORIGIN]`
- **`src/http.ts` → `export const handler = handle(app)`** (`hono/aws-lambda`). Client IP from `requestContext.http.sourceIp`.

## Ports

- **`ApiGatewayTransport`**
  - One `ApiGatewayManagementApiClient` per container, `endpoint = ZQ_WS_CALLBACK_URL`.
  - Bounded pool of 50 concurrent `PostToConnectionCommand` calls. Every promise is awaited before returning.
  - `GoneException` / HTTP 410 → gone. Other errors after the SDK's retries → logged, not thrown.
  - `close` → `DeleteConnectionCommand`, ignoring 410.
  - Uses `stampAndSerialize` from the service package, stamping `ts` immediately before each call.
- **`CognitoHostAuth`**: `CognitoJwtVerifier.create({ userPoolId, tokenUse: 'id', clientId })`; `hostId = sub`, `displayName = email ?? sub`. Invalid → null.
- **`S3Media`**
  - `createPresignedPost` with key `media/{hostSlug}/{nanoid}.{ext}`, where `hostSlug` is the first 16 base64url characters of SHA-256(hostId).
  - Conditions: `["content-length-range", 1, 5242880]`, `{"Content-Type": type}`, `{"key": key}`; `Fields: {"Content-Type": type}`; expiry 300 s.
  - No `put` method.
- **`LambdaWarmer`**: `InvokeCommand {FunctionName: ZQ_WS_FUNCTION_NAME, InvocationType: 'Event', Payload: {"warmup":true}}` × `ZQ_WARM_CONCURRENCY`, issued concurrently.
- **`Ids`**: `nanoid` plus `crypto`, as on Node.
- **Store:** `DynamoStore({tableName: ZQ_TABLE_NAME})`.
- **Config:** env parsed with zod per the W1-infra contract. `ZQ_DDB_ENDPOINT` and `ZQ_WS_CALLBACK_URL` can point at local endpoints for the emulator and tests.

## Build (`scripts/build.mjs`, run by `pnpm --filter @zqhoot/server-lambda build`)

- esbuild each handler: `bundle`, `platform: 'node'`, `target: 'node24'`, `format: 'esm'`, `.mjs` output, minify, `sourcemap: 'linked'`. Use a `createRequire` banner if a CJS dependency needs `require`.
  - The AWS SDK is **bundled** (ADR-0010). `ws`, `@types/*` and test code must not be in the bundle.
- Output `dist/ws/index.mjs` (+ map) and `dist/http/index.mjs` (+ map). Zip each directory with `fflate` into `dist/ws.zip` / `dist/http.zip`, with the handler file at the zip root, so the Terraform handler is `index.handler`.
- Print the bundle sizes. Fail the build if either zipped bundle exceeds 5 MB. The size keeps cold starts down, and staying well under the Lambda zip limit is a sanity check.

## Local emulator (`src/emulator/`, run with `pnpm --filter @zqhoot/server-lambda emulate`)

A Node process (using `ws`) that behaves like API Gateway for local testing:

- **WebSocket endpoint** on `ZQ_EMU_WS_PORT` (default 3001). Per client: generate a `connectionId`, invoke the **built** `dist/ws/index.mjs` handler in-process, with events shaped like API Gateway WebSocket proxy events (`requestContext.routeKey`, `eventType`, `connectionId`, `requestTimeEpoch` = receive time, `domainName`, `stage`, `identity.sourceIp`; headers on connect).
  - Serialise invocations **per connection**, allowing concurrency across connections, as API Gateway does.
  - Returning 403 from `$connect` rejects the upgrade.
- **`@connections` HTTP endpoint** on `ZQ_EMU_MGMT_PORT` (default 3002), implementing `POST /{stage}/@connections/{id}` (send), `DELETE` (close) and `GET`. Unknown ID → 410 with a `GoneException` body the SDK recognises. Set `ZQ_WS_CALLBACK_URL=http://localhost:3002/{stage}` so the **real** `ApiGatewayTransport` and SDK client are used. Accept unsigned requests: the SDK signs with dummy credentials.
- **HTTP API:** mount the built http handler behind a Node HTTP server on `ZQ_EMU_HTTP_PORT` (default 3000), translating requests to API Gateway v2 events. Also serve `apps/web/dist` and a `config.json` (`auth.mode 'local'`, pointing at the emulator ports). Host auth in emulator mode uses the same local login as server-node, with a dev JWT secret, via a `ZQ_AUTH_MODE=local` switch in the http/ws handlers. That switch must be **impossible to enable accidentally in AWS**: it also requires `ZQ_EMULATOR=1` and a non-AWS environment (no `AWS_LAMBDA_FUNCTION_NAME`).
- Uses DynamoDB Local (`ZQ_DDB_ENDPOINT`, default `http://localhost:8000`), and creates the table with `ensureTable` on start.

## Tests (Vitest)

- **Transport**, with an `ApiGatewayManagementApiClient` whose `send` is stubbed:
  - concurrency never exceeds 50 (measure in-flight calls)
  - 410 → gone
  - a thrown non-410 error → logged, others still delivered
  - `ts` stamped per call and increasing with the clock
- **Handlers**, against DynamoDB Local + a stub transport:
  - `$connect` origin rejection
  - `$default` passes `requestTimeEpoch` as `receivedAt` (an event with a `requestTimeEpoch` 10 s in the past yields `too-late` for a question that closed 5 s ago)
  - warm-up event path
  - http handler routes a v2 event to `/api/health`
- **Emulator end-to-end:** build, then start the emulator + DynamoDB Local. Real `ws` clients (1 host + 5 players) play a 3-question game through join, answers, reveal, leaderboard and ended, including one reconnect with `resume` and one kicked player. This proves the Lambda code path, the transport and the store together.
- **Bundle checks:** `dist/*.zip` exist and have `index.mjs` at the root. The bundle doesn't contain the string `from "ws"` or test fixtures. Importing `dist/ws/index.mjs` exposes `handler`.

## Acceptance criteria

1. `pnpm --filter @zqhoot/server-lambda typecheck`, `test` and `build` pass (DynamoDB Local running). The zips exist at `apps/server-lambda/dist/ws.zip` and `dist/http.zip`.
2. `requestTimeEpoch` is the only source of `receivedAt` on the Lambda path (test-enforced).
3. The emulator runs a full game end to end with the real transport code, and is documented for use by the load test and E2E (`apps/server-lambda/README.md`).
4. Env var names match the W1-infra contract exactly. The README lists them.
5. `pnpm exec prettier --check apps/server-lambda` passes. Comments explain non-obvious _why_ only.
