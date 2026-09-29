# ADR-0008: Reconnect and resume

Status: accepted (2026-09-29)

## Context

Mobile sockets die routinely. WebKit closes WebSockets when a page enters the back/forward cache. Screen lock, app switch and Wi-Fi→cellular handovers drop connections. `navigator.onLine` is unreliable ([realtime-patterns](../research/realtime-patterns.md) 4). API Gateway closes idle connections after 10 minutes and every connection after 2 hours. Browsers cannot send protocol-level pings.

## Decision

### Credentials

- `join` returns `{sessionId, playerId, token}`. The token is 32 random bytes, base64url. The server stores only its SHA-256.
- The client stores the credentials in `sessionStorage` (per the brief) under `zqhoot:session`. It mirrors them to `localStorage` under `zqhoot:session:{sessionId}`, because iOS can discard a backgrounded tab, and that loses `sessionStorage`. On load, `/play` prefers `sessionStorage`, then the mirror when it has a `?s={sessionId}` hint. Both are cleared on `ended`, `kicked` or `leave`. Every storage access is wrapped in try/catch because either store can throw.

### Resume

`resume` → verify the token hash, check the player isn't kicked and the session hasn't expired, write the connection items, reply `welcome` with a `PlayerSnapshot` for the current phase. The snapshot includes the player's responses to the open question, so the UI shows "answer locked in" rather than the options. Hosts get a `roster` update (`connected: true`). No message replay: state is level-triggered ([ADR-0004](0004-wire-protocol.md)).

Hosts resume the same way with `host.hello`: the JWT is re-verified and a full `HostSnapshot` is sent.

### Client connection manager (`apps/web`)

- **Backoff:** full jitter, `delay = random(0, min(10 s, 500 ms · 2^attempt))`, unlimited attempts, attempt counter reset after 10 s connected.
- **Visibility:** on `visibilitychange` → visible or `pageshow` (including `persisted`), if the socket isn't open, reconnect after a random 0-500 ms. The jitter spreads a class of phones waking together under API Gateway's 500-connection burst.
- **Heartbeat:** if nothing is received for 45 s, send `ping`. If no `pong` arrives within 10 s, close and reconnect.
- **Planned reconnect:** after about 110 minutes, reconnect proactively between questions, before API Gateway's 2-hour cutoff.
- **Wake Lock:** request `navigator.wakeLock` during play when available (HTTPS only). Re-request on `visibilitychange`. Failure is silent.
- **UI:** a non-blocking "Reconnecting…" status (`role="status"`), with no loss of the current screen.

## Consequences

- A phone that locks mid-question and unlocks before the deadline can still answer. Its score is unaffected unless it missed the window.
- A token copied to another device can take over the player. That is acceptable for an anonymous game, and it also covers switching phones. The newest connection receives messages; older connection items expire or return 410.
