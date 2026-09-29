# ADR-0004: Wire protocol

Status: accepted (2026-09-29)

## Decision

All client↔server messages are JSON objects with a `type` field, defined as zod schemas in `packages/protocol/src/messages.ts`. HTTP bodies are in `http.ts`; the runtime config is in `config.ts`. The same schemas validate on the server (every inbound message) and type the client.

### Versioning

`PROTOCOL_VERSION = 1`. Clients send `v` in `join`, `resume` and `host.hello`, the messages that start a connection's conversation. A server that receives a different `v` replies `error {code:'protocol-version'}` and closes. Additive, optional fields don't bump the version; any change that makes an old client misparse does. Schemas are strict about types and permissive about unknown keys, so an older server ignores new optional fields.

### Messages

Client → server:

| type | Sender | Purpose |
|---|---|---|
| `join` | player | `{v, pin, nickname}`; server replies `welcome` with credentials |
| `resume` | player | `{v, sessionId, playerId, token}` on a new connection |
| `host.hello` | host control / presenter | `{v, sessionId, client, authToken}` |
| `answer` | player | `{questionIndex, payload}`, where payload is `choice` / `boolean` / `text` / `rating` |
| `ping` | any | `{t}` heartbeat; server replies `pong {t}` |
| `leave` | player | voluntary exit |
| `host.next` | host | advance, guarded by `from {phase, questionIndex}` so repeats are no-ops |
| `host.close` | host | end answering now (`manual`, `timer`, `all-answered`) |
| `host.skip` | host | discard the current question |
| `host.end` | host | end the session |
| `host.kick` | host | remove a player |
| `host.lock` | host | block or allow new joins |
| `host.moderate` | host | show or hide an open-ended/word-cloud response |
| `host.stats` | host | poll live stats for the open question (`after` pages open-ended responses) |

Server → client (every message carries `ts`):

| type | Recipient | Purpose |
|---|---|---|
| `welcome` | the connection | role-specific snapshot (+ credentials after `join`) |
| `error` | the connection | `{code, message, ref}` |
| `pong` | the connection | heartbeat reply |
| `question` | players | public question, `openAt`, `deadline`, `sv` |
| `answer.ack` | the player | `accepted` / `duplicate` / `rejected` + reason, entries used |
| `reveal` | players | public result + own outcome |
| `leaderboard` | players | top entries + own standing |
| `ended` | players | podium + own final standing |
| `kicked` | the player | then the connection is closed |
| `host.state` | hosts | full host snapshot after every transition |
| `roster` | hosts | players added/updated/removed |
| `stats` | the polling host | live counts / words / responses / histogram |

### Rules

- **Answer secrecy.** Before reveal, a correct answer appears only in `host.state` / host `welcome` (to authenticated host connections). Players only ever receive `PublicQuestion`, produced by `toPublicQuestion()` in the engine, which has a test asserting no answer fields survive.
- **Level-triggered state.** `question`, `reveal`, `leaderboard`, `ended` and snapshots carry `sv` (session meta version). Clients drop state messages whose `sv` is lower than the last one applied. That removes ordering problems between concurrent invocations without sequence numbers or replay buffers.
- **`ts` per recipient.** The transport stamps `ts` immediately before each send. Clients use it for clock alignment ([ADR-0005](0005-timing-fairness-scoring.md)).
- **Size.** Client messages are capped at 4 KB (`LIMITS.clientMessageMaxBytes`). API Gateway's frame limit is 32 KB and message limit 128 KB. The largest server message, a host snapshot with a 400-name roster, is about 20 KB.
- **Unknown or invalid messages** get `error {code:'bad-request'}` and count toward the connection's rate limit.
