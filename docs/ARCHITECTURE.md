# zqhoot architecture

zqhoot is a self-hosted live quiz and audience-response app. A host drives a session from a laptop connected to a projector; up to about 400 players join from phones with a PIN and a nickname. One codebase deploys to AWS serverless (scale to zero) or to a single Linux VM.

Research inputs: [docs/research/SUMMARY.md](research/SUMMARY.md). Decisions: [docs/adr/](adr/).

## Choices applied unless the owner overrides them

These are the recommended answers to the open questions raised at the end of Phase 2. They are in effect until the owner says otherwise.

| #   | Question                                                                                      | Choice in effect                                                                                                                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | New AWS accounts may have Lambda concurrency as low as 10, which throttles a 400-answer burst | Ship a preflight check (`scripts/aws-preflight.sh`) that reads the account's concurrency and refuses to call a deployment "400-ready" below 100. The deploy guide includes a quota-increase request step. The answer path stays on Lambda. |
| 2   | VM TLS needs a certificate authority                                                          | Caddy with automatic HTTPS (ACME) by default. Bring-your-own certificate and Caddy's internal CA are documented alternatives for on-prem and air-gapped sites.                                                                             |
| 3   | Scoring                                                                                       | Correct answers earn 1000 → 400 points, linear over the time limit, with a 250 ms full-points window. The streak bonus is a per-quiz option, off by default. ([ADR-0005](adr/0005-timing-fairness-scoring.md))                             |
| 4   | Open-ended moderation default                                                                 | New open-ended questions default to "require approval". The host can switch a question to show immediately; profanity-filter hits are always held.                                                                                         |
| 5   | Session data retention                                                                        | Live-session data expires 30 days after creation (DynamoDB TTL; sweeper on the VM). This is the CSV export window. Quizzes never expire.                                                                                                   |
| 6   | Host accounts on AWS                                                                          | Cognito Essentials tier with self-sign-up disabled; operators create hosts with the AWS CLI or console. The VM target has a single admin account set by environment variables.                                                             |
| 7   | Build order                                                                                   | The web design system and screens start in wave 1 against protocol fixtures, in parallel with engine, store and Terraform. The brief suggested wave 2; starting early removes the longest serial step.                                     |
| 8   | AWS Region                                                                                    | `us-east-1` default (Terraform variable). Several newer Regions have a 2,500 rps API Gateway throttle instead of 10,000.                                                                                                                   |

## System overview

```
AWS serverless target
─────────────────────
 phones / host laptop / projector browser
   │ HTTPS: static, /api/*, /media/*                       │ WSS (direct)
   ▼                                                       ▼
 CloudFront ──default──► S3 site bucket          API Gateway WebSocket API
   ├── /api/*  ─► API Gateway HTTP API ─► λ http          $connect / $disconnect / $default
   └── /media/* ─► S3 media bucket (OAC)                   └──► λ ws ──PostToConnection──┐
                                                                   │                      │
               λ http ──────────────┬──────────────────────────────┘                      │
                                    ▼                                                     ▼
                     DynamoDB single table (on-demand, TTL)              back to connected clients
 Cognito user pool (managed login, PKCE) → host JWTs verified in λ http and λ ws

VM target
─────────
 browsers ─► Caddy :443 (TLS) ─► node server :8080
                                   ├── static web app + /config.json
                                   ├── /api/*   (same Hono app as λ http)
                                   ├── /ws      (ws library, same GameService as λ ws)
                                   └── /media/* (local disk)
                                   state: in-memory store, JSON snapshot to ./data
```

### Packages

```
packages/protocol   zod schemas for every client<->server message, HTTP bodies, runtime config, limits
packages/engine     pure game logic: domain records, state machine, scoring, nickname rules,
                    result aggregation, snapshots. No I/O, no clock (time is passed in).
packages/store      Store interface + DynamoStore + MemoryStore (optional JSON persistence),
                    one contract test suite run against both
packages/service    GameService (WebSocket events) and the Hono HTTP app. Orchestrates
                    engine + Store + ports (Transport, HostAuth, Media, Clock, Ids, Warmer).
apps/server-lambda  API Gateway event -> GameService/Hono adapters; DynamoStore; PostToConnection transport
apps/server-node    http + ws adapters; MemoryStore; timers; static file serving
apps/web            React + Vite: /join, /play, /host, /present, /edit
```

Dependency direction: `protocol ← engine ← store(interface) ← service ← server-*`; `protocol ← web`. The engine does not know which transport or store it runs on. Both servers are thin adapters around `packages/service`. That package is an addition to the brief's layout; the reason is in [ADR-0001](adr/0001-repo-layout-and-toolchain.md).

## Game flow and state machine

