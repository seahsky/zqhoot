# G1-engine-fixes: wave 1 gate findings in protocol and engine

Owner: Sonnet implementation agent. Reviewer: independent Opus agent. Source: the wave 1 phase-gate audit. Every finding below was confirmed by independent verifiers.

## Findings to fix

1. **Unbounded open-ended reveal payload (major).**
   - At 400 players with up to 3 × 200-character entries each, the open-ended `QuestionResult` in the player `reveal`, `host.state` and the stored RESULT item can exceed API Gateway's 128 KB WebSocket message limit (ADR-0004) and approach DynamoDB's 400 KB item limit.
   - PostToConnection then rejects the reveal, so players are left on "Time's up".
2. **Open-ended authorship leak (major).**
   - Player-bound open-ended results expose `responseId = {playerId}-{slot}`, and leaderboard/podium entries map `playerId` to nickname.
   - Anyone with devtools can therefore attribute anonymous open-ended answers.
3. **Zalgo in word-cloud and open-ended text (minor).**
   - `normalizeWord` / `normalizeOpenText` accept unlimited stacked combining marks.
   - Word-cloud entries go straight to the presenter.
4. **Resume during reveal loses the correct answer (minor).**
   - A player who resumes in phase `reveal` gets a `PlayerSnapshot.reveal` without the public question.
   - The phone therefore can't show which single-choice option was correct, while connected players can.
5. **Timing invariants unpinned (minor).**
   - Nothing stops a tuning edit to `TIMING` from breaking AWS limits or ADR-0005 fairness.

## Required changes

- **(1) + (2): protocol and engine.**
  - Add `LIMITS.openRevealMax = 100`.
  - Add an optional `omitted: number` field to the `open` variant of `QuestionResult` (the count of responses not included). It is additive, so no protocol version bump.
  - **Host view** (`hostResult`, stored result, `host.state`): the newest `openRevealMax` responses with status `visible`, plus the newest 50 with status `pending`/`hidden`, so the moderation view still works. Sort as before; `omitted` = total − included.
  - **Player view** (`toPlayerResult` for `open`): `responses: []` with `omitted` = the count of visible responses. Phones never render other people's text, and this removes the leak at its source.
  - Apply the same caps in `refreshModeration` and `computeLiveStats` where results are rebuilt (live stats already pages; keep that).
  - Word cloud is already capped at `wordCloudTopN`; assert it.
- **Size tests (engine).** Build the maximum case: 500 players, 3 entries each of 200 four-byte characters (emoji), 6-option polls, 16-grapheme emoji nicknames. Assert:
  - `JSON.stringify` of every player `reveal`, of the host `host.state` snapshot in reveal, and of every `leaderboard`/`ended` message is < 128 KB.
  - The stored result JSON is < 350 KB.
- **Secrecy test.** No player-bound message produced by the engine contains any other player's `playerId` inside an open-ended or word-cloud result.
- **(3)** Apply the nickname anti-stacking rule (the run-based `\p{Mn}`/`\p{Me}` check, max 3 per base) in `normalizeWord` and `normalizeOpenText`: they return `null`, so the ack reason is `invalid`. Share one helper instead of duplicating it. Add tests beside the nickname Zalgo tests, including accepted Hindi/Bengali words.
- **(4)** Add an optional `question: PublicQuestion` to `PlayerSnapshot.reveal` in `packages/protocol/src/play.ts`, and fill it in `buildPlayerSnapshot` for phase `reveal`; the answer is public at that point. Test it for each question type. The web reducer will adopt it in a later task.
- **(5)** In `packages/protocol/test`, assert invariants rather than copying values:
  - `heartbeatIdleMs + pongTimeoutMs < 10 min` (API Gateway idle timeout)
  - `plannedReconnectMs + reconnectCapMs < 2 h` (API Gateway maximum duration)
  - `minLeadMs.lambda >= 1500` and `minLeadMs.node >= 500`
  - `fullPointsWindowMs < min(TIME_LIMITS_SEC) * 1000`
  - `answerGraceMs === 750` (ADR-0005)
  - `clientMessageMaxBytes <= 32 * 1024` (API Gateway frame size)
- **Service tests.** `packages/service` consumes these results. Run its test suite and update any assertions that relied on player-bound open responses. Also add, to `packages/service/test/scenario.test.ts`, an assertion that a player's open-ended reveal has no responses. Only `packages/service/test/**` may change in that package; if service source needs a change, report it instead of making it.

## Files you own

- `packages/protocol/src/{limits,play}.ts`, `packages/protocol/test/**`
- `packages/engine/**`
- `packages/service/test/**`

## Acceptance criteria

1. `pnpm --filter @zqhoot/protocol test`, `@zqhoot/engine test` (coverage thresholds unchanged) and `@zqhoot/service test` (DynamoDB Local at `http://localhost:8000`) pass. All typechecks pass.
2. The size, secrecy and invariant tests above exist and pass.
3. `pnpm exec prettier --check packages` passes.
