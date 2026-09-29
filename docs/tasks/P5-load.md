# P5-load: 400-player WebSocket load test

Owner: Sonnet implementation agent. Reviewer: independent Opus agent.

## Goal

Prove 400 concurrent players in one session work, with numbers. Write a k6 test in `load/` that can target either deployment. Run it locally against the Node server (required) and against the Lambda code path through the local API Gateway emulator (best effort). Report the results. Running against AWS is the owner's call: provide the script and instructions, but do not run it.

Read first:

- `docs/adr/0014-load-testing.md` (tool choice, metrics)
- `docs/adr/0005-timing-fairness-scoring.md`, `docs/adr/0007-broadcast.md`
- `packages/protocol/src/messages.ts`
- `apps/server-node/README.md`, `apps/server-lambda/README.md` (emulator)

## Files you own

- `load/**`: `package.json` (only if needed for a workspace name, no dependencies), `zqhoot.js`, `lib/*.js`, `run-local.sh`, `run-aws.sh`, `README.md`, `RESULTS.md`, `results/` (JSON summaries committed; raw output gitignored).

## Environment

- k6 v1.8.1 is at `/usr/local/bin/k6`. Use `import { WebSocket } from 'k6/websockets'`; the experimental path is deprecated.
- The machine has 4 CPUs and 15 GB RAM. k6 and the server share it, so record CPU and RSS of both (sample `/proc/<pid>/stat` and `status` every second from `run-local.sh`).

## Script design (`load/zqhoot.js`)

- **Configuration** from env:
  - `ZQ_BASE_URL`, `ZQ_WS_URL`
  - `ZQ_AUTH_MODE` = `local` (username/password env) or `token` (`ZQ_HOST_TOKEN`, e.g. a Cognito ID token)
  - `ZQ_PLAYERS` (default 400), `ZQ_QUESTIONS` (default 10), `ZQ_RECONNECT_RATIO` (default 0.10), `ZQ_TIME_LIMIT` (default 20)
- **`setup()`:**
  - Log in, create a quiz over HTTP with `ZQ_QUESTIONS` questions (a mix: mostly single choice, plus true/false and a poll; all timed at `ZQ_TIME_LIMIT`), create a session, and return `{pin, sessionId, token}`.
- **Host scenario** (1 VU, `shared-iterations`, 1 iteration):
  1. Connect, send `host.hello`, and wait until the roster reaches `ZQ_PLAYERS`, with a join-phase timeout of 90 s. Then start.
  2. For each question: `host.next`. Poll `host.stats` every 1 s. Close on all-answered or at the deadline (as the real host client does), then `host.next` through reveal, leaderboard and the next question.
  3. Finally `host.next` to `ended`.
  4. Record the host-side timing of each transition.
- **Player scenario** (`ZQ_PLAYERS` VUs, `per-vu-iterations` 1):
  1. Ramp joins over about 20 s, using a jittered start (`sleep(random 0-20 s)`), to mimic a room joining.
  2. `GET /api/join/:pin`, connect, `join` with a unique nickname.
  3. On `question`: answer after `openAt` + a random delay drawn from a log-normal-like distribution (median about 3 s, clipped to 0.4-(limit-1) s), computed with the offset rule (min of `local - ts`). Pick the first option 60% of the time, otherwise random.
  4. Reconnect: `ZQ_RECONNECT_RATIO` of players, chosen deterministically by VU number, close their socket once at a random point mid-game (during a question), wait 0.5-3 s, reconnect with `resume` using the stored token, and continue.
  5. The VU ends on `ended` or at the global timeout.
- **Custom metrics** (ADR-0014):

| Metric                    | Type    | Definition                                                                                                                                                                                                                                                                          |
| ------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zq_join_success`         | Rate    | `welcome` received after `join`                                                                                                                                                                                                                                                     |
| `zq_resume_success`       | Rate    | `welcome` received after `resume`                                                                                                                                                                                                                                                   |
| `zq_msg_expected`         | Counter | per player, per question: `question` + `reveal` (+ `leaderboard` for scored), + 1 `ended`. After a resume, the `welcome` snapshot counts for the phase it reports; messages that fell inside the disconnect window are counted in `zq_msg_missed_while_disconnected`, not as losses |
| `zq_msg_received`         | Counter | matching deliveries                                                                                                                                                                                                                                                                 |
| `zq_broadcast_latency_ms` | Trend   | local receipt time minus the message `ts`, for `question`, `reveal`, `leaderboard` and `ended`                                                                                                                                                                                      |
| `zq_answer_ack_ms`        | Trend   | time from sending `answer` to its `answer.ack`                                                                                                                                                                                                                                      |
| `zq_answer_accepted`      | Rate    | `accepted` or `duplicate` vs rejected                                                                                                                                                                                                                                               |
| `zq_errors`               | Counter | tagged with `code`                                                                                                                                                                                                                                                                  |

- **Thresholds**, reported and not a gate for the script's exit code except where stated: `zq_join_success > 0.995` (gate), `zq_msg_received / zq_msg_expected > 0.995` (reported), and `zq_answer_accepted > 0.99` (gate).
- **`handleSummary`:** write `results/{timestamp}-{target}.json` (the k6 summary plus the custom metrics and derived delivery rate) and print a compact table.

## Runners

- **`load/run-local.sh node|lambda-emulator`:**
  - Builds what is needed.
  - Starts the target: the Node server on a temp data dir, or the emulator + DynamoDB Local with a unique table.
  - Raises the `ulimit -n` if needed. Samples server and k6 CPU/RSS into `results/{ts}-{target}-resources.csv`.
  - Runs k6, stops everything, and prints the summary.
- **`load/run-aws.sh`:** takes the site URL, WebSocket URL and a host ID token (with instructions to obtain one via the Cognito hosted UI, or `aws cognito-idp initiate-auth` if the operator enables that flow), and runs k6 against them. Document running k6 from a machine near the Region and the clock-skew caveat for latency.

## Results (`load/RESULTS.md`)

- Record for every run:
  - date, commit, target, machine
  - players, questions, reconnect ratio
  - join success rate, resume success rate, delivery rate
  - broadcast latency p50/p95/p99/max by message type, answer ack p50/p95/p99
  - errors by code
  - server peak CPU/RSS, k6 peak CPU/RSS
- Interpretation: what is and isn't representative. Localhost has no network latency; the emulator isn't API Gateway.
- Include the Node run (required) and the emulator run (if completed).
- Say plainly if any metric misses its target, and why, with evidence.

## Acceptance criteria

1. `load/run-local.sh node` completes a 400-player, 10-question run with 10% reconnects here. The results are committed in `load/results/` and summarised in `RESULTS.md`, with the gates met or the failure explained.
2. The script works unchanged against another target through env vars only. Show this with the emulator run, or explain precisely why it couldn't run.
3. The metrics match the definitions above. The reviewer will check the delivery accounting around reconnects.
4. `load/README.md` explains how to reproduce the run locally and against AWS in five commands or fewer each.
