# @zqhoot/server-node

The single-process server of the VM target ([ADR-0015](../../docs/adr/0015-vm-deployment.md)). One Node process serves the web app, `/config.json`, the HTTP API, the WebSocket endpoint and uploaded media.

It is an adapter and nothing more. Every game decision is made by [`@zqhoot/service`](../../packages/service/README.md) (`GameService` for WebSocket messages, the Hono app from `createHttpApp` for `/api/*`) on top of `@zqhoot/engine`. This package supplies what the service asks for from its runtime: the ports (`Transport`, `Scheduler`, `HostAuth`/`LocalLogin`, `MediaStorage`, `Ids`, `Clock`, `Logger`), a `Store`, and the network.

```
browser ──HTTP──► node:http ──/api/*──► Hono app (createHttpApp) ──► Store
   │                  │  └─ /config.json, /media/*, static files
   └────WebSocket──► /ws (ws) ──► GameService ──► Store, Transport ─► sockets
                                       ▲
                       setTimeout ─────┘  (question deadlines)
```

## Quick start

```sh
pnpm install
pnpm --filter @zqhoot/web build            # the server serves apps/web/dist by default
pnpm --filter @zqhoot/server-node dev      # http://localhost:8080, admin / dev-password
```

`dev` runs `tsx watch` with [`dev.env`](dev.env), which holds throwaway values (a plaintext admin password, a fixed JWT secret, debug logging, `./data` for state). Variables you export in your shell win over the file. Do not reuse those values anywhere reachable by other people.

With `vite dev` in front (`pnpm --filter @zqhoot/web dev`, port 5173, proxying `/api`, `/config.json` and `/ws` to 8080) the browser's origin is `http://localhost:5173`, so start the server with `ZQ_PUBLIC_URL=http://localhost:5173`. Otherwise the WebSocket `Origin` check answers 403 and `config.json` names the wrong `wsUrl`.

## Commands

Run from the repository root with `pnpm --filter @zqhoot/server-node <script>`.

| Script          | What it does                                                                                                                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dev`           | `tsx watch --env-file=dev.env src/main.ts`                                                                                                                                                            |
| `build`         | esbuild bundles `src/main.ts` to `dist/server.mjs` and `cli/hash-password.ts` to `dist/hash-password.mjs` (ESM, `node22`, source maps). Every dependency is inlined                                   |
| `start`         | `node --enable-source-maps dist/server.mjs`                                                                                                                                                           |
| `hash-password` | Prints an `scrypt$...` value for `ZQ_ADMIN_PASSWORD_HASH` (see below)                                                                                                                                 |
| `typecheck`     | `tsc` over `src`, `cli`, `scripts`, `test`                                                                                                                                                            |
| `test`          | Vitest. Real sockets on ephemeral ports, a temp data dir and a stub web app. The DynamoDB test needs DynamoDB Local (`ZQ_DDB_ENDPOINT`, default `http://localhost:8000`); `ZQ_SKIP_DYNAMO=1` skips it |

The bundle needs nothing beside itself: `node dist/server.mjs` with `ZQ_PUBLIC_URL`, `ZQ_JWT_SECRET` and a password is enough. The banner in `dist/server.mjs` defines `require`, which the CommonJS code inside `ws` needs in an ES module. `ws`'s optional native add-ons (`bufferutil`, `utf-8-validate`) are left out on purpose; it falls back to JavaScript.

## Configuration

Read from the environment at startup and validated with zod. An invalid or missing value prints every problem (never the rejected value) and exits with status 1. An empty value counts as unset, so `KEY=` in a `.env` file behaves like no line at all.

