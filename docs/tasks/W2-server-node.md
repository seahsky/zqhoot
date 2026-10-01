# W2-server-node: single-process Node server (VM target)

Owner: Sonnet implementation agent. Reviewer: independent Opus agent.

## Goal

`apps/server-node`: one long-running Node process that serves the web app, `/config.json`, the HTTP API, the WebSocket endpoint and media. It is a thin adapter: all game behaviour comes from `@zqhoot/service`, and this package only provides ports and the runtime.

Read first:

- `docs/ARCHITECTURE.md`
- ADRs 0002, 0007, 0008, 0009, 0011, 0013, 0015
- `packages/service/README.md` (adapter responsibilities)
- `packages/store/README.md`
- `apps/web/README.md`

## Files you own

- `apps/server-node/**` (new package `@zqhoot/server-node`).
- Dependencies (exact versions): `@zqhoot/service`, `@zqhoot/store`, `@zqhoot/protocol`, `@zqhoot/engine` (workspace), `ws@8.22.0`, `@hono/node-server@2.1.1`, `hono@4.13.10`, `jose@6.2.12`, `nanoid@6.0.1`.
- Dev: `@types/ws@8.18.1`, `esbuild@0.28.2`, `tsx@4.23.15`.
- Nothing else.

## Configuration (environment, validated with zod at startup; any invalid value exits with a clear message)

| Variable                                         | Default                                                       | Meaning                                                                                                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ZQ_PORT`                                        | 8080                                                          | listen port                                                                                                                                                    |
| `ZQ_HOST`                                        | 0.0.0.0                                                       | listen address                                                                                                                                                 |
| `ZQ_PUBLIC_URL`                                  | **required**                                                  | e.g. `https://quiz.example.com`. Derives `config.json` (`wsUrl` = ws(s)://host/ws, `joinUrl` = …/join, `mediaBaseUrl` = …/) and the allowed WebSocket `Origin` |
| `ZQ_DATA_DIR`                                    | `./data`                                                      | state.json + media/                                                                                                                                            |
| `ZQ_STORE`                                       | `memory`                                                      | `memory` (with file persistence) or `dynamodb`                                                                                                                 |
| `ZQ_TABLE_NAME`, `ZQ_DDB_ENDPOINT`, `AWS_REGION` |                                                               | for `dynamodb`                                                                                                                                                 |
| `ZQ_ADMIN_USER`                                  | `admin`                                                       |                                                                                                                                                                |
| `ZQ_ADMIN_PASSWORD_HASH`                         |                                                               | `scrypt$N$r$p$saltB64$hashB64`                                                                                                                                 |
| `ZQ_ADMIN_PASSWORD`                              |                                                               | dev only, warns; one of hash or password is required                                                                                                           |
| `ZQ_JWT_SECRET`                                  | **required**                                                  | ≥ 32 bytes                                                                                                                                                     |
| `ZQ_WEB_DIST`                                    | `../web/dist` relative to the bundle, or `/app/web` in Docker | static files                                                                                                                                                   |
| `ZQ_TRUST_PROXY`                                 | `false`                                                       | when true, client IP = first `X-Forwarded-For` hop (Caddy)                                                                                                     |
| `ZQ_SESSION_TTL_DAYS`                            | 30                                                            |                                                                                                                                                                |
| `ZQ_LOG_LEVEL`                                   | `info`                                                        |                                                                                                                                                                |

## Components

- **`ports/local-auth.ts`**
  - `LocalLogin` + `HostAuth`: scrypt verify with `crypto.scrypt` + `timingSafeEqual`.
  - HS256 JWT via `jose`: `sub = local:{user}`, 12 h expiry, issuer `zqhoot`.
  - `hostId = local:{user}`.
- **`ports/local-media.ts`**
  - `createUpload` returns a PUT grant to `/api/media/{key}?t={token}`. The token is a short HMAC (key: `ZQ_JWT_SECRET`) over key + content type + expiry, valid 5 minutes.
  - `put` verifies the token, streams to `{dataDir}/media/{key}.tmp` while counting bytes (abort past 5 MB), checks magic bytes for PNG/JPEG/WebP/GIF, then renames.
  - Rejects path traversal: the key must match the protocol's `MediaKey` regex, and the resolved path must stay under `dataDir/media`.
- **`ports/ids.ts`**
  - `nanoid` for IDs; `crypto.randomBytes(32)` base64url tokens; `crypto.randomInt` for PINs (first digit 1-9).
- **`ports/scheduler.ts`**
  - `setTimeout`-based `scheduleClose` / `cancel` → `service.onTimer`.
  - On startup, restore timers for persisted sessions in phase `question`: fire immediately if the deadline has passed.