```
            host.next                 host.close (manual | timer | all-answered)
  lobby ───────────────► question(i) ─────────────────► revealing(i) ──(settle, compute)──► reveal(i)
                            │  ▲                                                            │
                  host.skip │  │ host.next (next unscored/scored question)                  │ host.next
                            ▼  │                                                            ▼
                     question(i+1) ◄───────────── host.next ─────────── leaderboard(i)  (scored questions only)
                                                                              │
  any phase ── host.end ──► ended (podium)  ◄── host.next after the last question
```

- `question(i)` has two sub-states derived from time: _get ready_ (`now < openAt`, question visible, options inert) and _open_ (`openAt ≤ now ≤ deadline + grace`).
- `revealing(i)` exists because on Lambda, answers accepted just before close may still be in flight. The close handler waits a settle interval, then computes results ([ADR-0006](adr/0006-answers-aggregation-reveal.md)). If the handler dies mid-way, the next host command re-runs the reveal, which is deterministic.
- Only host commands and the question timer change phase. Joins, answers, heartbeats and reconnects never write session state.
- Timer expiry: on the VM the server schedules the close itself. On Lambda there is no process to hold a timer, so host clients send `host.close {reason:'timer'}` at the deadline. Late answers are rejected by server time regardless of when the close arrives, so a slow or absent host delays the reveal but cannot change scores.

## Key decisions (summaries; details in ADRs)

| ADR                                            | Decision                                                                                                                                                                                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [0001](adr/0001-repo-layout-and-toolchain.md)  | pnpm monorepo, TypeScript 7, zod 4, Vitest 5, Vite 8, React 19, Playwright 1.56.1 (matches the preinstalled Chromium), k6. Internal packages export TS source; bundlers compile. Adds `packages/service`.                                         |
| [0002](adr/0002-realtime-transport.md)         | API Gateway WebSocket on AWS, `ws` on the VM, both behind a `Transport` port. AppSync Events is the documented swap-in. HTTP goes through CloudFront (same origin); WebSocket connects directly to API Gateway.                                   |
| [0003](adr/0003-state-model-and-dynamodb.md)   | Single table, `pk`/`sk`, one sparse GSI for "sessions by host", TTL on everything live. Session meta is tiny and host-written; the quiz snapshot is a separate immutable item.                                                                    |
| [0004](adr/0004-wire-protocol.md)              | JSON messages validated by zod at every boundary; major version `v` in join/resume/hello; level-triggered state with a session version `sv`; per-recipient `ts`. Correct answers only go to hosts before reveal.                                  |
| [0005](adr/0005-timing-fairness-scoring.md)    | Server-time scoring. Questions are broadcast ahead of `openAt` (lead ≥ fan-out spread). Clients derive the server clock from `ts` and open options at the same instant. Points 1000→400 linear, 250 ms full-points window, optional streak bonus. |
| [0006](adr/0006-answers-aggregation-reveal.md) | One response item per (question, player, slot), conditional put, 4 partition shards per question, aggregate by Query at reveal, no counters.                                                                                                      |
| [0007](adr/0007-broadcast.md)                  | Lambda: one invocation, pool of 50 `PostToConnection`, 410 deletes the connection, 429 retries with jitter. Node: serialise once per payload, skip slow sockets, 30 s ping sweep.                                                                 |
| [0008](adr/0008-reconnect-resume.md)           | Resume token in `sessionStorage` with a `localStorage` mirror. Snapshot on every (re)connect, full-jitter backoff, idle ping, Wake Lock.                                                                                                          |
| [0009](adr/0009-auth-and-identity.md)          | Cognito managed login + PKCE on AWS; single admin with scrypt hash + HS256 JWT on the VM. Players are anonymous per session with a random 256-bit resume token (hash stored).                                                                     |
| [0010](adr/0010-cold-starts.md)                | esbuild bundles, arm64, 512 MB. When the host creates a session, λ http fires concurrent warm-up invocations of λ ws. No provisioned concurrency.                                                                                                 |
| [0011](adr/0011-media.md)                      | S3 presigned POST with size/type conditions, served via CloudFront OAC. The VM stores media on local disk, served by Node. SVG is never accepted.                                                                                                 |
| [0012](adr/0012-cost-model.md)                 | Idle ≈ $0.02/month. One 400-player, 20-question session ≈ $0.08 of AWS usage plus ≈ $0.03 of static/media transfer.                                                                                                                               |
| [0013](adr/0013-security.md)                   | zod at every boundary, 4 KB message cap, rate limits, CSP and security headers, least-privilege IAM per function, no secrets in the client bundle, Origin checks on WebSocket connect.                                                            |
| [0014](adr/0014-load-testing.md)               | k6 (`k6/websockets`, stable in k6 1.x). One script targets either deployment via environment variables.                                                                                                                                           |
| [0015](adr/0015-vm-deployment.md)              | Docker Compose: `app` (Node) + `caddy`. Named volume for `./data`. One process by design; horizontal scaling is out of scope.                                                                                                                     |
| [0016](adr/0016-visual-identity.md)            | Original identity: answer letters A-D + hexagon/plus/star/dome glyphs + Okabe-Ito fills with ink outlines. 16:9 container-unit stage for the presenter; rem-based phone UI.                                                                       |

