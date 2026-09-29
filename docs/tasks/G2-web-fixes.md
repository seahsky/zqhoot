# G2-web-fixes: wave 1 gate findings in the web app

Owner: Sonnet implementation agent. Reviewer: independent Opus agent. Source: `docs/reviews/wave1-gate.md` (G2, G3, G4, G8, G9, G10, G11, G12, G13). Every finding was confirmed by independent verifiers. Read each one's evidence there before changing code.

## Fixes

1. **Do-not-copy string (G8, blocker under hard requirement 6).**
   - The player end screen and related announcements use "Game over", a Kahoot string. Replace it everywhere in `apps/web` with our own copy (e.g. "Final results").
   - Extend `test/source-scan.test.ts` with case-insensitive patterns for the brand strings listed in `docs/research/kahoot.md` §11 and `docs/research/mentimeter.md` §9: at least "Game over", "Play again", "Spin!", "Team talk", "Lock game joining", "Host live", "Please wait for the presenter", "Presentation is closed", "Open Q and A", "Show question!", "Participate again", "Go to slide", "kahoot", "mentimeter", "menti". The scan covers `src/` and `index.html`.
2. **Stale welcome snapshot reverts newer state (G2/G9, major).**
   - The player reducer applies any `welcome` snapshot even when its `sv` is lower than state already applied on the **same** connection. A resume racing a broadcast can therefore throw a player back to the lobby for a whole question.
   - Track the highest `sv` seen since the latest (re)connect, reset when the connection status enters `connecting`/`reconnecting`. Apply a `welcome` only if `snap.sv >=` that value; otherwise ignore it.
   - The first welcome on a fresh connection still wins (the VM-restart rollback case documented in `apps/web/README.md`).
   - Apply the same rule to the host reducer's `welcome`/`host.state` handling if it has the same gap.
   - Reducer tests: resume racing a `question` broadcast; resume after a VM restart (lower `sv` on a new connection) still applies.
   - Record the rule in `apps/web/README.md`.
3. **Duplicate-ack reconciliation keeps the wrong entries (G3/G12, minor).**
   - On `answer.ack {status:'duplicate'}`, remove the oldest pending optimistic entry, the same way `rejectOldestPending` handles refusals.
   - Tests: [accepted, duplicate, accepted]; [accepted, accepted] with entries 1 then 2; a duplicate in the middle of three pending sends.
4. **Resume during reveal loses the correct answer (G4/G10, minor).**
   - The G1 engine task adds an optional `question: PublicQuestion` to `PlayerSnapshot.reveal`; it is merged before this task starts. Check `packages/protocol/src/play.ts`.
   - Use it in `applySnapshot`, so a resumed player sees the correct-answer card for single-choice questions. Test it for each question type.
5. **Horizontal-scroll check is vacuous on mobile projects (G11, major).**
   - Compare `document.documentElement.scrollWidth` with `document.documentElement.clientWidth` (or `visualViewport.width`) instead of `innerWidth`, which mobile emulation inflates.
   - Add a gallery-only screen `test-overflow` (excluded from the axe/screenshot matrix) holding a deliberately over-wide element. Add a self-test proving the check **fails** on it at phone-320 and passes on every real screen.
   - Run the corrected check over every non-presenter screen, including the web-b host and editor screens, on all 6 projects. Fix any real overflow it uncovers.
6. **Reconnect-between-questions wiring untested (G13, minor).**
   - Extract the predicate PlayPage passes to the Connection (which screens allow a planned reconnect) into a pure function and unit-test it for every screen.
   - The presenter and host pages must follow ADR-0008 as well. If they use planned reconnects, test their predicates the same way.

7. **Nickname errors show the reason (from G5).** The server rejects nicknames over `LIMITS.nicknameMaxBytes` (96 UTF-8 bytes) with `nickname-invalid` and the reason in `message`. The join screen currently maps every `nickname-invalid` to one generic sentence. Show a specific message per reason (too short, too long, not allowed characters, not allowed word), taken from the error's `message` field. Also add a local byte check using `TextEncoder`, so the live counter warns before submitting. Keep the counter itself grapheme-based. Test both.

## Files you own

- `apps/web/**`

## Acceptance criteria

1. `pnpm --filter @zqhoot/web typecheck`, `test`, `build` and `test:e2e` pass, with the corrected overflow check active on all six projects and the self-test proving it can fail.
2. No do-not-copy string remains, and the scan prevents regressions.
3. Every fix above has a test that fails without the fix. State in your report how you checked that, e.g. by temporarily reverting the fix.
4. `pnpm exec prettier --check apps/web` passes.