| Variable                                         | Default                                | Meaning                                                                                                                                                                                                                                          |
| ------------------------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ZQ_PORT`                                        | `8080`                                 | Listen port. `0` picks a free one                                                                                                                                                                                                                |
| `ZQ_HOST`                                        | `0.0.0.0`                              | Listen address                                                                                                                                                                                                                                   |
| `ZQ_PUBLIC_URL`                                  | **required**                           | The URL browsers use, as an origin without a path: `https://quiz.example.com`. It gives `config.json` (`wsUrl` = `wss://host/ws`, `joinUrl` = `.../join`, `mediaBaseUrl` = `.../`), the CSP `connect-src` and the one allowed WebSocket `Origin` |
| `ZQ_DATA_DIR`                                    | `./data`                               | `state.json` and `media/`. Created if missing                                                                                                                                                                                                    |
| `ZQ_STORE`                                       | `memory`                               | `memory` (JSON file persistence) or `dynamodb`                                                                                                                                                                                                   |
| `ZQ_TABLE_NAME`, `ZQ_DDB_ENDPOINT`, `AWS_REGION` |                                        | For `dynamodb`. Table name and region are required; the endpoint is for DynamoDB Local. Credentials come from the AWS SDK's default chain                                                                                                        |
| `ZQ_ADMIN_USER`                                  | `admin`                                | The one host account. Its id is `local:{user}`                                                                                                                                                                                                   |
| `ZQ_ADMIN_PASSWORD_HASH`                         |                                        | `scrypt$N$r$p$saltB64$hashB64` from `hash-password`                                                                                                                                                                                              |
| `ZQ_ADMIN_PASSWORD`                              |                                        | Plaintext, for development only (a warning is logged). One of hash or password is required; the hash wins when both are set                                                                                                                      |
| `ZQ_JWT_SECRET`                                  | **required**                           | At least 32 bytes. Signs host JWTs and media upload tokens. `openssl rand -base64 48`                                                                                                                                                            |
| `ZQ_WEB_DIST`                                    | `../web/dist` (monorepo) or `/app/web` | Built web app. The default is `apps/web/dist` relative to this package, falling back to `/app/web` when that has no `index.html` (the Docker image)                                                                                              |
| `ZQ_TRUST_PROXY`                                 | `false`                                | `true`: the client address is the first `X-Forwarded-For` hop. Only set it when the app is reachable through your proxy alone; otherwise anyone can forge the header and dodge the per-IP limits                                                 |
| `ZQ_SESSION_TTL_DAYS`                            | `30`                                   | How long a session's data (and its CSV export) is kept, counted from its creation. Quizzes never expire                                                                                                                                          |
| `ZQ_LOG_LEVEL`                                   | `info`                                 | `debug`, `info`, `warn`, `error` or `silent`                                                                                                                                                                                                     |

In a `.env` file, put the password hash in single quotes: it contains `$` characters, which Docker Compose would otherwise try to expand.

### `hash-password`

```sh
pnpm --filter @zqhoot/server-node hash-password          # prompts twice, no echo
printf '%s' "$PASSWORD" | pnpm --filter @zqhoot/server-node hash-password
node dist/hash-password.mjs                              # from a build, no pnpm needed
```

On a terminal it asks for the password twice without echoing it. With piped input it reads all of stdin and removes one trailing newline. The only thing on stdout is the hash; prompts and warnings go to stderr, so `HASH=$(... hash-password)` works.

Parameters: scrypt with N = 2^15 (32768), r = 8, p = 1, a 16-byte random salt and a 32-byte key, written as `scrypt$32768$8$1$<salt base64>$<key base64>`. Hashing takes roughly 100 ms and 32 MiB, which is also what every login costs. The server accepts any well-formed hash with N up to 2^20, r up to 32 and p up to 16 whose memory need is at most 512 MiB, and it verifies with the parameters stored in the hash.

## What the server exposes

