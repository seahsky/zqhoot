# P5-e2e: end-to-end game in real browsers against the real server

Owner: Sonnet implementation agent. Reviewer: independent Opus agent.

## Goal

Prove the product works end to end. Playwright (Chromium) drives a host who creates a quiz in the editor, a presenter screen, and 5 players on phone and desktop viewports through a full game to the podium, against the **Node server** (required). Also run it against the **Lambda code path via the local API Gateway emulator** from `apps/server-lambda`, as a second target, if that target starts successfully in this environment.

Read first:

- `docs/ARCHITECTURE.md`
- `apps/web/README.md`
- `apps/server-node/README.md`
- `apps/server-lambda/README.md` (emulator)
- `docs/adr/0016-visual-identity.md`

## Files you own

- `apps/web/e2e-live/**`, `apps/web/playwright.live.config.ts`
- a `test:e2e:live` script in `apps/web/package.json`
- `.gitignore` additions

## Setup

- `playwright.live.config.ts` with `webServer` per target, selected by `ZQ_E2E_TARGET`:
  - **`node`** (default): build `@zqhoot/web` (production, no gallery) and `@zqhoot/server-node`, then start `node apps/server-node/dist/server.mjs` with:
    - `ZQ_PORT=8181`, `ZQ_PUBLIC_URL=http://localhost:8181`
    - `ZQ_JWT_SECRET` = a 48-char test string
    - `ZQ_ADMIN_USER=e2e`, `ZQ_ADMIN_PASSWORD=e2e-password` (dev mode is acceptable in tests)
    - `ZQ_DATA_DIR` = a fresh temp dir

    Wait on `/api/health`.

  - **`lambda-emulator`:** build the server-lambda zips and web, then start the emulator with DynamoDB Local (`http://localhost:8000`) and a unique table name. Wait on the emulator's HTTP health.
- Browser contexts: one per actor, with its own viewport.
  - Host: 1366x768.
  - Presenter: 1920x1080.
  - Players: 320x568 (with touch and mobile UA), 390x844 (mobile), 768x1024, 1366x768 and 1920x1080.
- Use time limits of 10 s and the minimum read time so the test runs in about 2 minutes. Where waiting is needed, wait on UI state, not fixed sleeps.

## Scenario (one test, serial steps, with `test.step` names)

1. **Host setup.**
   - The host signs in with the local login form.
   - Creates a quiz in the editor UI (not the API) with:
     - Q1 single choice (4 options)
     - Q2 true/false
     - Q3 poll (3 options)
     - Q4 word cloud
     - Q5 single choice, double points
     - Q6 rating (1-5)
   - Saves, returns to the dashboard and starts a session. Reads the PIN from the live control screen, and opens the presenter URL in the presenter context.
2. **Players join.**
   - Each of the 5 players opens `/join?pin={pin}` (QR-equivalent URL) or types the PIN on `/join` (use both paths) and picks a nickname.
   - One player first tries a nickname that is already taken and sees the error.
   - The presenter lobby shows 5 names and the count.
3. **Game.** The host presses Next on the control screen for most steps. Use the presenter's keyboard (Space) at least once. For every question:
   - Before reveal, the presenter DOM contains no "Correct" badge or correct-answer marker.
   - Players answer by tapping options or buttons. Planned answers make the final ranking deterministic:
     - P1: all correct
     - P2: wrong on Q2
     - P3: wrong on Q1 and Q5
     - P4: skips Q1 entirely (no answer)
     - P5: all correct, but answers after P1 each time (still correct)
   - Word cloud: two players submit the same word with different case. The presenter shows it once, with count 2.
   - After reveal, each player sees correct/incorrect text matching the plan. The presenter shows the correct answer marker and counts matching the plan.
   - Leaderboard after scored questions shows ranks consistent with the plan.
   - One player (390x844) **reloads the page mid-question** (after Q2 opens and before answering). They must resume without re-joining (credentials from storage), see the open question, answer it, and keep their score.
   - The host **kicks** nobody in the main flow, so the ranking assertions stay simple.
4. **End.** After Q6 the presenter shows the podium. The top 3 names are, in order, P1, P5, then the next by plan; compute the expected order from the scoring rules in ADR-0005, allowing only the documented tie rules. Each player sees their final placing.
5. **Export.** From the dashboard, the host downloads the results CSV. Parse it:
   - It has a BOM and the expected header.
   - Rows cover 5 players × revealed questions (word cloud rows per entry).
   - `final_rank` matches the podium.
6. **Kick.** In a second, short test: a player joins, the host kicks them, and they see the removed message and cannot resume.

## Also

- Run axe (`@axe-core/playwright`, same tags as the gallery suite) on: the live presenter lobby, a live question and a live reveal on the presenter; the phone answering screen at 320x568; and the host control during a question. Zero violations.
- Save screenshots of key moments to `e2e-live/screenshots/{target}/` (gitignored): lobby, each question open, each reveal, leaderboard, podium, each player's final screen.
- The suite must pass 3 consecutive runs against `node` (report the run times) to show it isn't flaky.

## Acceptance criteria

1. `pnpm --filter @zqhoot/web test:e2e:live` passes against `node`, 3 runs in a row.
2. `ZQ_E2E_TARGET=lambda-emulator pnpm --filter @zqhoot/web test:e2e:live` passes, or the report states precisely why the emulator target couldn't run here, with the error.
3. The assertions are real: the reviewer will check that each planned outcome is asserted, not just that screens appear.
4. `pnpm exec prettier --check apps/web` passes.
5. Any product bug found is reported with a reproduction, and fixed only if it's in `apps/web`. Bugs in other packages are reported for the lead to route, not patched outside your ownership.
