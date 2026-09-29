# F3-grace-followups: keep the answer grace for manual closes after the deadline

Owner: Sonnet implementation agent. Reviewer: independent Opus agent. Source: an open question from the F1 review (R1-02), decided by the lead, plus two load-test follow-ups F1 reported.

## Read first

- `docs/tasks/F1-realtime-audit-fixes.md` (decision 3 and the FA-05/FA-08 evidence)
- `docs/adr/0005-timing-fairness-scoring.md` (acceptance window `openAt - 250 ≤ receivedAt ≤ deadline + answerGraceMs`)
- `packages/service/src/game-service.ts` (`#awaitGraceEnd` and where it is called), `packages/engine/src/session.ts` (`applyHostCommand`), `packages/service/test/timing.test.ts`
- `load/lib/host.js`, `load/README.md`

## Problem

F1 made the service hold a `host.close {reason:'timer'}` that arrives before `deadline + answerGraceMs`. A person can still cut the window short. When a timed question's deadline passes, the presenter shows "Time's up" at once and offers Next. A host who presses End question, Next, Space or a clicker then sends `host.close {reason:'manual'}` or `host.next {from:'question'}` inside the grace window. The service closes at once and refuses answers in flight as `too-late`. That is exactly the loss FA-05 fixed for the timer.

## Lead's decisions

1. **Hold after-deadline closes.** For a timed question (`deadline !== null`), any of these that arrives after `deadline` and before `deadline + answerGraceMs` is held until `deadline + answerGraceMs`, exactly as F1 holds an early timer close:
   - `host.close` with any reason;
   - `host.next` whose `from` is `question`, which closes the question.

   Hold on Node by leaving the close to the scheduler, which already fires at `deadline + grace`. Hold on Lambda with the bounded `Sleep` wait.

2. **Keep early actions immediate.** Before the deadline, a manual close, a `host.next` from `question` and an `all-answered` close stay immediate: ending a question early is the host's choice. An `all-answered` close is always immediate: nobody is left in flight.
3. **Show the host that Next worked.** On the VM the held command does nothing itself, and the scheduler's close follows within `answerGraceMs`. The host must still see the reveal within about a second of pressing Next. Verify that a VM `host.next` from `question` inside the window leads to the reveal without a second press (a test with the Node scheduler and a manual clock), and that the host gets no error for the held command.
4. **Align the k6 host (`load/lib/host.js`).** Send the timer close at `deadline + answerGraceMs` (server time), as the web driver now does. Use `stats.expected` for the all-answered close when present, falling back to `totalPlayers`. Update `load/README.md` where it describes the host's timing. Keep `load/test` green.
5. **Tests on both stores.**
   - An answer received at deadline + 300 ms is accepted and scored when the host's manual close, and separately a `host.next` from `question`, arrives at deadline + 50 ms.
   - A manual close at deadline − 1,000 ms is still immediate.
   - Lambda path: the held command waits no longer than the remaining grace.

## Files you own

`packages/service/**` (source, README and tests), `packages/engine/**` only if the engine must expose a helper (keep it pure), `apps/server-node/test/**`, `apps/server-lambda/test/**`, `load/lib/**`, `load/test/**`, `load/README.md`.

Another task (F2) is editing `apps/web/**` at the same time, so don't touch it.

## Acceptance criteria

1. The decisions above are implemented and tested as stated.
2. `pnpm typecheck`, `pnpm test` (all packages; DynamoDB Local runs on :8000) and `pnpm format:check` pass.
3. `load/run-local.sh node` meets every gate. The machine is shared, so compare the functional gates only.
4. No changes outside the files you own.