| Path            | Served by                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/*`        | The service's Hono app. Routes and status codes: [`packages/protocol/src/http.ts`](../protocol/src/http.ts). `/api/health` returns `{ok, version, target: "vm"}` (Docker healthcheck) |
| `/config.json`  | Generated from the environment, validated against the protocol's `RuntimeConfig`, `auth.mode: "local"`, `Cache-Control: no-cache`                                                     |
| `/ws`           | The WebSocket endpoint, below                                                                                                                                                         |
| `/media/*`      | Uploaded images from `{ZQ_DATA_DIR}/media`, `Cache-Control: public, max-age=31536000, immutable`, `nosniff`                                                                           |
| everything else | The built web app from `ZQ_WEB_DIST`                                                                                                                                                  |

**Static files.** `/assets/*` (hashed by Vite) is immutable for a year. `index.html`, the SPA fallback and everything else use `no-cache` with a weak `ETag`, so a revalidation costs a 304. A GET or HEAD for a path without a file extension that is not a file, and is not under `/api`, `/ws` or `/media`, gets `index.html` (the SPA fallback). A missing path with an extension is a 404, never the app shell. A path that decodes to `..`, a NUL or a backslash is a 400; dotfiles other than `/.well-known` are a 404, so pointing `ZQ_WEB_DIST` at a repository root does not publish `.env` or `.git`. Other methods get 405.

**HTML response headers** ([ADR-0013](../../docs/adr/0013-security.md)), repeated here so a deployment without Caddy is still covered: `Content-Security-Policy` (`default-src 'self'`, `connect-src 'self'` plus the `ws(s)://` origin of `ZQ_PUBLIC_URL`, `img-src 'self' data: blob:`, `style-src 'self' 'unsafe-inline'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`), `X-Content-Type-Options`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, and HSTS for one year when `ZQ_PUBLIC_URL` is `https`. The server does not compress responses; Caddy does.

### WebSocket

- One `WebSocketServer` attached to the HTTP server's `upgrade` event, path `/ws` only. An upgrade for any other path is destroyed without a response.
- `Origin` must equal the origin of `ZQ_PUBLIC_URL` exactly (`service.onConnect`); otherwise the upgrade is answered `403`. A missing `Origin` is refused too.
- `maxPayload` is 8192 bytes: a larger frame closes the socket with 1009. The service enforces its own 4096-byte message limit with an `error` reply. `perMessageDeflate` is off. Binary frames get `error bad-request`.
- Per socket, a token bucket of 10 messages per second with a burst of 20. When it runs dry the client gets `error rate-limited` and the socket closes with 1008.
- A socket's frames are handled one at a time and in order, as API Gateway does. `receivedAt` is the arrival time in this process, taken before the frame waits in that queue.
- Every 30 s a ping goes to each socket; one that has not answered the previous ping is terminated.
- `send` serialises a broadcast once and stamps `ts` per recipient just before writing. A socket with more than 256 KiB of unsent data is skipped for state messages (`question`, `reveal`, `leaderboard`, `ended`, `host.state`, `stats`; the next one or a reconnect catches it up), and one with more than 1 MiB is terminated. Replies to the peer itself (`welcome`, `error`, `pong`, `answer.ack`, `kicked`) are never skipped, and neither is `roster`, which carries deltas that a later message would not repair. Missing or closed sockets are reported as gone, and the service updates the roster.

### Media

`POST /api/media/uploads` returns a `PUT` grant: `/api/media/media/{hostSlug}/{id}.{ext}?t={token}`. The token is `{expiresAtMs}.{HMAC-SHA256(ZQ_JWT_SECRET, key + content type + expiry)}`, truncated to 128 bits, valid for 5 minutes and bound to that key and content type. `hostSlug` is a hash of the host id.

`PUT` verifies the token, then streams the body to a temporary file next to its final path (`{key}.{random}.tmp`) while counting bytes, and hard-links it to its final path, which fails if the key already exists (so two concurrent uploads with one grant end with one 204 and one 403). It refuses:

- a bad, expired or reused token (403). A key is written once, because `/media/*` is served as immutable;
- a body over 5 MiB (413), whether announced in `Content-Length` or found while streaming;
- bytes whose signature is not PNG, JPEG, WebP or GIF, or does not match the declared type (415). SVG is never accepted;
- a key that does not match the protocol's `MediaKey` pattern, and any resolved path outside `{ZQ_DATA_DIR}/media` (400).

A refused or interrupted upload removes its temporary file. The data directory must therefore support hard links (any ordinary Linux filesystem does). Files live at `{ZQ_DATA_DIR}/{key}`, that is `media/{hostSlug}/{id}.{ext}`, the same shape as their URL. Image metadata (EXIF) is not stripped.

## Operations

**One process, by design.** All live state is in memory and the timers are `setTimeout`s in this process. Run one instance per data directory (or per DynamoDB table). Horizontal scaling is out of scope.

**Persistence (`ZQ_STORE=memory`).** The whole store is one JSON file, `{ZQ_DATA_DIR}/state.json`, mode 0600 because it holds every quiz with its answers and every player's token hash. It is written about one second after the first change since the last write (a busy game is still saved every second), and once more on shutdown. Each write goes to a temporary file, is synced and renamed over the old file, so a crash leaves either the old or the new complete file. The write is one synchronous pass over the state on the event loop. Expired records are swept every 60 s.

Backups: copy `state.json` (and `media/`) while the server runs; the atomic rename makes a copy of the file consistent. Restore by stopping the server, replacing the files and starting it again.

**Restart behaviour.** On `SIGTERM` or `SIGINT` the server stops accepting connections, closes every WebSocket with 1001, waits for the disconnect handling, writes `state.json` and exits, within 10 s (it exits with status 1 if that does not work). Then, on the next start:

- The state file is loaded; a corrupt file stops the start with an error instead of starting empty.
- Connection records of the previous process are deleted, so hosts do not see players as connected until they are.
- For sessions of the admin account in phase `question`, the deadline timer is set again; a deadline that has passed fires at once, and the question closes and reveals without a host message.
- Players reconnect with `resume` and hosts with `host.hello`; both get a snapshot of the current phase ([ADR-0008](../../docs/adr/0008-reconnect-resume.md)). Nothing is replayed.

After a clean shutdown nothing is lost. After a crash or power loss the state can be up to one second old: an answer accepted in that last second is gone, and the player can answer again.

**`ZQ_STORE=dynamodb`.** Uses `DynamoStore` on an existing table (see [`packages/store/README.md`](../store/README.md)); there is no `state.json` and no sweeper, since DynamoDB expires records itself. Media still goes to `ZQ_DATA_DIR`. Timers are recovered the same way after a restart, by listing the admin's sessions, which uses the table's eventually consistent index. Two processes on one table are not supported: each holds the sockets and timers of its own players only.

**Behind Caddy.** The app listens on plain HTTP (8080) and Caddy terminates TLS. Set `ZQ_PUBLIC_URL` to the address people type, `https://quiz.example.com`, because that exact origin is what browsers send in `Origin`, and set `ZQ_TRUST_PROXY=true` so the per-IP limits (login: 10 per 15 minutes; failed PIN lookups: 30 per minute; HTTP API: 20 requests per second) count real clients rather than Caddy. Without it the whole audience counts as one address, Caddy's. WebSockets pass through `reverse_proxy` without extra directives.

**Secrets.** `ZQ_JWT_SECRET` and `ZQ_ADMIN_PASSWORD_HASH` belong in an untracked `.env`. Rotating the JWT secret logs the admin out and invalidates outstanding upload grants; nothing else depends on it.

**Renaming the admin.** Quizzes and sessions belong to `local:{ZQ_ADMIN_USER}`. Changing the user name starts an empty account: the old quizzes are still in the store but belong to the old name, and timers of old sessions are not recovered.

**Logs.** One JSON object per line (`level`, `time`, `msg`, fields), warnings and errors on stderr, the rest on stdout. Secrets, tokens and message contents are not logged.

**HTTP rate limit.** Every `/api/*` request spends a token from a bucket of its client address ([ADR-0013](../../docs/adr/0013-security.md): 20 requests per second per IP). The bucket holds 400 tokens, the burst the AWS stage allows, because a class of 400 phones shares one IP and looks up its PIN within seconds; only sustained traffic above 20 per second is refused, with `429`, `Retry-After: 1` and an `ApiError` body. Static files, `/config.json`, `/media/*` and the WebSocket upgrade are not counted. The buckets live in memory and an address is forgotten once its bucket would be full again. This is in addition to the service's own limits on login (10 per 15 minutes) and failed PIN lookups (30 per minute).

**Not in this package.** Response compression and TLS are left to Caddy.

## Source layout

```
src/
  main.ts              env -> config -> createServer -> signals; the process entry point
  server.ts            createServer(config): wires store, ports, service, HTTP and WebSocket
  config.ts            zod validation of the environment, values derived from ZQ_PUBLIC_URL
  http.ts              node:http server, /config.json, HTML security headers, dispatch to Hono
  static-files.ts      static files, SPA fallback, /media/*
  ws-server.ts         upgrade, Origin check, rate limit, ping sweep, shutdown
  ws-transport.ts      Transport over the socket map, backpressure
  password-hash.ts     scrypt hashing and verification (shared with the CLI)
  ports/               local-auth, local-media, ids, scheduler (+ session recovery)
  ip-rate-limit.ts     per-IP token buckets for /api/*
  client-ip.ts, request-path.ts, token-bucket.ts, logger.ts
cli/hash-password.ts   the CLI
scripts/               esbuild bundling
test/                  Vitest
```

## Tests

| File                                              | Covers                                                                                                                                                            |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `game.test.ts`                                    | A whole quiz on real sockets: login, quiz, session, three players, answers, reveal, leaderboard, a timer close with no host message, `resume` mid-question, ended |
| `websocket-security.test.ts`                      | Foreign, missing and near-miss `Origin`, other paths, 8193-byte frames (1009), the 4 KB limit, binary frames, flooding (1008), ordering                           |
| `static.test.ts`, `media.test.ts`                 | `config.json`, headers, caching, SPA fallback, traversal and dotfiles; upload grants, magic bytes, size limits, reuse, traversal                                  |
| `persistence.test.ts`                             | Shutdown writes `state.json`, restart resumes the session and player, stale connections, timers restored, `SIGTERM` of the real process                           |
| `config.test.ts`, `cli.test.ts`, `bundle.test.ts` | Validation and exit codes, `hash-password` output against the local auth, the esbuild bundle running on its own                                                   |
| `dynamodb.test.ts`                                | The same wiring on `DynamoStore` (DynamoDB Local)                                                                                                                 |
| `api-rate-limit.test.ts`                          | The per-IP bucket on `/api/*`: burst, refill, 429 shape, unaffected static routes                                                                                 |
| the rest                                          | Units for local auth, local media, the scheduler and recovery, the transport, the token bucket, client IP handling, ping sweep, sweeper                           |
