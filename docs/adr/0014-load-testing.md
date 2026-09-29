# ADR-0014: Load testing tool

Status: accepted (2026-09-29)

## Context

The brief asks for k6 or Artillery after checking current WebSocket support. The docs for both (grafana.com, artillery.io) were blocked from this environment, so the check used the tools themselves:

- **k6 1.8.1**, built from source with `go install go.k6.io/k6@latest`. Its module registry (`internal/js/jsmodules.go`) maps `k6/websockets` to the WebSockets implementation and keeps `k6/experimental/websockets` only as a deprecated alias ("k6/experimental/websockets is deprecated and will be removed in a future release. Please use k6/websockets instead."). The module follows the browser `WebSocket` API, which fits our protocol code.
- **Artillery 2.0.34** exists on npm. Not evaluated further.

## Decision

k6 with `k6/websockets`.

- `load/zqhoot.js`: a `host` scenario (1 VU) and a `players` scenario (400 VUs), started together.
  - The host logs in, creates a session over HTTP in `setup()`, connects as control, waits for the target player count, then drives 10 questions. It closes each question when all have answered or at the deadline.
  - Each player looks up the PIN, connects, joins, and answers each question after a random 0.5-5 s delay.
  - 10% of players close their socket once mid-game, reconnect after a jittered delay, and `resume`.
- Metrics (custom k6 metrics):
  - `zq_join_success` (rate)
  - `zq_msg_expected` / `zq_msg_received` (counters for question/reveal/leaderboard/ended deliveries per player)
  - `zq_broadcast_latency_ms` (trend: local receipt time minus the server's `ts`; p50/p95/p99)
  - `zq_resume_success` (rate)
  - `zq_errors` (counter by code)
- One script, both targets. `ZQ_BASE_URL`, `ZQ_WS_URL` and `ZQ_AUTH_MODE` (`local` or `cognito` with a pre-issued ID token in `ZQ_HOST_TOKEN`) select the deployment. `load/run-local.sh` starts the Node server and runs the test; `load/run-aws.sh` targets a deployed stack.
- **Latency caveat.** Broadcast latency compares the load machine's clock with the server's clock. Locally they are the same clock. On AWS, both are NTP-synced, and the error is reported as a caveat alongside the result.
- Results: `load/results/<date>-<target>.json` (k6 summary export) and `load/RESULTS.md`.

## Consequences

- k6 is not an npm dependency. The README documents installing it (a release binary, or `go install go.k6.io/k6@v1.8.1`).
- One k6 process holding 400 WebSocket VUs is comfortably within a laptop's capacity (expected hundreds of MB of RAM). Documented when measured.
