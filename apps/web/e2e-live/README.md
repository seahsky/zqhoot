# Live end-to-end suite

Real Chromium contexts against a real server: a host who builds a quiz in the editor, a presenter screen and five players on five viewports play it to the podium. Nothing is scripted or mocked, unlike `e2e/`, which runs the screens against fixtures.

```sh
pnpm --filter @zqhoot/web test:e2e:live                                   # Node server (default)
ZQ_E2E_TARGET=lambda-emulator pnpm --filter @zqhoot/web test:e2e:live     # Lambda handlers
```

`ZQ_E2E_SKIP_BUILD=1` reuses the last builds of the web app and the server, for iterating on the specs.

## Targets

`playwright.live.config.ts` builds what it needs, starts the server as its `webServer` and waits on `/api/health`. `run-server.mjs` wraps the server so that every run gets a fresh data directory and removes it (and, for the emulator, its DynamoDB Local table) afterwards.

| Target            | Server                                                                        | Needs                                                  |
| ----------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------ |
| `node`            | `apps/server-node/dist/server.mjs` on port 8181, admin `e2e` / `e2e-password` | nothing                                                |
| `lambda-emulator` | `apps/server-lambda` emulator on 8281-8283, table `zqhoot-e2e-{time}`         | DynamoDB Local on `ZQ_DDB_ENDPOINT` (`localhost:8000`) |

The browser origin must be `localhost`: both servers accept a WebSocket only from the origin they were configured with.

## What runs

| Spec                   | What it proves                                                                                                                                                                                                                                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `game.spec.ts`         | One test in steps: sign in, build six questions in the editor, start a session, join five players (by link and by typing the PIN, one nickname refused as taken), play every question to a planned outcome, podium, results CSV. Also axe on the presenter lobby, question and reveal, on a 320x568 phone, and on the host control. |
| `kick.spec.ts`         | A kicked player sees the removal message, cannot resume after a reload, and the server refuses their old credentials too.                                                                                                                                                                                                           |
| `download-bom.spec.ts` | The results CSV keeps its byte order mark: on the file the dashboard saves (both targets), and as served by each target.                                                                                                                                                                                                            |
| `scoring.spec.ts`      | Pins the suite's own ADR-0005 formula and ranking rules to the ADR's numbers (no browser).                                                                                                                                                                                                                                          |

`plan.ts` is the single source of the quiz, of what each player does, and therefore of every expectation. P1 is right every time, P2 wrong on Q2, P3 wrong on Q1 and Q5, P4 skips Q1, P5 is right every time but answers after P1. P5 and P4 wait one and three seconds into each question (read off the phone's own countdown), which caps their points by construction: the order Alice, Eve, Bobby, Dara, Cleo follows from the plan and not from a race between clicks.

What the game test asserts, beyond "the screen appears":

- the quiz the editor saved, read back through the API (types, options, correct answers, limits, double points);
- before the reveal, no "correct" text or class anywhere in the presenter DOM, checked on every DOM mutation by a `MutationObserver`; option cards identical to each other; the same detector must find the marker after the reveal, or the check proves nothing;
- on each reveal: counts and percentages on the projector, the Correct badge on the right row only, the chart's hidden table, the tag cloud showing "Fun" and "FUN" as one word with two votes, the rating average;
- on every phone: the headline (correct, incorrect, no answer, response counted), the points gained, the running total and place, and the right answer for anyone who missed it;
- leaderboards against a ranking computed here from ADR-0005 (competition ranks, ties in nickname order) from the points each phone was told;
- P2 reloading mid-question resumes (`resume` sent, never `join`, the join page never visited) with its score;
- the results CSV: header, one row per player and question (word cloud: per entry), every `points` recomputed from `response_time_ms` with the ADR formula, the planned delays visible in the measured times, `final_rank` equal to the podium.

## When it fails

A failure attaches a screenshot of every page and the WebSocket frames each actor exchanged (`frames-{actor}.log`) under `test-results/`. Screenshots of key moments of every run are written to `e2e-live/screenshots/{target}/` (gitignored).

## Product bugs found

Fixed in `apps/web`, each with a test that fails without the fix:

- The CSV the dashboard saved had no UTF-8 byte order mark: `net/http.ts` reads the reply with `Response.text()`, which drops it. `saveTextFile` now writes the mark back (`textFileBlob` in `net/hostApi.ts`). Checked on the saved file's bytes in `game.spec.ts` (step 5) and `download-bom.spec.ts`, and by `test/host-api.test.ts`.
- The host header's "N players" chip read the snapshot's roster, which is empty in the lobby, and said "0 players" beside a roster of five; it also said "1 players". It now counts the live roster, singular and plural. Checked in the lobby step of `game.spec.ts` and by `test/host-summary.test.ts`.

Fixed outside `apps/web`:

- On the Lambda path the served CSV lost the mark before it reached the browser, because Hono's API Gateway adapter turns the body into a string with `Response.text()`. `apps/server-lambda/src/http.ts` now passes `handle()` an `isContentTypeBinary` that treats `text/csv` as binary, so the body travels as base64 with its bytes intact. Checked by `download-bom.spec.ts` on both targets and by `apps/server-lambda/test/http-handler.test.ts`.

## Deviations from the task spec

- The poll runs with a 60 s limit, not 10 s (`POLL_LIMIT_SEC` in `plan.ts`). Three accessibility scans run during it (a phone, the projector, the host), and a slow scan must not close the question under the players. It costs no time: the question ends as soon as all five have answered.

## Types

`pnpm --filter @zqhoot/web test:e2e:live` starts with `tsc -p e2e-live/tsconfig.json`, which checks this folder and the config, because `pnpm --filter @zqhoot/web typecheck` does not include them.
