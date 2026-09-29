# ADR-0007: Broadcast strategy

Status: accepted (2026-09-29)

## Context

API Gateway's management API has only per-connection operations: `PostToConnection`, `GetConnection` and `DeleteConnection` ([aws-realtime](../research/aws-realtime.md) A3). Errors are 410 `GoneException` (connection gone), 429 `LimitExceededException` (rate, *or the client's buffer is full*) and 413. No numeric `PostToConnection` rate or latency is documented. Calls count against the account's shared 10,000 rps throttle. SDK v3's Node handler defaults to `keepAlive: true, maxSockets: 50`.

## Decision

### Lambda (`apps/server-lambda`)

- The invocation that handles a host command performs its own fan-out. No worker Lambdas and no SQS: 400 recipients fit comfortably in one invocation.
- Recipients come from one Query of `SESS#{sid}` / `CONN#…`, filtered by role and player.
- Sends run through a bounded pool of 50 concurrent `PostToConnection` calls. Each call has its own try/catch, and the invocation awaits every call before returning; un-awaited promises are cut off when the handler returns ([realtime-patterns](../research/realtime-patterns.md) 1b).
- **410:** delete that connection's two items. This is the failing connection, not the invoking one; the AWS sample gets this wrong. Report it as gone so hosts see a `roster` update.
- **429:** the SDK's default retry strategy already classifies `LimitExceededException` as throttling and retries it. After retries are exhausted, log it and move on: level-triggered state lets the client recover on its next message or reconnect.
- The API client is created once per container with the stage's callback endpoint.
- Messages whose content differs per recipient (`reveal`, `leaderboard`, `ended`) are serialised per recipient. The cost is CPU-trivial at 400 recipients, and the number of calls is the same either way.

### Node (`apps/server-node`)

- An in-process map of connection ID to socket.
- A payload shared by all recipients is serialised once. The `ts` field is spliced in per recipient by concatenating a prefix, which is cheaper than re-stringifying the object. The frame is sent as text (`{ binary: false }`).
- A socket with `bufferedAmount > 256 KB` is skipped for state messages, since level-triggered state lets it catch up. Above 1 MB it is terminated, and the client reconnects and resumes.
- `perMessageDeflate` stays off: `ws` warns of CPU and memory cost ([realtime-patterns](../research/realtime-patterns.md) 1a).
- `maxPayload: 8192`. A protocol ping sweep every 30 s terminates sockets that miss a pong.

### Stale connections

`$disconnect` is best-effort. Connection items carry a 3 h TTL, a little over API Gateway's 2 h maximum duration, and are deleted on 410. A player's liveness shown to hosts (`connected`) is derived from whether any connection item exists for them.

## Consequences

- Expected spread for one 400-way broadcast at an assumed 15-60 ms per call: 120-480 ms ([aws-realtime](../research/aws-realtime.md) E1). The 1.5 s minimum lead in [ADR-0005](0005-timing-fairness-scoring.md) covers up to about 180 ms per call.
- Beyond about 1,000 players per session, split recipients across K parallel self-invocations. That is not built in v1.
- The load test measures the real broadcast-to-receipt distribution ([ADR-0014](0014-load-testing.md)).
