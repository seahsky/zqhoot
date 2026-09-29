# Load test

A [k6](https://k6.io) script that plays one quiz session with a host and 400 phones, and reports whether every phone got every message, how long the messages took, and how long answers took to acknowledge. Design and metric choices: [ADR-0014](../docs/adr/0014-load-testing.md). Numbers from real runs and how to read them: [RESULTS.md](RESULTS.md).

The same script runs against the Node server (VM target), the Lambda code path behind the local API Gateway emulator, and a deployed AWS stack. The target is chosen by environment variables only.

## What it needs

- **k6 1.8.1** (`k6 version`). k6 is not an npm dependency. Install a release binary from <https://github.com/grafana/k6/releases> or run `go install go.k6.io/k6@v1.8.1`. The script uses `k6/websockets`.
- Node 22 and pnpm 10, for the local targets (`pnpm install --frozen-lockfile` once).
- For `lambda-emulator`: DynamoDB Local on `http://localhost:8000` (`ZQ_DDB_ENDPOINT` changes it). If nothing answers there, `run-local.sh` starts it in memory from `/opt/dynamodb-local` (`ZQ_DDB_LOCAL_DIR` changes the directory; Java is required) and stops it again afterwards. An instance that was already running is left alone. To start one yourself, see [`packages/store/README.md`](../packages/store/README.md).
- Linux: the runner samples `/proc`. Both scripts raise `ulimit -n` for the run.

## Run it locally

```sh
pnpm install --frozen-lockfile
load/run-local.sh node               # Node server, 400 players, 10 questions, 10% reconnect
load/run-local.sh lambda-emulator    # built Lambda handlers + local API Gateway + DynamoDB Local
```

Each takes about four minutes. `run-local.sh` builds the target, starts it on free ports with a temporary data directory (or a uniquely named DynamoDB table that it deletes afterwards), runs k6, samples CPU and memory of the server and k6 once a second, stops everything and prints the summary. Its exit status is k6's: `99` means a gate was missed.

Change the load with environment variables, for example a quick check:

```sh
ZQ_PLAYERS=50 ZQ_QUESTIONS=3 ZQ_TIME_LIMIT=10 ZQ_JOIN_RAMP_SEC=5 load/run-local.sh node
```

Every run writes, under `load/results/`:

| File                          | Content                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `{ts}-{target}.json`          | `meta` (config, commit, machine), `derived` (the numbers in RESULTS.md), `resources` (peaks), `k6` (the full k6 summary) |
| `{ts}-{target}-resources.csv` | One row per second: system load, CPU, RSS and open descriptors of the server, k6 (and DynamoDB Local)                    |
| `raw/`                        | k6 and server logs of the run. Git-ignored                                                                               |

`ZQ_RUN_LABEL=name` adds a suffix to the file names, to keep runs with non-default parameters apart.

The JSON files are meant to be committed and hold no credentials. `meta.config` leaves out the password and the host token, and `handleSummary` drops the token from k6's `setup_data` and replaces anything shaped like a JWT (`lib/redact.js`, covered by `test/redact.test.js`, which also scans the committed files). The raw logs under `raw/` are git-ignored; do not commit them.

## Run it against AWS

Running it costs a little money and creates a quiz and a session in your account, so `run-aws.sh` asks before it starts (`--yes` skips the question, `--dry-run` prints the target and stops).

```sh
# 1. A host's Cognito ID token (valid for an hour): see "Getting a host token" below.
export ZQ_HOST_TOKEN='eyJ...'
# 2. Look at what would run; nothing is contacted.
load/run-aws.sh https://d1234abcd.cloudfront.net wss://abc123.execute-api.eu-west-1.amazonaws.com/prod --dry-run
# 3. Run it, from a machine near the Region.
load/run-aws.sh https://d1234abcd.cloudfront.net wss://abc123.execute-api.eu-west-1.amazonaws.com/prod
```

The first argument is the site URL exactly as browsers use it. It is sent as the WebSocket `Origin`, which `$connect` compares with `ZQ_SITE_ORIGIN`. The HTTP API base (`apiBaseUrl`) is read from the site's `/config.json`; give it as a third argument to skip that request. The second is the WebSocket API endpoint, `wss://{api id}.execute-api.{region}.amazonaws.com/{stage}`.

**Getting a host token.** The script needs the ID token of a host, not an access token.

1. Sign in to the deployed site as a host, open the browser's developer tools, Network tab, and copy the value after `Bearer ` from the `Authorization` header of any `/api` request. The app sends the ID token ([ADR-0009](../docs/adr/0009-auth-and-identity.md)).
2. Or, if the operator has added `ALLOW_USER_PASSWORD_AUTH` to the app client's `explicit_auth_flows` (the Terraform module allows only SRP and refresh tokens, so this is a deliberate change to make and undo):

   ```sh
   export ZQ_HOST_TOKEN=$(aws cognito-idp initiate-auth --auth-flow USER_PASSWORD_AUTH \
     --client-id <app client id> --auth-parameters USERNAME=<email>,PASSWORD=<password> \
     --query AuthenticationResult.IdToken --output text)
   ```

**Where to run it.** From an EC2 instance in the stack's Region, or at least a host with a fast, stable connection close to it. From a laptop across an ocean every latency includes that distance, and 400 sockets on a home connection measure the home connection.

**Clock skew.** `zq_broadcast_latency_ms` is the load machine's clock minus the server's `ts`, the same comparison the web client makes with its offset rule ([ADR-0005](../docs/adr/0005-timing-fairness-scoring.md)). On one machine that is exact; between two machines it includes their clock difference. Keep the load machine NTP-synced (on EC2, chrony against the Amazon Time Sync Service) and treat differences of a few milliseconds as noise. A negative minimum is skew, not time travel. `zq_answer_ack_ms` and the host transition times use a single clock, and `zq_question_margin_ms` applies the offset rule, which cancels the skew, so none of the three is affected.

## Parameters

Read by `load/lib/config.js`; every one is optional except where marked.

| Variable                                      | Default                   | Meaning                                                                                                                                                       |
| --------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ZQ_BASE_URL`                                 | required                  | Site or server URL, no path                                                                                                                                   |
| `ZQ_WS_URL`                                   | from `/config.json`       | WebSocket endpoint                                                                                                                                            |
| `ZQ_API_URL`                                  | from `/config.json`       | HTTP API base (`apiBaseUrl`); the base URL when that is empty                                                                                                 |
| `ZQ_ORIGIN`                                   | origin of `ZQ_BASE_URL`   | The `Origin` header of every WebSocket                                                                                                                        |
| `ZQ_AUTH_MODE`                                | `local`                   | `local`: log in with `ZQ_USERNAME` (default `admin`) and `ZQ_PASSWORD` (required). `token`: use `ZQ_HOST_TOKEN` (required); `cognito` is accepted as an alias |
| `ZQ_PLAYERS`                                  | 400                       | Players (one VU each)                                                                                                                                         |
| `ZQ_QUESTIONS`                                | 10                        | Questions: seven single choice, two true/false, one poll per ten                                                                                              |
| `ZQ_RECONNECT_RATIO`                          | 0.10                      | Share of players that drop once mid-game and `resume`. Chosen by player number, so a run always drops the same players                                        |
| `ZQ_TIME_LIMIT`                               | 20                        | Seconds per question (one of the protocol's allowed limits)                                                                                                   |
| `ZQ_READ_SECONDS`                             | 0                         | Quiz `readSeconds`. 0 makes the lead before options open the minimum the server enforces (750 ms Node, 1,500 ms Lambda), the tightest case for ADR-0005       |
| `ZQ_SEED`                                     | 1                         | Seeds join jitter, think times, choices and reconnect points                                                                                                  |
| `ZQ_JOIN_RAMP_SEC`                            | 20                        | Players join at a random moment within this many seconds                                                                                                      |
| `ZQ_JOIN_TIMEOUT_SEC`                         | 90                        | How long the host waits for a full room before starting anyway                                                                                                |
| `ZQ_DWELL_MS`                                 | 1000                      | How long the host looks at a reveal or leaderboard before moving on                                                                                           |
| `ZQ_ANSWER_MEDIAN_SEC`, `ZQ_ANSWER_SIGMA`     | 3, 0.5                    | Log-normal think time after `openAt`, clipped to 0.4 s .. limit - 1 s                                                                                         |
| `ZQ_FIRST_OPTION_SHARE`                       | 0.6                       | Share of answers that pick the first option (or `true`)                                                                                                       |
| `ZQ_DROP_DELAY_MIN_SEC`, `..._MAX_SEC`        | 0.3, 3                    | A reconnecting player drops this long after it sees the question it was picked for                                                                            |
| `ZQ_RESUME_DELAY_MIN_SEC`, `..._MAX_SEC`      | 0.5, 3                    | ... and comes back this long later                                                                                                                            |
| `ZQ_RESUME_RETRIES`                           | 3                         | Retries after a failed `resume`, one second apart per attempt                                                                                                 |
| `ZQ_RUN_LABEL`, `ZQ_RESULTS_DIR`, `ZQ_TARGET` | none, `results`, `custom` | Naming of the results files (set by the runners)                                                                                                              |
| `ZQ_SERVER_NODE_ARGS`                         | none                      | `run-local.sh` only: extra flags for the server's `node` process, such as `--cpu-prof` (see `tools/analyze-cpuprofile.js`)                                    |

## What a run does

- **`setup()`** logs in, creates a quiz with `ZQ_QUESTIONS` questions and a session over HTTP.
- **Host** (1 VU): connects as `control`, waits until the roster shows `ZQ_PLAYERS` (or 90 s), then drives the game as the web app does. `host.next` opens a question, `host.stats` runs once a second, `host.close` goes out on all-answered or at the deadline, and `host.next` moves through reveal and leaderboard to `ended`. Each command's time to its `host.state` is `zq_host_transition_ms{step}`.
- **Players** (`ZQ_PLAYERS` VUs, one iteration each): sleep a random 0-20 s, look up the PIN, connect and `join`. On each `question` they answer after `openAt` plus a think time, using the offset rule (`min(local receipt - ts)`) to put `openAt` on their own clock. A fixed share drops its socket once during a question, waits 0.5-3 s and `resume`s with the stored token. A player finishes on `ended`.

## Metrics

| Metric                                      | Type    | Definition                                                                                                                                           |
| ------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zq_join_success`                           | Rate    | `welcome` received after `join`. One observation per player; a failed PIN lookup counts as a failure. **Gate**: above 99.5%                          |
| `zq_resume_success`                         | Rate    | `welcome` received after `resume`, per attempt                                                                                                       |
| `zq_msg_expected`, `zq_msg_received`        | Counter | Messages owed and delivered, tagged `type` (`question`, `reveal`, `leaderboard`, `ended`). See below. Reported: received / expected above 99.5%      |
| `zq_msg_missed_while_disconnected`          | Counter | Messages that fell inside a disconnect window closed by a successful `resume`. Not a loss                                                            |
| `zq_msg_duplicate`, `zq_msg_via_snapshot`   | Counter | Second arrivals of a message already counted, and deliveries that a `welcome` snapshot stood in for                                                  |
| `zq_broadcast_latency_ms`                   | Trend   | Local receipt time minus the message `ts`, tagged `type`. Receipt time is when k6 read the frame off the socket, not when the JavaScript handler ran |
| `zq_answer_ack_ms`                          | Trend   | From sending `answer` to its `answer.ack`                                                                                                            |
| `zq_answer_accepted`                        | Rate    | `accepted` or `duplicate` against `rejected`. See below. **Gate**: above 99%                                                                         |
| `zq_errors`                                 | Counter | Server `error` codes and the script's own (`ws-closed`, `welcome-timeout`, `answer-rejected-*`, ...), tagged `code`                                  |
| `zq_question_margin_ms`                     | Trend   | How long before `openAt`, on the player's clock, a question arrived. Below zero means the fan-out took longer than the lead (ADR-0005)               |
| `zq_host_transition_ms`, `zq_join_phase_ms` | Trend   | Host side: command to resulting `host.state`, tagged `step`; and time from the host's `welcome` to a full room                                       |

**Delivery accounting.** A player is owed, per question, `question` and `reveal` plus `leaderboard` when the question is scored, and one `ended`. Each owed message ends in one state, settled when the player's game ends (`load/lib/ledger.js`, unit-tested in `load/test/ledger.test.js`):

- **received**: it arrived as a broadcast, or a `welcome` snapshot reported that phase. After `resume` the snapshot counts for the phase it reports (`revealing` counts for the question, since the reveal follows as a broadcast).
- **missed while disconnected**: it was owed after the last message received before the socket dropped and before the phase the resume snapshot reports. ADR-0008 promises no replay, so this is reported and left out of both `zq_msg_expected` and `zq_msg_received`.
- **lost**: it was owed while connected (a later message arrived on the same in-order socket, or nothing more did) and never arrived. It counts in `zq_msg_expected` only. A resume that never succeeds leaves everything after it lost.

So `received / expected` moves only when a connected player misses something. `zq_msg_expected` and `zq_msg_received` are settled once per player, so they appear in the summary only when a player finishes.

**Answer accounting.** `zq_answer_accepted` gets one observation for every answer that was sent or was due to be sent, from whichever of these settles it first:

- **The acknowledgement**: `accepted` or `duplicate` is a 1, `rejected` a 0 (with an `answer-rejected-*` error).
- **The reveal or a snapshot**, when the ack died with a socket the player dropped: `you.answered` says whether the server recorded the answer (a 1, or a 0 with `answer-lost`), and a resume snapshot that already lists the response counts as a 1.
- **Nothing**, by the time the player's game ends: a 0. That is an answer sent on a socket that stayed open and never acknowledged (`ack-timeout`), or one whose outcome no later message reported, or one that was due while the player was offline and never got back (`answer-undelivered`). A server that silently drops answers or acks therefore fails the gate. An answer whose outcome the player could not learn (dropped just before the reveal and back only after it, in the leaderboard or `ended` phase) is counted the same way, so the figure is conservative there.

An answer that the question outran does not count either way: the player was still offline when the question ended, so it is only an `answer-skipped` error. A resume that is slow or fails shows in `zq_resume_success`.

Gates make k6 exit with status 99 when missed. Delivery is reported, not a gate, because k6 thresholds cannot divide two counters; `handleSummary` computes it.

## Tools

| File                           | What it does                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `tools/sample.js`              | The 1 Hz sampler `run-local.sh` starts: CPU, RSS and descriptors per process from `/proc`, as CSV       |
| `tools/summarize-resources.js` | Reduces that CSV to peaks and averages and stores them in the run's JSON                                |
| `tools/results-table.js`       | Prints the Markdown tables of RESULTS.md from results JSON files                                        |
| `tools/analyze-cpuprofile.js`  | Reads a Node `--cpu-prof` profile: how busy the event loop was each second and where the busy time went |

## Tests

The parts that need no k6 (delivery ledger, seeded RNG, quiz generator, checked against the protocol's `QuizInput` schema) run under Node:

```sh
node --test "load/test/*.test.js"
```