- **`ws-transport.ts`**
  - `Map<connectionId, WebSocket>`. `send` uses the service's `stampAndSerialize`, sends as a text frame, and reports closed or missing sockets as gone.
  - Backpressure: skip state messages when `bufferedAmount > 256 KiB`; terminate above 1 MiB.
- **`ws-server.ts`**
  - `new WebSocketServer({ noServer: true, maxPayload: 8192, perMessageDeflate: false })`, attached to the HTTP server's `upgrade` on path `/ws` only.
  - `Origin` checked via `service.onConnect`; rejection answers 403 on the upgrade.
  - Per-socket token bucket (10 msg/s, burst 20): exceeding it sends `error rate-limited` and closes with 1008.
  - Ping sweep every 30 s, terminating sockets that miss a pong.
  - `receivedAt = Date.now()` on message; `onDisconnect` on close.
- **`http.ts`**
  - A `node:http` server; Hono app from `createHttpApp` mounted for `/api/*`.
  - `/config.json` generated from env (valid `RuntimeConfig`, `auth.mode 'local'`, `Cache-Control: no-cache`).
  - `/media/*` from the data dir with immutable caching and `nosniff`.
  - Static files from `ZQ_WEB_DIST`: hashed `/assets/*` immutable; `index.html` no-cache; SPA fallback to `index.html` for extension-less GET paths not under `/api`, `/ws` or `/media`; path traversal rejected.
  - Security headers on HTML responses per ADR-0013 (CSP with `connect-src 'self' ws(s)://host`), as defence in depth even behind Caddy.
- **`main.ts`**
  1. Wire everything. `MemoryStore` via `loadMemoryStore` + `attachFilePersistence` (1 s debounce), with `sweepExpired` every 60 s. Or `DynamoStore` when configured.
  2. `GameService` config: `engine.minLeadMs = TIMING.minLeadMs.node`, `revealSettleMs = 0`.
  3. Graceful shutdown on SIGTERM/SIGINT: stop accepting, close sockets with 1001, flush persistence, exit within 10 s.
- **`cli/hash-password.ts`**, exposed as `pnpm --filter @zqhoot/server-node hash-password`: reads the password from stdin without echo when interactive (or piped), and prints the `scrypt$…` string. Parameters N=2^15, r=8, p=1, 16-byte salt, 32-byte key. Document them.
- **Scripts:**
  - `dev`: `tsx watch src/main.ts` with a dev `.env`.
  - `build`: esbuild bundle `src/main.ts` → `dist/server.mjs` (ESM, `platform: 'node'`, `target: 'node22'`, sourcemap) and `cli/hash-password.ts` → `dist/hash-password.mjs`. Add the banner needed for `require` in ESM if a dependency needs it.
  - `start`: `node --enable-source-maps dist/server.mjs`.

## Tests (Vitest, real sockets on ephemeral ports)

- **Mini game.** Boot the server in-process with a temp data dir and a built-or-stub web dist.
  - Log in over HTTP, create a quiz and a session.
  - 3 `ws` clients join, answer, and receive reveal, leaderboard and ended.
  - A client reconnects with `resume` mid-question and gets the snapshot.
  - Timer close fires without a host message (short time limit; use the real clock with a 5 s limit, or inject the scheduler clock).
- **Security:**
  - Upgrade with a foreign `Origin` → 403.
  - Upgrade on a path other than `/ws` → destroyed.
  - An 8193-byte frame closes the socket (1009).
  - Flood → `rate-limited` + 1008.
  - Media PUT: bad token, wrong magic bytes, oversize and path traversal are all rejected.
  - Static serving: traversal rejected, SPA fallback, cache headers, `config.json` validates against `RuntimeConfig`.
- **Persistence:** after SIGTERM-style shutdown, state.json exists. A new server instance loads it, the session resumes, and a player can `resume`.
- **Config:** a missing `ZQ_JWT_SECRET` or a short secret exits non-zero with a message.
- **CLI:** `hash-password` output verifies with the local auth.

## Acceptance criteria

1. `pnpm --filter @zqhoot/server-node typecheck`, `test` and `build` pass; `node dist/server.mjs` starts with a minimal env and serves `/api/health`.
2. The package contains no game logic: messages go straight to `GameService`, HTTP to `createHttpApp`. A review of `src/` should find only adapter code.
3. `apps/server-node/README.md` covers env vars, dev workflow, build, the hash-password CLI and operational notes: single process, persistence, restart behaviour.
4. `pnpm exec prettier --check apps/server-node` passes. Comments explain non-obvious _why_ only.