## Runtime flows

### Player join

1. Phone opens `/join?pin=123456` (QR) or types the PIN; `GET /api/join/:pin` confirms the session is joinable (rate limited per IP for failed lookups).
2. Phone connects the WebSocket and sends `join {pin, nickname}`.
3. The service normalises the nickname (engine), checks lock/capacity, and atomically inserts the player plus a nickname reservation. It stores the connection and replies `welcome` with `credentials {sessionId, playerId, token}` and a player snapshot.
4. Hosts receive a `roster` delta. Other players receive nothing: the lobby list is shown on the projector only.

### Question round

1. `host.next` → engine schedules question _i_: `openAt = now + max(readSeconds·1000, minLead)`, `deadline = openAt + limit`. Meta is written with a version check.
2. Every player gets `question` (no correct answer); hosts get `host.state` with the full question. Each copy is stamped with `ts` just before it is sent.
3. Phones compute the server clock offset from `ts` and reveal the options at `openAt`.
4. `answer` → server stamps `receivedAt` (API Gateway `requestTimeEpoch` or Node receive time). The engine validates timing and payload and computes `elapsedMs`, correctness and base points. A conditional put stores it and the player gets `answer.ack`.
5. Host clients poll `host.stats` every second for live counts, distributions, word frequencies and the moderation queue.
6. `host.close` → phase `revealing`, `closedAt` set → settle (Lambda 1 s, VM 0) → read responses, players and scoreboard → engine computes result, streaks, ranks, outcomes → write result and scoreboard → phase `reveal`. Each player gets `reveal` with their own outcome; hosts get `host.state`.
7. `host.next` → `leaderboard` for scored questions (top 5, plus each player's standing), otherwise straight to the next question. After the last question: `ended` with a podium.

### Reconnect

The phone reconnects with full-jitter backoff and sends `resume {sessionId, playerId, token}`. The server verifies the token hash, re-registers the connection and replies `welcome` with a snapshot of the current phase: question and timing, the player's responses so far, their reveal outcome, leaderboard standing or final standing. Nothing is replayed.

## Security summary

- Every inbound WebSocket message and HTTP body is parsed with the protocol's zod schema before reaching the engine. Unknown message types are rejected.
- Correct answers exist only in the quiz, the session snapshot and host views until reveal. `toPublicQuestion` is the only projection sent to players, and a unit test asserts it never contains answer fields.
- Rate limits: WebSocket payload ≤ 4 KB; per-connection token bucket on the VM; API Gateway stage and route throttles on AWS; failed PIN lookups and local logins per IP; joins capped per session. Answers are idempotent per slot.
- IAM: λ ws gets DynamoDB item actions on the table and `execute-api:ManageConnections` on its own API. λ http gets DynamoDB on the table and index, `s3:PutObject` on `media/*`, and `lambda:InvokeFunction` on λ ws (warm-up). CloudWatch log groups have explicit retention.
- The web bundle contains no secrets. `/config.json` holds only public identifiers.

Details: [ADR-0013](adr/0013-security.md).

## Cost (summary of [ADR-0012](adr/0012-cost-model.md))

|                                                            | AWS list price, us-east-1, Sept 2026                            |
| ---------------------------------------------------------- | --------------------------------------------------------------- |
| Idle month, zero sessions                                  | ≈ $0.02 (S3 storage), + $0.50 if you use a Route 53 hosted zone |
| One session: 400 players, 20 questions, ≈ 35 min connected | ≈ $0.08 compute/messages/data + ≈ $0.03 CloudFront transfer     |

## Known limits and non-goals (v1)

- Team mode, self-paced (assignment) mode, multi-select, type-answer, slider, ranking, Q&A: not in v1.
- Per-player time multipliers (WCAG 2.2.1 "third party controls time") are deferred. v1 offers untimed questions instead.
- The VM target is one process. A restart mid-game loses at most the last second of state, via a debounced snapshot; connected clients reconnect and resume.
- One session is designed for 400 players. The table design and fan-out work to about 1,000; beyond that, fan-out needs sharding across invocations ([ADR-0007](adr/0007-broadcast.md)).
- iOS Safari behaviour is verified only through emulation in this repo. There is no WebKit browser in the build environment.
