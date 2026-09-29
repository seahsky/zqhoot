# Load test results

400 players in one session, 10 questions, 10% of them reconnecting once, against the Node server (the VM target) and against the Lambda handlers behind the local API Gateway emulator. The test is [`load/zqhoot.js`](zqhoot.js); how to run it and what each metric means is in [README.md](README.md); the design is [ADR-0014](../docs/adr/0014-load-testing.md). Running it against AWS is the owner's call and has not been done.

## Summary

- **Every gate was met, on both targets.** All 400 players joined, all 40 reconnecting players resumed, every one of the 12,000 messages owed to the players arrived, and all 4,000 answers were accepted. No errors of any code.
- **Node server, 400 players (run 1, quiet machine).** Broadcast latency (the message's `ts` to k6 reading it off the socket) was 8-15 ms at the median and at most 55 ms for any of the 12,000 broadcasts. Every question reached every phone at least 708 ms before its options opened, against the 750 ms minimum lead. The server used 4.3% of one core on average (32% at its busiest second) and 156 MB; k6 with its 401 JavaScript runtimes used 6.5% on average and 424 MB.
- **Lambda code path (emulator, run 2, quiet machine).** Median broadcast latency 19-75 ms, at most 460 ms, and every question arrived at least 992 ms before its options opened, against the 1,500 ms lead. Answers were acknowledged in 10 ms at the median and 131 ms at worst when players answered over several seconds, as people do.
- **When all 400 answer at once, the emulator's acknowledgements take about 1.5 s at the median** (Node: 25 ms). That is an emulator property, explained below with evidence: it runs every invocation on one event loop and that loop is saturated while the burst drains. It says little about AWS.
- **A rerun after the review fixes (run 6) met the same gates with the same counts, on a much busier machine.** With 67-76% of all cores in use by other work, median broadcast latency was 10-111 ms on Node and 29-121 ms on the emulator, and the worst question margin fell to 649 ms on Node (lead 750 ms) and 633 ms on the emulator (lead 1,500 ms): thinner, still positive.
- **Idle-machine verification by the lead (see the next section) matches:** every gate met on both targets, with Node broadcasts at 7-9 ms median and every question arriving at least 715 ms before its options opened.
- **Nothing missed its target.** What the runs cannot say (network latency, AWS itself, and more) is listed under [What these numbers do not cover](#what-these-numbers-do-not-cover).

## Lead verification runs (idle machine)

Taken by the lead after every build task had merged, with no other agents running: the machine averaged 4.8% of all cores during the Node run and 13.9% during the emulator run, most of the latter being the emulator and DynamoDB Local themselves. These are the figures to quote.

- **Node server:** every gate met.
  - Broadcast latency p50 7-9 ms for `question`/`reveal`/`leaderboard`, p99 at most 102 ms.
  - Every question reached every player at least 715 ms before its options opened (lead 750 ms). Answer acks p99 5.4 ms.
  - The server peaked at 24% of one core and 164 MB.
- **Lambda handlers behind the emulator:** every gate met.
  - Broadcast p50 about 20 ms and p99 at most 117 ms; the slowest single `question` delivery took 429 ms. Every question still reached every player at least 867 ms before its options opened (lead 1,500 ms), so fan-out never cut into answer time.
  - `close-reveal` about 1.1 s is the designed 1,000 ms settle wait on the Lambda path (ADR-0006), not processing time.
  - One answer ack of 4,000 is missing from the ack trend (n = 3,999) because that player's socket dropped before the ack arrived; the reveal settled it (`you.answered`), so it counts as accepted and delivered, as in run 6.

#### 20260929T100934Z-node

| Item                                                      | Value                                                                                               |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Finished                                                  | 2026-09-29T10:12:45.886Z                                                                            |
| Commit                                                    | `1b4a3a48c088`                                                                                      |
| Target                                                    | node                                                                                                |
| Machine                                                   | 4 CPUs (Intel(R) Xeon(R) Processor @ 2.10GHz), 16 GB RAM, Linux 6.18.44-fc-v37, node v22.22.2       |
| Load average (1, 5, 15 min, running/total) before / after | 0.82 1.47 1.96 1/274 / 0.76 1.00 1.67 1/277                                                         |
| Machine CPU during the run (all 4 cores)                  | 4.8% average, 41.6% peak; load average peaked at 0.83                                               |
| Players / questions / reconnect ratio                     | 400 / 10 / 0.1 (40 players)                                                                         |
| Answer think time                                         | median 3 s, sigma 0.5, limit 20 s                                                                   |
| Duration                                                  | 189 s (room full after 19919 ms)                                                                    |
| Join success                                              | 100% (400 of 400)                                                                                   |
| Resume success                                            | 100% (40 of 40 attempts)                                                                            |
| Delivery (received / expected)                            | 100% (12,000 of 12,000; lost 0, missed while disconnected 0, duplicates 0, received via snapshot 0) |
| Answers accepted                                          | 100% (4,000 of 4,000)                                                                               |
| Errors by code                                            | none                                                                                                |
| Gates                                                     | zq_join_success met; zq_answer_accepted met; zq_msg_received / zq_msg_expected met                  |

| Latency (ms)                    |     n |    p50 |    p95 |    p99 |    max |
| ------------------------------- | ----: | -----: | -----: | -----: | -----: |
| broadcast `question`            | 4,000 |    9.3 |  21.58 |  26.58 |  29.32 |
| broadcast `reveal`              | 4,000 |   8.71 |  22.22 |   34.6 |  38.08 |
| broadcast `leaderboard`         | 3,600 |   6.66 |  80.81 | 102.27 | 107.14 |
| broadcast `ended`               |   400 |  59.19 | 113.69 | 117.62 | 119.18 |
| answer ack                      | 4,000 |   1.36 |   2.28 |   5.42 |  40.62 |
| question margin before `openAt` | 4,000 | 731.97 | 743.72 |  745.6 |    747 |
| host `open-first`               |     1 |   9.07 |   9.07 |   9.07 |   9.07 |
| host `open-next`                |     9 |    5.2 |   6.45 |   6.75 |   6.83 |
| host `close-reveal`             |    10 |   9.69 |  12.37 |  12.49 |  12.52 |
| host `reveal-leaderboard`       |     9 |   8.19 |  29.63 |  33.42 |  34.37 |
| host `end`                      |     1 |    6.6 |    6.6 |    6.6 |    6.6 |

| Process | peak CPU % | peak CPU % after 5 s | p95 CPU % | avg CPU % | peak RSS MB | peak fds |
| ------- | ---------: | -------------------: | --------: | --------: | ----------: | -------: |
| server  |         24 |                   19 |        12 |       4.6 |         164 |      824 |
| k6      |      134.7 |                 79.8 |        15 |       7.5 |       472.9 |      810 |

#### 20260929T101253Z-lambda-emulator

| Item                                                      | Value                                                                                               |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Finished                                                  | 2026-09-29T10:16:25.053Z                                                                            |
| Commit                                                    | `1b4a3a48c088`                                                                                      |
| Target                                                    | lambda-emulator                                                                                     |
| Machine                                                   | 4 CPUs (Intel(R) Xeon(R) Processor @ 2.10GHz), 16 GB RAM, Linux 6.18.44-fc-v37, node v22.22.2       |
| Load average (1, 5, 15 min, running/total) before / after | 1.10 1.07 1.69 1/268 / 0.52 0.90 1.50 2/300                                                         |
| Machine CPU during the run (all 4 cores)                  | 13.9% average, 65% peak; load average peaked at 1.55                                                |
| Players / questions / reconnect ratio                     | 400 / 10 / 0.1 (40 players)                                                                         |
| Answer think time                                         | median 3 s, sigma 0.5, limit 20 s                                                                   |
| Duration                                                  | 207.4 s (room full after 20088 ms)                                                                  |
| Join success                                              | 100% (400 of 400)                                                                                   |
| Resume success                                            | 100% (40 of 40 attempts)                                                                            |
| Delivery (received / expected)                            | 100% (12,000 of 12,000; lost 0, missed while disconnected 0, duplicates 0, received via snapshot 0) |
| Answers accepted                                          | 100% (4,000 of 4,000)                                                                               |
| Errors by code                                            | none                                                                                                |
| Gates                                                     | zq_join_success met; zq_answer_accepted met; zq_msg_received / zq_msg_expected met                  |

| Latency (ms)                    |     n |     p50 |     p95 |     p99 |     max |
| ------------------------------- | ----: | ------: | ------: | ------: | ------: |
| broadcast `question`            | 4,000 |   20.98 |   56.38 |  117.46 |   428.8 |
| broadcast `reveal`              | 4,000 |      20 |   39.63 |    48.4 |   56.37 |
| broadcast `leaderboard`         | 3,600 |   20.71 |   42.03 |      61 |   91.78 |
| broadcast `ended`               |   400 |   93.91 |  172.32 |  261.04 |  266.75 |
| answer ack                      | 3,999 |   11.82 |    40.3 |   78.88 |     185 |
| question margin before `openAt` | 4,000 | 1291.28 | 1461.28 | 1468.59 | 1472.02 |
| host `open-first`               |     1 |   44.39 |   44.39 |   44.39 |   44.39 |
| host `open-next`                |     9 |   47.33 |   57.65 |   59.32 |   59.74 |
| host `close-reveal`             |    10 | 1098.63 | 1109.21 | 1110.96 |  1111.4 |
| host `reveal-leaderboard`       |     9 |   49.63 |   56.44 |   57.48 |   57.73 |
| host `end`                      |     1 |   66.75 |   66.75 |   66.75 |   66.75 |

| Process        | peak CPU % | peak CPU % after 5 s | p95 CPU % | avg CPU % | peak RSS MB | peak fds |
| -------------- | ---------: | -------------------: | --------: | --------: | ----------: | -------: |
| server         |      116.3 |                116.3 |      66.1 |      25.2 |       274.4 |      946 |
| k6             |      162.7 |                 51.9 |        13 |       7.4 |       416.3 |      810 |
| dynamodb-local |       91.1 |                 91.1 |        41 |      13.7 |       654.5 |      219 |

## How the runs were taken

- **Machine.** 4 CPUs (Intel Xeon @ 2.10 GHz), 16 GB RAM, Linux 6.18, Node 22.22, k6 1.8.1. One machine runs k6, the server and, for the emulator, DynamoDB Local.
- **Commit.** Runs 1 to 5 were taken at `f7754c854ada`; run 6 at `ea23e287deb3`, after the review fixes. Commits in between add the profiling hook (`ZQ_SERVER_NODE_ARGS`) and tools and do not change what a default run does. The fixes after run 5 change what a player does only in cases that did not occur in these runs (none of them had an error of any code), and run 6 shows the default run unchanged.
- **A field removed from runs 1 to 5.** Their JSON files were written with k6's `setup_data.token`, the host's bearer token (a local JWT, signed with the runner's loopback-only secret). That one field was deleted from each file after the review; nothing else in them was touched. Files written from now on never contain it (README, "Run it locally").
- **Contention.** Other work shared this machine while these runs were taken. Every table gives the load average before and after, and the machine's CPU use during the run as the sampler measured it. The Node run started with a 1-minute load average of 2.61, left over from earlier work, but the machine averaged 14.5% CPU during the run itself; the emulator run started at 0.60 and averaged 17.4%. The machine-wide peaks of 86% and 94% in the tables are short spikes: the first second of the Node run (k6 building 401 runtimes) and a few seconds in each run in which the server, k6 and DynamoDB Local together used under 15% of a core, so the rest was other work (second 146 of the emulator run, for example). Earlier Node runs of the same test at 47-51% average machine load (not kept) had the same outcome with `question` p99 of 50 and 112 ms instead of 33 ms: latency here follows how busy the machine is, and a quiet-machine rerun will differ from these figures.
- **Reproduce.** `load/run-local.sh node` and `load/run-local.sh lambda-emulator`; the other three runs set environment variables, listed at the head of each.

## Runs

The tables are printed by `node load/tools/results-table.js load/results/<file>.json`; the raw numbers are in the JSON files next to them.

### 1. Node server, default load (required run)

`load/run-local.sh node`

#### 20260929T083136Z-node

| Item                                                      | Value                                                                                               |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Finished                                                  | 2026-09-29T08:34:48.552Z                                                                            |
| Commit                                                    | `f7754c854ada`                                                                                      |
| Target                                                    | node                                                                                                |
| Machine                                                   | 4 CPUs (Intel(R) Xeon(R) Processor @ 2.10GHz), 16 GB RAM, Linux 6.18.44-fc-v37, node v22.22.2       |
| Load average (1, 5, 15 min, running/total) before / after | 2.61 3.32 3.33 7/305 / 0.56 2.17 2.89 1/293                                                         |
| Machine CPU during the run (all 4 cores)                  | 14.5% average, 85.6% peak; load average peaked at 2.72                                              |
| Players / questions / reconnect ratio                     | 400 / 10 / 0.1 (40 players)                                                                         |
| Answer think time                                         | median 3 s, sigma 0.5, limit 20 s                                                                   |
| Duration                                                  | 189 s (room full after 20083 ms)                                                                    |
| Join success                                              | 100% (400 of 400)                                                                                   |
| Resume success                                            | 100% (40 of 40 attempts)                                                                            |
| Delivery (received / expected)                            | 100% (12,000 of 12,000; lost 0, missed while disconnected 0, duplicates 0, received via snapshot 0) |
| Answers accepted                                          | 100% (4,000 of 4,000)                                                                               |
| Errors by code                                            | none                                                                                                |
| Gates                                                     | zq_join_success met; zq_answer_accepted met; zq_msg_received / zq_msg_expected met                  |

| Latency (ms)                    |     n |    p50 |    p95 |    p99 |    max |
| ------------------------------- | ----: | -----: | -----: | -----: | -----: |
| broadcast `question`            | 4,000 |   9.64 |  22.92 |   32.7 |  37.94 |
| broadcast `reveal`              | 4,000 |   9.17 |  26.31 |     45 |  54.66 |
| broadcast `leaderboard`         | 3,600 |   8.08 |  21.29 |  31.39 |  39.66 |
| broadcast `ended`               |   400 |  14.88 |  25.76 |  25.89 |  26.85 |
| answer ack                      | 4,000 |   1.25 |   2.16 |   5.23 |  32.33 |
| question margin before `openAt` | 4,000 | 731.47 | 743.47 | 745.58 | 746.97 |
| host `open-first`               |     1 |   8.31 |   8.31 |   8.31 |   8.31 |
| host `open-next`                |     9 |   5.31 |  19.64 |  26.86 |  28.66 |
| host `close-reveal`             |    10 |   9.24 |  31.67 |  39.73 |  41.74 |
| host `reveal-leaderboard`       |     9 |   7.33 |  19.16 |  22.44 |  23.26 |
| host `end`                      |     1 |  12.89 |  12.89 |  12.89 |  12.89 |

| Process | peak CPU % | peak CPU % after 5 s | p95 CPU % | avg CPU % | peak RSS MB | peak fds |
| ------- | ---------: | -------------------: | --------: | --------: | ----------: | -------: |
| server  |       31.9 |                 31.9 |        12 |       4.3 |       155.5 |      825 |
| k6      |      137.7 |                 42.9 |        13 |       6.5 |       423.8 |      810 |

### 2. Lambda handlers behind the emulator, default load

`load/run-local.sh lambda-emulator`. The emulator runs the built handlers with the real AWS SDK clients, the real `ApiGatewayTransport` and `DynamoStore` against DynamoDB Local; `revealSettleMs` is 1,000 and the minimum lead 1,500 ms, as on Lambda.

#### 20260929T083449Z-lambda-emulator

| Item                                                      | Value                                                                                               |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Finished                                                  | 2026-09-29T08:38:20.587Z                                                                            |
| Commit                                                    | `f7754c854ada`                                                                                      |
| Target                                                    | lambda-emulator                                                                                     |
| Machine                                                   | 4 CPUs (Intel(R) Xeon(R) Processor @ 2.10GHz), 16 GB RAM, Linux 6.18.44-fc-v37, node v22.22.2       |
| Load average (1, 5, 15 min, running/total) before / after | 0.60 2.15 2.88 1/288 / 1.39 1.66 2.53 3/304                                                         |
| Machine CPU during the run (all 4 cores)                  | 17.4% average, 93.5% peak; load average peaked at 1.51                                              |
| Players / questions / reconnect ratio                     | 400 / 10 / 0.1 (40 players)                                                                         |
| Answer think time                                         | median 3 s, sigma 0.5, limit 20 s                                                                   |
| Duration                                                  | 206.9 s (room full after 20075 ms)                                                                  |
| Join success                                              | 100% (400 of 400)                                                                                   |
| Resume success                                            | 100% (40 of 40 attempts)                                                                            |
| Delivery (received / expected)                            | 100% (12,000 of 12,000; lost 0, missed while disconnected 0, duplicates 0, received via snapshot 0) |
| Answers accepted                                          | 100% (4,000 of 4,000)                                                                               |
| Errors by code                                            | none                                                                                                |
| Gates                                                     | zq_join_success met; zq_answer_accepted met; zq_msg_received / zq_msg_expected met                  |

| Latency (ms)                    |     n |     p50 |     p95 |     p99 |     max |
| ------------------------------- | ----: | ------: | ------: | ------: | ------: |
| broadcast `question`            | 4,000 |   20.03 |   43.08 |   72.35 |  460.41 |
| broadcast `reveal`              | 4,000 |   19.27 |   36.47 |   44.75 |   66.72 |
| broadcast `leaderboard`         | 3,600 |   18.52 |   34.31 |    41.4 |   54.17 |
| broadcast `ended`               |   400 |   75.32 |  141.73 |  151.86 |   155.6 |
| answer ack                      | 4,000 |    10.5 |   26.98 |   55.28 |  131.27 |
| question margin before `openAt` | 4,000 | 1311.89 | 1463.68 | 1469.95 | 1473.54 |
| host `open-first`               |     1 |   49.76 |   49.76 |   49.76 |   49.76 |
| host `open-next`                |     9 |   41.06 |   51.13 |   54.93 |   55.88 |
| host `close-reveal`             |    10 | 1088.67 | 1105.43 | 1111.95 | 1113.59 |
| host `reveal-leaderboard`       |     9 |   44.26 |      56 |   59.47 |   60.33 |
| host `end`                      |     1 |   64.11 |   64.11 |   64.11 |   64.11 |

| Process        | peak CPU % | peak CPU % after 5 s | p95 CPU % | avg CPU % | peak RSS MB | peak fds |
| -------------- | ---------: | -------------------: | --------: | --------: | ----------: | -------: |
| server         |      112.8 |                112.8 |      64.9 |      23.7 |       322.1 |      945 |
| k6             |      179.6 |                 46.9 |        13 |       7.1 |       415.8 |      810 |
| dynamodb-local |         75 |                   75 |        40 |      12.8 |       652.2 |      219 |

### 3. Reconnect windows across a reveal (accounting exercise)

`ZQ_RUN_LABEL=reconnect-window ZQ_PLAYERS=100 ZQ_QUESTIONS=6 ZQ_RECONNECT_RATIO=0.5 ZQ_DROP_DELAY_MIN_SEC=6 ZQ_DROP_DELAY_MAX_SEC=10 ZQ_RESUME_DELAY_MIN_SEC=2 ZQ_RESUME_DELAY_MAX_SEC=4 ZQ_JOIN_RAMP_SEC=5 load/run-local.sh node`

In the default run a dropped player is back 0.5-3 s after dropping, in the middle of a question that lasts ten seconds or more, so no phase change falls inside a window and nothing is "missed while disconnected". This run drops half the players late in a question and keeps them away for 2-4 s so that reveals and leaderboards do fall inside windows.

#### 20260929T083822Z-node-reconnect-window

| Item                                                      | Value                                                                                               |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Finished                                                  | 2026-09-29T08:39:47.743Z                                                                            |
| Commit                                                    | `f7754c854ada`                                                                                      |
| Target                                                    | node                                                                                                |
| Machine                                                   | 4 CPUs (Intel(R) Xeon(R) Processor @ 2.10GHz), 16 GB RAM, Linux 6.18.44-fc-v37, node v22.22.2       |
| Load average (1, 5, 15 min, running/total) before / after | 1.51 1.68 2.53 1/299 / 0.99 1.44 2.37 1/304                                                         |
| Machine CPU during the run (all 4 cores)                  | 20.4% average, 85.1% peak; load average peaked at 1.51                                              |
| Players / questions / reconnect ratio                     | 100 / 6 / 0.5 (50 players)                                                                          |
| Answer think time                                         | median 3 s, sigma 0.5, limit 20 s                                                                   |
| Duration                                                  | 83.4 s (room full after 5020 ms)                                                                    |
| Join success                                              | 100% (100 of 100)                                                                                   |
| Resume success                                            | 100% (50 of 50 attempts)                                                                            |
| Delivery (received / expected)                            | 100% (1,788 of 1,788; lost 0, missed while disconnected 12, duplicates 0, received via snapshot 17) |
| Answers accepted                                          | 100% (600 of 600)                                                                                   |
| Errors by code                                            | none                                                                                                |
| Gates                                                     | zq_join_success met; zq_answer_accepted met; zq_msg_received / zq_msg_expected met                  |

| Latency (ms)                    |   n |    p50 |    p95 |    p99 |   max |
| ------------------------------- | --: | -----: | -----: | -----: | ----: |
| broadcast `question`            | 594 |   2.85 |   6.81 |   7.73 |  9.74 |
| broadcast `reveal`              | 587 |   2.46 |   8.29 |   9.53 |   9.9 |
| broadcast `leaderboard`         | 490 |    2.1 |  23.11 |  38.33 | 39.54 |
| broadcast `ended`               | 100 |   6.37 |  24.32 |  28.01 | 29.32 |
| answer ack                      | 600 |   1.55 |   2.28 |   5.12 | 20.57 |
| question margin before `openAt` | 594 | 743.45 | 747.71 | 748.22 |   749 |
| host `open-first`               |   1 |   6.41 |   6.41 |   6.41 |  6.41 |
| host `open-next`                |   5 |   2.81 |   3.03 |   3.07 |  3.08 |
| host `close-reveal`             |   6 |   5.07 |   9.39 |   9.65 |  9.71 |
| host `reveal-leaderboard`       |   5 |   4.12 |   7.66 |   8.27 |  8.42 |
| host `end`                      |   1 |      3 |      3 |      3 |     3 |

| Process | peak CPU % | peak CPU % after 5 s | p95 CPU % | avg CPU % | peak RSS MB | peak fds |
| ------- | ---------: | -------------------: | --------: | --------: | ----------: | -------: |
| server  |         25 |                    7 |         7 |       2.6 |       140.7 |      224 |
| k6      |         37 |                   13 |        11 |       3.6 |         133 |      210 |

### 4. Simultaneous answers on Node (burst)

`ZQ_RUN_LABEL=burst ZQ_QUESTIONS=3 ZQ_ANSWER_MEDIAN_SEC=0.4 ZQ_ANSWER_SIGMA=0 load/run-local.sh node`

Every player answers exactly 0.4 s after the options open: 400 answers within a few milliseconds, the worst case for the acknowledgement path.

#### 20260929T083949Z-node-burst

| Item                                                      | Value                                                                                              |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Finished                                                  | 2026-09-29T08:40:25.749Z                                                                           |
| Commit                                                    | `f7754c854ada`                                                                                     |
| Target                                                    | node                                                                                               |
| Machine                                                   | 4 CPUs (Intel(R) Xeon(R) Processor @ 2.10GHz), 16 GB RAM, Linux 6.18.44-fc-v37, node v22.22.2      |
| Load average (1, 5, 15 min, running/total) before / after | 0.99 1.44 2.37 1/298 / 0.62 1.30 2.28 1/302                                                        |
| Machine CPU during the run (all 4 cores)                  | 11.6% average, 46% peak; load average peaked at 0.99                                               |
| Players / questions / reconnect ratio                     | 400 / 3 / 0.1 (40 players)                                                                         |
| Answer think time                                         | median 0.4 s, sigma 0, limit 20 s                                                                  |
| Duration                                                  | 34.4 s (room full after 19888 ms)                                                                  |
| Join success                                              | 100% (400 of 400)                                                                                  |
| Resume success                                            | 100% (40 of 40 attempts)                                                                           |
| Delivery (received / expected)                            | 100% (3,997 of 3,997; lost 0, missed while disconnected 3, duplicates 0, received via snapshot 11) |
| Answers accepted                                          | 100% (1,200 of 1,200)                                                                              |
| Errors by code                                            | none                                                                                               |
| Gates                                                     | zq_join_success met; zq_answer_accepted met; zq_msg_received / zq_msg_expected met                 |

| Latency (ms)                    |     n |    p50 |    p95 |    p99 |   max |
| ------------------------------- | ----: | -----: | -----: | -----: | ----: |
| broadcast `question`            | 1,200 |  11.66 |   25.3 |  27.19 | 29.31 |
| broadcast `reveal`              | 1,189 |   6.04 |  16.95 |  18.58 | 19.24 |
| broadcast `leaderboard`         | 1,197 |   8.24 |  21.02 |  26.22 | 27.35 |
| broadcast `ended`               |   400 |  16.54 |  21.54 |  23.77 | 23.83 |
| answer ack                      | 1,200 |  24.92 |  64.84 |   71.7 | 75.73 |
| question margin before `openAt` | 1,200 | 729.75 | 743.77 | 745.64 | 746.9 |
| host `open-first`               |     1 |   7.03 |   7.03 |   7.03 |  7.03 |
| host `open-next`                |     2 |   4.74 |   4.78 |   4.79 |  4.79 |
| host `close-reveal`             |     3 |   9.06 |  22.62 |  23.82 | 24.12 |
| host `reveal-leaderboard`       |     3 |   7.21 |   8.23 |   8.32 |  8.34 |
| host `end`                      |     1 |   8.04 |   8.04 |   8.04 |  8.04 |

| Process | peak CPU % | peak CPU % after 5 s | p95 CPU % | avg CPU % | peak RSS MB | peak fds |
| ------- | ---------: | -------------------: | --------: | --------: | ----------: | -------: |
| server  |       27.9 |                 27.9 |      20.9 |       9.1 |       141.1 |      824 |
| k6      |      143.3 |                 55.9 |      55.9 |      15.8 |       406.7 |      810 |

### 5. Simultaneous answers on the emulator (burst)

The same command with `lambda-emulator`.

#### 20260929T084027Z-lambda-emulator-burst

| Item                                                      | Value                                                                                             |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Finished                                                  | 2026-09-29T08:41:13.673Z                                                                          |
| Commit                                                    | `f7754c854ada`                                                                                    |
| Target                                                    | lambda-emulator                                                                                   |
| Machine                                                   | 4 CPUs (Intel(R) Xeon(R) Processor @ 2.10GHz), 16 GB RAM, Linux 6.18.44-fc-v37, node v22.22.2     |
| Load average (1, 5, 15 min, running/total) before / after | 0.65 1.29 2.28 1/293 / 1.34 1.38 2.26 5/329                                                       |
| Machine CPU during the run (all 4 cores)                  | 32% average, 87.8% peak; load average peaked at 1.34                                              |
| Players / questions / reconnect ratio                     | 400 / 3 / 0.1 (40 players)                                                                        |
| Answer think time                                         | median 0.4 s, sigma 0, limit 20 s                                                                 |
| Duration                                                  | 43.3 s (room full after 19933 ms)                                                                 |
| Join success                                              | 100% (400 of 400)                                                                                 |
| Resume success                                            | 100% (40 of 40 attempts)                                                                          |
| Delivery (received / expected)                            | 100% (4,000 of 4,000; lost 0, missed while disconnected 0, duplicates 0, received via snapshot 0) |
| Answers accepted                                          | 100% (1,200 of 1,200)                                                                             |
| Errors by code                                            | none                                                                                              |
| Gates                                                     | zq_join_success met; zq_answer_accepted met; zq_msg_received / zq_msg_expected met                |

| Latency (ms)                    |     n |     p50 |     p95 |     p99 |     max |
| ------------------------------- | ----: | ------: | ------: | ------: | ------: |
| broadcast `question`            | 1,200 |   17.99 |   36.37 |  411.57 |  425.86 |
| broadcast `reveal`              | 1,200 |   19.47 |   35.33 |   40.86 |   46.22 |
| broadcast `leaderboard`         | 1,200 |   19.31 |   34.89 |   39.59 |      43 |
| broadcast `ended`               |   400 |   97.91 |  274.63 |  308.76 |   310.5 |
| answer ack                      | 1,184 | 1496.93 | 1832.52 | 1838.91 | 1851.31 |
| question margin before `openAt` | 1,200 | 1305.35 | 1464.17 | 1467.68 |    1479 |
| host `open-first`               |     1 |   57.56 |   57.56 |   57.56 |   57.56 |
| host `open-next`                |     2 |   39.94 |   40.61 |   40.67 |   40.69 |
| host `close-reveal`             |     3 | 1102.12 | 1110.09 |  1110.8 | 1110.98 |
| host `reveal-leaderboard`       |     3 |   43.28 |    48.9 |    49.4 |   49.53 |
| host `end`                      |     1 |   45.87 |   45.87 |   45.87 |   45.87 |

| Process        | peak CPU % | peak CPU % after 5 s | p95 CPU % | avg CPU % | peak RSS MB | peak fds |
| -------------- | ---------: | -------------------: | --------: | --------: | ----------: | -------: |
| server         |      119.8 |                119.8 |     111.9 |      54.7 |         350 |      985 |
| k6             |      129.9 |                   38 |        36 |      12.6 |       353.1 |      810 |
| dynamodb-local |       74.3 |                 74.3 |      65.9 |      30.6 |       652.2 |      224 |

### 6. Rerun after the review fixes (default load, both targets)

`load/run-local.sh node` and `load/run-local.sh lambda-emulator`, at `ea23e287deb3`, the commit that fixes the review findings: the host token no longer reaches the results file, a player that resumes into an ended game finishes at once, and an answer that never got an outcome counts as not accepted (README, "Answer accounting"). Every gate and every count is the same as in runs 1 and 2: 400 of 400 joined, 40 of 40 resumed, 12,000 of 12,000 messages delivered, 4,000 of 4,000 answers accepted, no errors.

The latencies are higher than in runs 1 and 2 because the machine was much busier: other work kept it at 67% (Node run) and 76% (emulator run) of all four cores on average, against 14.5% and 17.4% then. The Node server itself used the same 4.5% of a core on average as in run 1, so the difference is contention with that other work, which the sampler cannot separate from the server's own time. The margin before `openAt` stayed positive for all 8,000 deliveries but was thinner: the worst `question` arrived 649 ms before the options opened on Node (lead 750 ms; 708 ms in run 1) and 633 ms before on the emulator (lead 1,500 ms; 992 ms in run 2), where the slowest `question` broadcast took 693 ms. On a busy machine the emulator's fan-out therefore used up to 58% of the lead in the worst case, against about a third in run 2, which is one more reason the lead needs the run against AWS. Read runs 1 and 2 for the figures of a quiet machine and this run as a check that the fixed code behaves the same, with the same gates met, under load.

#### 20260929T091334Z-node

| Item                                                      | Value                                                                                               |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Finished                                                  | 2026-09-29T09:16:48.435Z                                                                            |
| Commit                                                    | `ea23e287deb3`                                                                                      |
| Target                                                    | node                                                                                                |
| Machine                                                   | 4 CPUs (Intel(R) Xeon(R) Processor @ 2.10GHz), 16 GB RAM, Linux 6.18.44-fc-v37, node v22.22.2       |
| Load average (1, 5, 15 min, running/total) before / after | 11.55 7.29 5.12 12/664 / 6.18 6.72 5.31 8/607                                                       |
| Machine CPU during the run (all 4 cores)                  | 67.1% average, 98.5% peak; load average peaked at 12.23                                             |
| Players / questions / reconnect ratio                     | 400 / 10 / 0.1 (40 players)                                                                         |
| Answer think time                                         | median 3 s, sigma 0.5, limit 20 s                                                                   |
| Duration                                                  | 189.8 s (room full after 19961 ms)                                                                  |
| Join success                                              | 100% (400 of 400)                                                                                   |
| Resume success                                            | 100% (40 of 40 attempts)                                                                            |
| Delivery (received / expected)                            | 100% (12,000 of 12,000; lost 0, missed while disconnected 0, duplicates 0, received via snapshot 0) |
| Answers accepted                                          | 100% (4,000 of 4,000)                                                                               |
| Errors by code                                            | none                                                                                                |
| Gates                                                     | zq_join_success met; zq_answer_accepted met; zq_msg_received / zq_msg_expected met                  |

| Latency (ms)                    |     n |    p50 |    p95 |    p99 |    max |
| ------------------------------- | ----: | -----: | -----: | -----: | -----: |
| broadcast `question`            | 4,000 |  14.52 |   49.4 |  66.28 |  83.79 |
| broadcast `reveal`              | 4,000 |  13.76 |  36.52 |  42.57 |  55.36 |
| broadcast `leaderboard`         | 3,600 |   9.78 |  36.48 |  56.91 |  67.83 |
| broadcast `ended`               |   400 | 110.54 | 138.08 | 139.28 | 139.33 |
| answer ack                      | 3,999 |   1.37 |   3.51 |   6.77 |  17.66 |
| question margin before `openAt` | 4,000 | 716.68 | 740.63 | 744.15 |    747 |
| host `open-first`               |     1 |   7.37 |   7.37 |   7.37 |   7.37 |
| host `open-next`                |     9 |  11.68 |  40.97 |  50.51 |  52.89 |
| host `close-reveal`             |    10 |     14 |   35.2 |  41.07 |  42.54 |
| host `reveal-leaderboard`       |     9 |  10.36 |  18.61 |  20.88 |  21.45 |
| host `end`                      |     1 |  18.82 |  18.82 |  18.82 |  18.82 |

| Process | peak CPU % | peak CPU % after 5 s | p95 CPU % | avg CPU % | peak RSS MB | peak fds |
| ------- | ---------: | -------------------: | --------: | --------: | ----------: | -------: |
| server  |         27 |                   26 |        12 |       4.5 |       154.2 |      825 |
| k6      |      133.6 |                 51.9 |        13 |       6.7 |       425.7 |      810 |

#### 20260929T091658Z-lambda-emulator

| Item                                                      | Value                                                                                               |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Finished                                                  | 2026-09-29T09:20:32.805Z                                                                            |
| Commit                                                    | `ea23e287deb3`                                                                                      |
| Target                                                    | lambda-emulator                                                                                     |
| Machine                                                   | 4 CPUs (Intel(R) Xeon(R) Processor @ 2.10GHz), 16 GB RAM, Linux 6.18.44-fc-v37, node v22.22.2       |
| Load average (1, 5, 15 min, running/total) before / after | 5.93 6.63 5.30 16/505 / 8.43 7.52 5.93 8/457                                                        |
| Machine CPU during the run (all 4 cores)                  | 75.7% average, 99% peak; load average peaked at 9.03                                                |
| Players / questions / reconnect ratio                     | 400 / 10 / 0.1 (40 players)                                                                         |
| Answer think time                                         | median 3 s, sigma 0.5, limit 20 s                                                                   |
| Duration                                                  | 208.6 s (room full after 20429 ms)                                                                  |
| Join success                                              | 100% (400 of 400)                                                                                   |
| Resume success                                            | 100% (40 of 40 attempts)                                                                            |
| Delivery (received / expected)                            | 100% (12,000 of 12,000; lost 0, missed while disconnected 0, duplicates 0, received via snapshot 0) |
| Answers accepted                                          | 100% (4,000 of 4,000)                                                                               |
| Errors by code                                            | none                                                                                                |
| Gates                                                     | zq_join_success met; zq_answer_accepted met; zq_msg_received / zq_msg_expected met                  |

| Latency (ms)                    |     n |     p50 |     p95 |     p99 |     max |
| ------------------------------- | ----: | ------: | ------: | ------: | ------: |
| broadcast `question`            | 4,000 |   31.29 |   94.85 |  155.16 |  692.89 |
| broadcast `reveal`              | 4,000 |   29.67 |   64.97 |   89.63 |   107.6 |
| broadcast `leaderboard`         | 3,600 |   29.27 |   72.02 |  100.52 |  124.72 |
| broadcast `ended`               |   400 |   121.2 |  327.21 |  344.42 |  352.74 |
| answer ack                      | 4,000 |   24.79 |  242.04 |  337.02 |     525 |
| question margin before `openAt` | 4,000 | 1207.16 |  1444.5 | 1458.18 | 1466.99 |
| host `open-first`               |     1 |   82.24 |   82.24 |   82.24 |   82.24 |
| host `open-next`                |     9 |   63.57 |  101.45 |  106.93 |  108.31 |
| host `close-reveal`             |    10 | 1120.11 | 1154.47 | 1160.91 | 1162.52 |
| host `reveal-leaderboard`       |     9 |   65.85 |   93.08 |   97.12 |   98.14 |
| host `end`                      |     1 |  100.89 |  100.89 |  100.89 |  100.89 |

| Process        | peak CPU % | peak CPU % after 5 s | p95 CPU % | avg CPU % | peak RSS MB | peak fds |
| -------------- | ---------: | -------------------: | --------: | --------: | ----------: | -------: |
| server         |      107.9 |                107.9 |      64.8 |        25 |       300.2 |      962 |
| k6             |      119.9 |                 55.9 |        14 |       6.5 |       420.9 |      810 |
| dynamodb-local |       83.1 |                 83.1 |      42.9 |      12.7 |       652.2 |      227 |

## What the numbers say

### Delivery and the lead before options open

Nothing was lost on either target. The number that matters for [ADR-0005](../docs/adr/0005-timing-fairness-scoring.md) is `zq_question_margin_ms`, how long before `openAt` (on the player's clock, by the offset rule) each question arrived. Its minimum over 4,000 deliveries was 708 ms on Node (lead 750 ms) and 992 ms on the emulator (lead 1,500 ms). The lead is not consumed by fan-out at 400 players on either path. On the emulator the slowest single broadcast was a `question` at 460 ms, about a third of the lead; it is one outlier among 4,000 (p99 72 ms).

`host close-reveal` is 9 ms at the median on Node and 1,089 ms on the emulator. The difference is the 1,000 ms `revealSettleMs` that the Lambda configuration waits before revealing (ADR-0006), plus about 90 ms of work.

`ended` is the slowest broadcast on both targets (15 ms and 75 ms at the median). It arrives as all 400 players finish at once, each settling its ledger and closing its socket in k6 while the server sends the 400 per-player messages, so much of the delay is probably k6's own CPU, though I did not separate it. The server's busiest second of the whole Node run (32% of a core) is the moment right after, when the 400 sockets close.

### Delivery accounting around reconnects

The rules are in [README.md](README.md#metrics) and are unit-tested case by case in `load/test/ledger.test.js`. What the runs show:

- In the default runs all 40 drops resumed inside a question, so nothing fell in a window and nothing was counted from a snapshot (`received via snapshot 0`).
- The reconnect-window run exercises the paths that matter. 50 of 100 players dropped and resumed (50 of 50). **12 messages fell inside disconnect windows** (6 reveals and 6 leaderboards) and are reported as `zq_msg_missed_while_disconnected`, not as losses. **17 deliveries were counted from `welcome` snapshots** (the phase the snapshot reports). **Lost: 0.** Delivery is 1,788 of 1,788 owed: the 1,800 messages the 100 players are owed in this quiz, less the 12 in windows. The 12 are the only gap between 1,800 and 1,788, so a loss would show as a shortfall of `zq_msg_received` against `zq_msg_expected`, and there is none.
- The Node burst run has 3 messages in windows and 11 from snapshots, also with no loss.
- An answer sent just before a drop gets its acknowledgement on a socket that is gone. Such answers are settled by the reveal's `you.answered`, or by a resume snapshot that already lists the answer (in the emulator burst run, 16 of 1,200). Every answer sent is therefore one `zq_answer_accepted` observation, and `zq_answer_ack_ms` has 1,184 samples for the 1,200 answers there. No answer went unresolved. (One that did would now count as not accepted; see "Answer accounting" in the README.)

### Acknowledgement latency when all 400 answer at once (emulator)

| Answers                 | Node                  | Emulator                               |
| ----------------------- | --------------------- | -------------------------------------- |
| spread over seconds     | p50 1.25 ms, p99 5.2  | p50 10.5 ms, p99 55                    |
| all 400 within a few ms | p50 24.9 ms, p99 71.7 | **p50 1,497 ms**, p99 1,839, max 1,851 |

The default load spreads answers as people do (median 3 s after the question opens, log-normal), so they reach the emulator over several seconds, it keeps up, and it acknowledges in tens of milliseconds. Only the burst run reproduces the seconds-long acknowledgements. It is the synchronised worst case, not the load a real quiz produces.

**Why it takes seconds, with evidence.** By the code, each answer costs the emulator four round trips inside one process: `getConnection`, `getSession` and `putResponse` against DynamoDB Local, then the acknowledgement through the management API. 400 simultaneous answers are 1,600 of them, queued behind each other on one Node event loop.

- The same burst on the Node target (same engine and service code, in-memory store, no SDK) acknowledges at 25 ms median. The engine and the protocol are not the cause.
- In the busiest second of each of the three bursts the emulator process peaked at 112%, 120% and 118% of a core (the sampler counts its main thread and helper threads), DynamoDB Local at 66%, 71% and 60%, and k6 at 4%, 11% and 8%, while the machine as a whole was 51%, 54% and 51% busy. The columns are `server_cpu_pct`, `dynamodb-local_cpu_pct`, `k6_cpu_pct` and `system_cpu_pct` of `results/20260929T084027Z-lambda-emulator-burst-resources.csv`, at seconds 23-24, 30-32 and 38-39.
- A `--cpu-prof` profile of the emulator during the same burst (`ZQ_SERVER_NODE_ARGS="--cpu-prof --cpu-prof-dir=..."`, read with `tools/analyze-cpuprofile.js`; a separate two-question run, acknowledgements at p50 1.66 s with the profiler's own overhead) shows the event loop 71-98% busy in the two seconds each burst lasts and 9% busy in the second after. Over the four seconds of the two bursts it spent its 3.3 s of busy time in the handler bundle (game code and the bundled AWS SDK, 48%), Node's HTTP, crypto and stream internals (27%), other native code (9%), garbage collection (7%) and socket writes (7%): about 4 ms of loop time per answer.

So the acknowledgement delay is the emulator's single execution environment working through the burst, on the request path to DynamoDB Local and the management API. DynamoDB Local sits on that path and is slower than DynamoDB (it was at up to 71% of a core in those seconds), so it is part of the cost, but the profile shows the emulator's own loop saturated rather than waiting for it, and I could not separate the two further without instrumenting the handlers. Neither is how AWS behaves: on Lambda each concurrent invocation runs in its own execution environment, and DynamoDB is built to answer calls like these in single-digit milliseconds. The [emulator's own README](../apps/server-lambda/README.md#what-it-does-not-emulate) says the same in one line. Nothing was tuned to hide it, and the number belongs to the emulator, not to the design.

## What these numbers do not cover

- **Network.** Everything is on `127.0.0.1`: no round-trip time, no TLS, no mobile network, no packet loss. Broadcast latency here is the server's send plus the kernel and k6's read, on a machine shared with k6. On real networks every latency gains the downlink time, which ADR-0005 accepts and does not compensate.
- **Not API Gateway.** The emulator is one process with one event loop: no cold starts, no per-invocation environments, no Lambda concurrency or timeout limits, no throttling (no 429 from `PostToConnection`), no account or connection-rate limits, no clock skew. ADR-0007 assumes 15-60 ms per `PostToConnection` call in a pool of 50, which spreads 400 sends over 120-480 ms; the emulator's management API is a local call in the same process, so this run does not test that assumption. So the 1,500 ms lead is shown to cover the emulator's fan-out here; whether it covers AWS's assumed 120-480 ms spread needs the run against AWS.
- **Not DynamoDB.** DynamoDB Local is a single Java process on the same CPUs; the store's conditional writes, consistency and throttling on a real table are not exercised.
- **Well-behaved players.** Answers follow a log-normal think time, joins spread over 20 s, and a drop is a clean close (code 1000) followed by `resume`. There are no slow consumers (so the Node server's `bufferedAmount` skip at 256 KiB and terminate at 1 MiB were never reached), no half-open connections that only the 30 s ping sweep would find, and no players that never reconnect.
- **One session, three question types.** The quiz has single choice, true/false and poll questions. Word cloud, open-ended and rating questions, moderation, and their larger `host.state` payloads are not exercised. The host has one control connection and no presenter screen.
- **Peak CPU.** k6's 130-180% peak in the 400-player runs is its first second, building 401 runtimes; after that it peaks at 38-56% and averages 6-16% over each run. The Node server is idle for most of a run: 4.3% of a core on average, 12% at p95.
- **Delivery accounting.** `zq_msg_expected` leaves out messages that fell inside a closed disconnect window (they are counted separately), as the task defines. A player whose `resume` never succeeds would have everything after the drop counted as lost, so a failure to resume shows up in both `zq_resume_success` and the delivery rate; none occurred.

## Rerunning

A rerun on a quiet machine replaces the tables above: run `load/run-local.sh node` and `load/run-local.sh lambda-emulator`, then `node load/tools/results-table.js load/results/<new files>.json` and paste. Keep the `.csv` files, which show what else was using the machine.
