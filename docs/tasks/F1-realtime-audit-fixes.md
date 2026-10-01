# F1-realtime-audit-fixes: server and realtime findings from the final audit

Owner: Sonnet implementation agent. Reviewer: independent Opus agent. Source: the phase 5 final audit at commit `170b09c`. Each finding below was reproduced by the auditor and survived at least one independent verifier who tried to refute it. The evidence and verifier notes are quoted in full. Read them, then read the code: line numbers may have moved.

## Read first

- `docs/adr/0005-timing-fairness-scoring.md` (acceptance window `openAt - 250 ≤ receivedAt ≤ deadline + answerGraceMs`)
- `docs/adr/0006-answers-aggregation-reveal.md` (close, settle, reveal order, auto-close "when every connected, non-kicked player has answered")
- `docs/adr/0013-security.md` (failed-PIN limit), `docs/adr/0008-reconnect-resume.md`
- `packages/service/src/game-service.ts`, `packages/service/src/http-app.ts`, `packages/engine/src/*`, `packages/store/src/store.ts`, `apps/web/src/state/{driver,host,player}.ts`, and the WebSocket adapters `apps/server-node/src/ws-server.ts` and `apps/server-lambda/src/ws-handler.ts`

## Files you own

`packages/service/**`, `packages/engine/**`, `packages/store/**`, `packages/protocol/**` (additive, optional fields only, and only if a fix needs one), `apps/server-node/src/ws-server.ts`, `apps/server-lambda/src/ws-handler.ts`, `apps/web/src/state/**`, `apps/web/src/net/**`, and the tests of all of these.

Other tasks are editing these files at the same time, so don't touch them: `apps/web/src/screens/**`, `apps/web/src/ui/**`, `apps/web/src/dev/**`, `apps/web/e2e/**`, `docs/**`. If a fix needs a visible UI change, stop at the state layer and record what the UI should do as an open issue.

## Lead's decisions

1. **WebSocket `join` gets the failed-PIN limit (FA-03).**
   - `join` goes through the same per-IP budget as `GET /api/join/:pin`: the same store counter (`pin:{ip}`), limit (30) and window (60 s), shared by both paths. Move the constants somewhere both use.
   - The order matches HTTP: peek first; a blocked IP is refused before the PIN is looked up, even for a live PIN, so there is no oracle. Only a miss (unknown or expired PIN) counts a hit.
   - A blocked `join` gets `error` with code `rate-limited`.
   - The source IP comes from the adapter on every message: on Node from the upgrade request (keep the `trustProxy` rules), on Lambda from `requestContext.identity.sourceIp` of the `$default` event. Check that `ws-handler.ts` passes it to `onMessage`. An unknown IP is keyed as `unknown`, as HTTP does.
   - Tests on both stores:
     - the 31st WebSocket miss from one IP is refused;
     - HTTP and WebSocket misses share one budget;
     - a valid PIN from a blocked IP is refused;
     - another IP is unaffected;
     - a classroom of valid joins from one IP is never limited.
2. **The player cap holds under concurrency (FA-04).**
   - With N concurrent joins against a cap of M < N, exactly M are admitted on both stores and the rest get `session-full`.
   - Choose the mechanism: a conditional admission write in the store, or insert, then verify with a deterministic order, then compensate. Record the choice. Keep the answer path untouched, and add at most one write to the join path.
   - Add a contract test in `packages/store` for the concurrent case if the store interface changes, and a service test for the concurrent joins.
3. **Answers inside the grace window are kept (FA-05, FA-08).**
   - The host driver sends the timer `host.close` at `deadline + TIMING.answerGraceMs` (server time), not at the deadline. Screens that show "Time's up" at the deadline must not depend on the close.
   - The server also protects the window. A `host.close` with reason `timer` that arrives before `deadline + answerGraceMs` must not cut it short. On Node, let the scheduler's own close at `deadline + grace` do it, or defer to that time. On Lambda, the invocation waits with the `Sleep` port until `deadline + grace` (at most `answerGraceMs`), then closes.
   - Manual and `all-answered` closes stay immediate.
   - Tests on both stores: an answer received in `(deadline, deadline + grace]` is accepted and scored when the host's timer close arrives at deadline + 50 ms, and a manual close is still immediate.
4. **Auto-close counts connected players (FA-06).**
   - `all-answered` fires when every connected, non-kicked player has answered, as ADR-0006 says. A player who answered and then disconnected still counts as answered. A player who left or is offline without answering does not hold the question open.
   - Put the count where the data is. If the host needs a new field (for example a "waiting on" count in `stats`), make it optional and additive, and keep every host message inside the 128 KB bound (`packages/engine/test/size.test.ts`).
5. **A retried reveal keeps the settle interval (FA-09).** When `host.next` from `revealing` retries a reveal inside the settle interval, wait out the rest of the interval measured from the close, then reveal. Test it with the Lambda settle (1,000 ms): an answer acknowledged as accepted during the settle is scored after a double-tapped Next.
6. **A lost timer close is retried (FA-10).**
   - The host driver re-sends the timer close while the question is still open past `deadline + grace`: first after a short interval (a few seconds), then with backoff, capped.
   - It also re-sends after a reconnect whose snapshot is still in that question past its deadline.
   - The server's `questionIndex` guard makes repeats harmless. Driver tests cover both cases.
7. **A stale welcome still fills the header (FA-11).** When a `welcome` is older than state already applied on this connection, the player reducer ignores its game state but still applies the identity fields (nickname, quiz title) and any score or rank that is not older than what it shows. Add a reducer test for a question broadcast that overtakes the resume welcome.

## Findings

### FA-03 (major) WebSocket `join` lets anyone enumerate live game PINs, bypassing the per-IP failed-PIN limit

- Lens: security. Files: `packages/service/src/game-service.ts`, `packages/service/src/http-app.ts`, `apps/server-node/src/ws-server.ts`, `apps/server-lambda/src/ws-handler.ts`, `docs/adr/0013-security.md`, `docs/tasks/W2-service.md`
- Evidence: The HTTP lookup counts misses per IP and then blocks every lookup from that IP (http-app.ts:284-300: `peekRateLimit(counter...)` before the lookup, `hitRateLimit('pin:'+ip, 30, 60_000)` on a miss). W2-ratelimit.md exists only to stop a 200-vs-429 oracle.

The WebSocket `join` does the same PIN lookup with no IP limit. game-service.ts:356-375:

```
const withinLimit = await store.hitRateLimit(`nick:${connectionId}`, this.#cfg.nicknameAttemptsPerConnection, NICKNAME_WINDOW_MS, now);
...
const sessionId = await store.getSessionIdByPin(msg.pin);
...
if (!check.ok || sessionId === null || meta === null) {
  const code = check.ok ? 'not-found' : check.code;
  await this.#out.error(connectionId, code, JOIN_REFUSALS[code], 'join');
```

- The only limit is 10 attempts per connection, and connections are free to open. Neither the VM upgrade handler (ws-server.ts:111-134) nor API Gateway $connect has a per-IP cap. The VM IpRateLimiter covers only /api/* (http.ts:371-375).
- `onMessage` receives `info.sourceIp` (game-service.ts:189-193) but never passes it to `#join`.

Reproduced against the real VM server (createServer, memory store). The probe first burned the HTTP miss budget, then guessed PINs over /ws from the same IP, using a new connection every 10 guesses:

```
HTTP: 429s while burning = 1 ; lookup of the real PIN after = 429
WS: connections = 14 not-found replies = 139 found PIN = 966092 real PIN = 966092
```

The same code runs on AWS behind a stage throttle of 2,000 msg/s (realtime-ws variables.tf:61-71).

- Impact: The ADR-0013 brute-force control on PINs does not hold on either target. An attacker can sweep the 900,000-PIN space over WebSocket at thousands of guesses per second on AWS (or at local CPU speed on the VM). They find live sessions and, since a hit on `join` also admits them, can drop players with arbitrary nicknames into strangers' games (classroom 'quiz bombing'). The HTTP limit that W2-ratelimit hardened is moot while this path exists.
- Auditor's suggested fix: Apply the same failed-lookup accounting in `#join`:
- Pass `info.sourceIp` from `onMessage` into `#join`.
- Before `getSessionIdByPin`, call `peekRateLimit('pin:'+ip, 30, 60_000, now)` and refuse with `rate-limited` (then close) when blocked.
- On a `not-found` outcome, call `hitRateLimit` with the same key, so HTTP and WS share one bucket. Successful joins must not count, which keeps classrooms behind one NAT working.
- Add service tests for: an IP over the limit cannot learn a valid PIN via `join`, and HTTP misses block WS joins (and the reverse).
- Update the W2-service spec and ADR-0013 so the rate-limit table covers `join`.
- Verifier notes:
  - I checked the code at 170b09c with git show and found the finding accurate. - packages/service/src/game-service.ts, `#join` (around lines 356-375): the only limit is `hitRateLimit('nick:'+connectionId, cfg.nicknameAttemptsPerConnection, NICKNAME_WINDOW_MS, now)`. After that it calls `getSessionIdByPin`, `getSession`, `countPlayers` and `checkJoinable`, and a miss replies `not-found`. There is no `pin:`+ip peek or hit. - `onMessage(connectionId, raw, receivedAt, info?: {sourceIp})` uses `info.sourceIp` only in the error log. `#handleFrame` and `#join` never receive it. - packages/service/src/http-app.ts, `GET /api/join/:pin` (around lines 278-300): it peeks `pin:${ip}` (30 per 60 s) before the lookup and hits the counter on a miss. The code comment says this exists so that "a 200 among 429s" cannot tell an attacker which guesses are live. The WS `join` gives exactly that oracle: `not-found` versus a `joined`, `locked` or `full` reply. - apps/server-node/src/ws-server.ts, `upgrade` (around lines 111-134): it checks the path, the closing state and `onConnect` (the Origin check only), with no per-IP connection cap. The per-connection token bucket is 10 msg/s with a burst of 20, and a new connection resets it. The Origin header is trivially set by a non-browser client, so the Origin check does not stop a scripted attacker. - ADR-0013's rate-limit table lists "Failed PIN lookups: 30 per IP per minute" as a control on both targets, not scoped to HTTP. The WS-side controls it names (nickname attempts per connection, per-connection message rate, the AWS stage throttle of 2,000 msg/s aggregate) are all per-connection or aggregate. The ADR's line "There are no per-IP join caps" is about successful joins behind one NAT. It does not accept unlimited failed PIN guesses, and the prop
  - I read the code at 170b09c and the finding holds. I did not re-run the probe, because the code path is clear. - **The HTTP lookup is limited per IP.** `packages/service/src/http-app.ts:280-301` runs `peekRateLimit('pin:'+ip, 30, 60s)` before the lookup and `hitRateLimit` on a miss. - **The WebSocket `join` is not.** `#join` in `packages/service/src/game-service.ts:352-375` only calls `hitRateLimit('nick:'+connectionId, nicknameAttemptsPerConnection, NICKNAME_WINDOW_MS)` and then `getSessionIdByPin(msg.pin)`. It replies `not-found` or other codes without touching any `pin:` key. - **The source IP is dropped.** `onMessage` receives `info.sourceIp` (lines 189-193) but uses it only for error logging. It is never passed to `#join`. - **Nothing else limits it.** A grep for `hitRateLimit`/`peekRateLimit` in non-test code finds only http-app.ts (lines 289, 297, 324) and game-service.ts:356. `onConnect` (lines 159-173) only checks Origin. - **The VM has no per-IP cap.** The upgrade handler (`apps/server-node/src/ws-server.ts:111-134`) has none. The per-socket token bucket (10 msg/s, burst 20) resets with every new connection. `deploy/vm/Caddyfile` has no limit directives. - **AWS has only the stage throttle.** Per ADR-0013 that is 2,000 msg/s shared across the stage, with no per-connection limit. An attacker can therefore open connections freely and send up to 10 `join`s on each. A `not-found` reply versus any other reply shows whether a PIN is live, and a hit actually admits the attacker as a player. The design does not intend this: - ADR-0013's rate-limit table lists "Failed PIN lookups: 30 per IP per minute" without limiting it to HTTP. - ADR-0002 and W2-ratelimit.md exist specifically so that "an attacker enumerating PINs" cannot bypass the control. - `docs/research/realti

### FA-04 (minor) maxPlayers is checked then written non-atomically; concurrent joins overfill a session

- Lens: security. Files: `packages/service/src/game-service.ts`, `packages/engine/src/session.ts`, `packages/store/src/dynamo.ts`, `packages/engine/src/views.ts`
- Evidence: game-service.ts:370-371 reads the count, and the insert happens later at :396 after awaits, including `sha256Hex` (WebCrypto, truly async):

```
const count = sessionId === null || meta === null ? 0 : await store.countPlayers(sessionId);
const check = checkJoinable(meta, count, now);
...
if ((await store.addPlayer(player, meta.expiresAt)) === 'nickname-taken') {
```

`DynamoStore.addPlayer` (dynamo.ts:360-390) conditions only on the player and nickname items, not on a count. Nothing re-checks the count after insert.

Reproduced on the VM server with a memory store and the default maxPlayers of 500. 800 sockets opened, then all sent `join` at once:

```
maxPlayers 500; joins sent 800 ; welcomes 545 ; session-full 254 ; countPlayers 545
```

The 128 KB host.state budget in views.ts:44-51 assumes that 'the roster is bounded by the nickname byte cap', meaning 500 players. docs/PLAN.md defers overflow only for a maxPlayers setting above 500, not for this race.

- Impact: Anyone with the PIN can push a session past its player cap by joining in parallel. On AWS the overshoot is limited only by Lambda concurrency during the countPlayers-to-addPlayer window, and the attacker picks 96-byte nicknames. Enough overshoot pushes host.state and the host welcome past API Gateway's 128 KB message limit, and PostToConnection then fails for the host and presenter. The VM measurement shows the cap is not enforced; the AWS magnitude was not measured.
- Auditor's suggested fix: Make the cap atomic. On DynamoDB, add a counter to META (or a PLAYERS#COUNT item), updated inside the addPlayer transaction with a condition `count < maxPlayers`. In the memory store, check and insert in the same synchronous step. Alternatively, re-count after addPlayer and roll back (delete the player and nickname items) when the count exceeds maxPlayers. Add a concurrency test that fires more joins than maxPlayers and asserts the final count.
- Verifier notes:
  - I read the code at commit 170b09c and could not refute the finding. - **The count check is separate from the insert.** In `packages/service/src/game-service.ts`, `#join` gets the count from `await store.countPlayers(sessionId)` and checks it with `checkJoinable(meta, count, now)`, which refuses with `session-full` when `playerCount >= meta.maxPlayers` (`packages/engine/src/session.ts:68`). The player is written later by `store.addPlayer(...)`. In between there are more awaits, including `await sha256Hex(token)`. No step re-checks the count after the insert. - **The DynamoDB store does not enforce the cap.** `DynamoStore.addPlayer` (`dynamo.ts:360-390`) is a two-Put transaction. Its only conditions are create-conditions on the PLAYER and NICK items, with no counter and no count condition. `countPlayers` is a separate `Query` with `Select: 'COUNT'` and `ConsistentRead`. A consistent read does not stop two Lambdas from both reading the same count before either one writes. - **The memory store does not enforce it either.** `MemoryStore.addPlayer` (`memory.ts:341-349`) checks only nickname and playerId. Concurrent `#join` calls in the one Node process interleave at the awaits, so all of them can read the same count before any of them inserts. That fits the reported 545 players against a cap of 500. I did not re-run that test; the race is plain from the code. - **The design docs do not treat it as intended.** ADR-0013 lists "Joins per session: `maxPlayers` (default 500)" as a security limit. ADR-0004 and the `views.ts` comment on `HOST_STATE_MAX_BYTES` rely on 500 players, about 82 KB of roster, to keep `host.state` under API Gateway's 128 KB message limit. PLAN.md G5-nickname-bytes covers only a configured `maxPlayers` above 500, not a race. Nothing in the docs calls the ca

### FA-05 (major) The host closes each question at the deadline, so answers inside the 750 ms grace window are rejected as too-late on both targets

- Lens: contracts. Files: `apps/web/src/state/driver.ts`, `apps/web/src/screens/host/useHostSession.ts`, `packages/engine/src/answers.ts`, `packages/service/src/game-service.ts`, `packages/protocol/src/limits.ts`, `docs/ARCHITECTURE.md`, `docs/adr/0005-timing-fairness-scoring.md`
- Evidence: The protocol and ADR-0005 accept answers until `deadline + TIMING.answerGraceMs`:
- `packages/protocol/src/limits.ts`: `answerGraceMs: 750`, with the comment "Answers received up to this long after the deadline are accepted (uplink latency)".
- ADR-0005:26: "Accept only when ... receivedAt <= deadline + TIMING.answerGraceMs".
- On the VM the service schedules the close at `meta.deadline + this.#cfg.engine.answerGraceMs` (game-service.ts, `question-opened`).

The web host driver, which both the control and the presenter run on both targets, closes at the bare deadline. apps/web/src/state/driver.ts, `tick`:

```
if (canClose(state, now) && q.deadline !== null && now >= q.deadline) {
  const close: HostCloseMsg = { type: 'host.close', questionIndex: q.index, reason: 'timer' };
```

useHostSession.ts:141 feeds it `q.deadline` unchanged: `driverQuestionOf(q.question, snapshot.questionIndex, q.openAt, q.deadline)`.

Once that close commits, the engine refuses every answer by phase, before it looks at `receivedAt`. packages/engine/src/answers.ts:

```
if (meta.phase === 'revealing' || meta.phase === 'reveal' || meta.phase === 'leaderboard') {
  return reject('too-late');
}
```

The existing test packages/service/test/timing.test.ts:87-94 shows even `receivedAt = openAt + 100` coming back too-late after a close.

Probe run in a detached worktree through the service harness (MemoryStore and DynamoStore; both tests passed):

1. Open question 0.
2. `h.clock.set(deadline)`.
3. `g.close(0, 'timer')`.
4. `g.answer('Ann', 0, choice('opt-paris'), deadline + 100)`.
5. The ack is `{status:'rejected', reason:'too-late'}`.

ARCHITECTURE.md claims "Late answers are rejected by server time regardless of when the close arrives, so a slow or absent host delays the reveal but cannot change scores". A prompt host does change scores.

- Impact: The player UI keeps options answerable until its own estimate of the deadline (player.ts: `now > info.deadline`). That estimate runs behind true server time by the downlink delay, and the answer then needs its uplink. A phone on a cellular link (100-300 ms each way) that answers in the last few hundred ms therefore reaches the server after a wired host's close, which arrives at about deadline + 50 ms.

That answer is refused as 'too-late' and scores 0, although it is well inside the 750 ms grace the protocol promises. The VM's own scheduler close at deadline + grace never gets to act, because the host's close lands first. On Lambda, answers that API Gateway received before the deadline are rejected too, whenever their invocation reads the session after the close commits (cold starts or queueing during a last-second burst of 400).

This breaks the server-time fairness requirement (hard requirement 5) in a situation that is normal in real rooms: people answer at the last moment on phones.

- Auditor's suggested fix: Make the host send its timer close at `deadline + TIMING.answerGraceMs`. In driverStep `tick`, compare `now >= q.deadline + TIMING.answerGraceMs`, or pass the grace-extended deadline in useHostSession.

Also consider evaluating `receivedAt <= closedAt + grace` in evaluateAnswer for phase 'revealing', so an answer received before the close is still accepted during the reveal settle window.

Add a driver test pinning the close time, and a service test in which an answer with `receivedAt` inside the grace, arriving after a timer close, is accepted.

- Verifier notes:
  - I could not refute it. Everything below was read from commit 170b09c with `git show` and `git grep`. I did not re-run the probe, because an existing service test already shows the behaviour. **The code does what the finding says:** - **The host driver closes at the bare deadline.** `apps/web/src/state/driver.ts:145` sends `host.close {reason:'timer'}` when `now >= q.deadline`. There is no grace. `useHostSession.ts:141` passes `q.deadline` through unchanged, and the driver ticks every 250 ms (`DRIVER_TICK_MS = 250`). - **The engine rejects on phase before it checks time.** `packages/engine/src/answers.ts:92-94` returns `too-late` for phase `revealing`, `reveal` or `leaderboard` before the `receivedAt > deadline + answerGraceMs` check at line 100. After a close, the grace window can never apply. - **An existing test shows this.** `packages/service/test/timing.test.ts:87-94` rejects `receivedAt = openAt + 100` as `too-late` once the question is closed. - **The VM's own timer does include the grace.** `packages/service/src/game-service.ts:722-726` schedules the close at `meta.deadline + answerGraceMs`. So the design intends the grace window, and the web host (which runs on both targets) cuts it short. **The specs contradict each other, so this is not intended and documented behaviour:** - `docs/tasks/W1-web-b.md:62` and `ARCHITECTURE.md:84` do say the host sends the close "at the deadline", so the driver matches its own task spec. - But ADR-0005:26 promises acceptance up to `deadline + TIMING.answerGraceMs`, and `limits.ts:64-65` says the grace exists "for uplink latency". - `ARCHITECTURE.md:84` also claims late answers are rejected by server time "regardless of when the close arrives", so a host "cannot change scores". Given the phase check, that claim is false. - The de
  - I checked every claim against commit 170b09c, and all of them hold. - **Host closes at the bare deadline.** apps/web/src/state/driver.ts:145 sends a timer close when `now >= q.deadline`, with no grace added. useHostSession.ts:141 passes `q.deadline` unchanged through driverQuestionOf (driver.ts:104-111). Both LivePage.tsx:54 (control) and PresentPage.tsx:52 (presenter) call useHostSession with `drive: true`. So the host's close runs on the VM as well as on Lambda. - **The engine rejects by phase before it looks at time.** In packages/engine/src/answers.ts:91-93, phase `revealing`, `reveal` or `leaderboard` returns `reject('too-late')` before the `receivedAt > deadline + answerGraceMs` check at line 100. `closeQuestion` sets phase `revealing` (session.ts). The existing test packages/service/test/timing.test.ts:87-94 shows `receivedAt = openAt + 100` coming back too-late after a close. game-service.ts:567-573 hands the transport `receivedAt` straight to evaluateAnswer. - **The promised grace.** limits.ts:64-65 defines `answerGraceMs: 750`, commented "Answers received up to this long after the deadline are accepted (uplink latency)". ADR-0005:26 accepts answers up to `deadline + TIMING.answerGraceMs`. The VM scheduler closes at `deadline + answerGraceMs` (server-node/src/ports/scheduler.ts:106; game-service.ts:722-725). So the grace is designed in, but the host's earlier close cuts it off. **Is it intended and documented?** Only in part. ARCHITECTURE.md:84 and docs/tasks/W1-web-b.md:62 do say host clients send the timer close "at the deadline". The same ARCHITECTURE.md sentence then claims "Late answers are rejected by server time regardless of when the close arrives, so a slow or absent host ... cannot change scores". The code shows that claim is false. The docs contrad

### FA-08 (major, same defect as FA-05) Host clients close timed questions at the deadline, so answers in the 750 ms grace window (and slow or cold answer invocations) are rejected as too-late on both targets

- Lens: realtime. Files: `apps/web/src/state/driver.ts`, `apps/web/src/screens/host/useHostSession.ts`, `packages/engine/src/answers.ts`, `packages/service/src/game-service.ts`, `docs/adr/0006-answers-aggregation-reveal.md`, `docs/ARCHITECTURE.md`, `docs/tasks/W1-web-b.md`
- Evidence: The driver sends the timer close as soon as the host's estimated server time reaches the deadline. apps/web/src/state/driver.ts:145 has `if (canClose(state, now) && q.deadline !== null && now >= q.deadline) { ... reason: 'timer' }`. Both the control page and the presenter run it on both targets: LivePage.tsx:54 and PresentPage.tsx:52 pass `drive: true`.

The server accepts answers until deadline + 750 ms (answers.ts:100, `receivedAt > meta.deadline + i.cfg.answerGraceMs`). But closeQuestion sets phase `revealing` right away, and evaluateAnswer then refuses every answer whatever its receivedAt: answers.ts:92-93 has `if (meta.phase === 'revealing' || ...) return reject('too-late')`. The VM scheduler arms deadline + grace (game-service.ts:722-726), but the host's close at the deadline comes first, so that timer finds the question already closed.

I reproduced it in a scratch service test on MemoryStore and DynamoStore:

1. Open question 0 (20 s).
2. Set the clock to deadline+100 and send `host.close {reason:'timer'}`.
3. Send an answer with receivedAt = deadline+300.

Result: `{"type":"answer.ack","status":"rejected","reason":"too-late"}`. The existing test timing.test.ts:9-27 only passes because no close is sent before its deadline+750 answer.

The docs contradict each other. ADR-0006 line 31 says the too-late case for an answer received before the close 'only arises on an early manual close'. ARCHITECTURE.md:84 says 'a slow or absent host delays the reveal but cannot change scores'. W1-web-b.md:62 specifies closing 'At the local deadline'.

- Impact: Players lose answers they sent before the deadline, and the loss depends on network speed.

The player's clock estimate lags by its fastest downlink (ADR-0005), so a tap in the last moment reaches the server at about deadline + (player RTT). The host's close reaches it at about deadline + (host RTT) + up to 250 ms of tick delay. A phone on a 300 ms cellular link that answers in the last ~0.2 s gets 'Too late: this question has closed' and 0 points. A wired host laptop's close would have let that answer through if the grace window applied.

On Lambda, a cold-started answer invocation that reads META after the close is also refused, even when API Gateway received it well before the deadline. This undercuts the ADR-0005 grace (hard requirement 5, fairness) on both targets. Scores then depend on when the host's close lands, which ARCHITECTURE says cannot happen.

- Auditor's suggested fix: Choose one of these, or both:

(a) Make the driver close at `deadline + TIMING.answerGraceMs`. The settle then covers the in-flight writes. Update W1-web-b, ARCHITECTURE line 84 and ADR-0006 line 31 to match.

(b) Have evaluateAnswer accept an answer in `revealing` for the same questionIndex when `receivedAt <= meta.closedAt` and within deadline + grace. The reveal settle then covers the write.

Add a service test: timer close at deadline+100, then an answer received at deadline+300 must be accepted and scored at 400 points.

- Verifier notes:
  - I checked this against 170b09c with `git show`. I did not run a scratch test, because the code path is short and has no branches that could change the outcome. - **The driver closes at the deadline.** `apps/web/src/state/driver.ts` in the 'tick' case sends `host.close {reason:'timer'}` once `now >= q.deadline`, with no grace added. `now` is `c.clock.serverNow(Date.now())` (useHostSession.ts:119). LivePage.tsx:54 passes `drive: true` whatever the target. - **The server applies the close straight away.** The service sends host.close through `applyHostCommand` (game-service.ts:342). That calls `closeQuestion` (engine/session.ts:133-135), which sets `phase: 'revealing', closedAt: now` at once. Neither layer checks `reason` or waits for deadline+grace. - **Answers after the close are refused.** In `evaluateAnswer` (engine/answers.ts), the phase check `meta.phase === 'revealing' || 'reveal' || 'leaderboard' -> reject('too-late')` runs before the receivedAt-vs-(deadline + answerGraceMs) check. Any answer processed after the close is therefore rejected, even when its receivedAt is inside the 750 ms grace. - **The design meant the grace to apply.** ADR-0005:26 accepts answers until `deadline + TIMING.answerGraceMs` "for uplink latency". The VM scheduler is armed at `deadline + answerGraceMs` (game-service.ts:722-726; W2-service.md:193). ARCHITECTURE.md:81 defines the open sub-state as `openAt <= now <= deadline + grace`. ARCHITECTURE.md:84 says a slow host "cannot change scores". ADR-0006 says the too-late-after-close case "only arises on an early manual close". The host driver's close at the deadline contradicts all of these, so the behaviour is not intended. - **W1-web-b.md:62 does not make it intended.** It says to close "at the local deadline". That is a spec inconsistency
  - I confirmed the finding against commit 170b09c. Client side: - apps/web/src/state/driver.ts:145 sends `host.close {reason:'timer'}` once `now >= q.deadline`. - `q.deadline` is the raw `meta.deadline`, with no grace added. The chain is useHostSession.ts:141 → driverQuestionOf, which gets its value from engine views.ts:109/252/344 (`deadline: meta.deadline`). - The tick runs only once a server clock offset exists (useHostSession.ts:176), so `now` is the estimated server time. Engine side: - packages/engine/src/session.ts: closeQuestion (and timerClose, which calls it) sets phase `revealing` straight away, with `closedAt = now`. It has no grace-aware deferral. - packages/engine/src/answers.ts:92-93 rejects any answer as `too-late` whenever the phase is revealing, reveal or leaderboard. It does this before the `receivedAt > deadline + answerGraceMs` check at line 100, so the 750 ms grace from ADR-0005 line 26 is never reached after a close. - The VM scheduler arms its close at deadline + grace (game-service.ts:721-726), but the host driver's earlier close wins. Reproduction: I made a detached worktree at 170b09c and ran `pnpm install --frozen-lockfile --offline`. I then added a scratch service test with the `describeWithStores` harness: open question 0, set the clock to deadline+100, send `g.close(0,'timer')`, then answer at receivedAt = deadline+300. The ack matched `{status:'rejected', reason:'too-late'}`, and the test passed for both store variants (2 of 2). I removed the worktree afterwards and the main checkout is unchanged. The docs do not describe this as intended; they contradict each other: - ADR-0006 step 2 says the too-late case for an answer read after the close 'only arises on an early manual close'. - ARCHITECTURE.md:84 says late answers are judged by serv

### FA-06 (minor) The "all-answered" auto-close compares against every non-kicked player, including players who left or are offline, against ADR-0006

- Lens: contracts. Files: `packages/engine/src/aggregate.ts`, `apps/web/src/state/driver.ts`, `packages/service/src/game-service.ts`, `docs/adr/0006-answers-aggregation-reveal.md`
- Evidence: ADR-0006:24: "Hosts also use the count to send `host.close {reason:'all-answered'}` when every connected, non-kicked player has answered."

The engine's tally counts every non-kicked player, connected or not. packages/engine/src/aggregate.ts:

```
const active = new Map(players.filter((p) => !p.kicked).map(...));
...
totalPlayers: active.size,
```

The driver compares against that count. apps/web/src/state/driver.ts:182: `input.totalPlayers > 0 && input.answered >= input.totalPlayers && !q.multiEntry`.

A player who presses Leave only loses their connection record. The PlayPage onLeave sends `leave`, and game-service `#leave` does `deleteConnection` and `announceDisconnects`. The player record stays in `listPlayers`, so it stays in `totalPlayers` for the rest of the game.

- Impact: Once any player leaves, loses battery or closes the tab, `answered` can never reach `totalPlayers`. In a 400-player room that is almost certain, so questions never close early:
- timed questions always run to the deadline;
- untimed questions wait for the host to press End question.

The early close ADR-0006 describes practically never happens at the target scale.

- Auditor's suggested fix: Either add a connected-player count to LiveStats (the service already has `aud.players` when it builds stats) and compare against that, or count only players with a live connection in `tally` for live stats. Alternatively, correct ADR-0006 if counting disconnected players is intended.
- Verifier notes:
  - I checked every link in the chain at 170b09c and the finding holds. 1. docs/adr/0006-answers-aggregation-reveal.md:24 says hosts send `host.close {reason:'all-answered'}` "when every connected, non-kicked player has answered". So the documented intent is connected players only. 2. packages/engine/src/aggregate.ts `tally()` sets `totalPlayers: active.size`. `active` is every player record with `!p.kicked`, and connection state is never considered. 3. packages/engine/src/views.ts `computeLiveStats` passes `t.totalPlayers` straight into LiveStats. Its inputs are only question, responses, players and after; there is no connected set. The W1-engine spec signature is the same, while buildRoster and buildHostSnapshot do take `connectedPlayerIds`. 4. packages/service/src/game-service.ts `#stats` (~l.1005) loads `listResponses` and `listPlayers` and never lists connections. So nothing downstream narrows the count to connected players. 5. apps/web/src/screens/host/useHostSession.ts:154 forwards `stats.totalPlayers` to the driver. apps/web/src/state/driver.ts:182 closes only when `answered >= totalPlayers`, and nothing else sends an all-answered close. 6. game-service `#leave` (l.597) only runs `deleteConnection` and `announceDisconnects`. The PlayerRecord stays, so a player who leaves (or whose phone dies or tab closes) counts in `totalPlayers` for the rest of the session. Result: after one dropout, `answered` can never reach `totalPlayers`. Timed questions then run to the deadline, and untimed ones wait for a manual close. Scoring and correctness are unaffected, so this is a lost optimisation and an ADR/code contract mismatch, not a data or security issue. Minor is the right severity. I did not need to run anything; git show at the commit was enough.

### FA-09 (minor) host.next from 'revealing' during the reveal settle runs the reveal immediately, dropping answers that were acknowledged as accepted

- Lens: realtime. Files: `packages/service/src/game-service.ts`, `packages/engine/src/session.ts`, `apps/web/src/state/commands.ts`
- Evidence: How a host tab ends up holding 'revealing':
- When two host tabs send host.close together, or a host presses Next ('End question') just as the driver closes, the losing request becomes a no-op and gets `host.state` with phase `revealing` (game-service.ts:686-692).
- The control then offers 'Show results' (commands.ts:46-47). The presenter maps Space and the right arrow to the same host.next.
- A second press sends `host.next {from:{phase:'revealing'}}`. The engine returns `retry-reveal` (session.ts:150-151), and game-service.ts:744-746 calls `#reveal` without the settle that the `closing` branch (lines 739-742) waits for.

I reproduced it on MemoryStore and DynamoStore with revealSettleMs 1000:

1. Bob's answer read META while the question was open, and its putResponse is held back.
2. `host.close` runs.
3. During its settle, `host.next('revealing', 0)` runs, then Bob's write is released.

Output: `B bob ack {"status":"accepted","entries":1}`, `B bob reveal [{"answered":false,"points":0,...}]`, `scores ... pxuv4-002: {score:0, answeredScored:0}`, `B stored responses 2`. The response is stored and acknowledged but not scored. The settling run then finds META in `reveal` and returns.

- Impact: A host who double-taps Next or a clicker at time's up can reveal before in-flight answers commit. Those players see 'accepted' and then 'no answer' with 0 points. Their stored response also still appears in live stats and in the CSV export's response rows, which no longer match the scoreboard. The window is the 1 s settle on Lambda.
- Auditor's suggested fix: Make the retry path wait out the settle too. When `retry-reveal` runs and `now < meta.closedAt + revealSettleMs`, sleep the remainder before `#reveal`. Alternatively, have `#reveal` itself wait until `closedAt + revealSettleMs` before reading responses. Add a races.test case for host.next from 'revealing' during the settle.
- Verifier notes:
  - I read the code at 170b09c and the finding holds. I did not run the reproduction because the code path is simple and complete. What the code does: - packages/engine/src/session.ts `advance` returns `{kind:'retry-reveal'}` for phase 'revealing' and leaves meta unchanged. - game-service.ts `#applyEffect` handles 'closing' by cancelling the scheduler, sleeping `revealSettleMs`, then calling `#reveal` (lines 739-742). It handles 'retry-reveal' by calling `#reveal` straight away (lines 744-746). - `#reveal` only checks that phase is 'revealing' with a matching index. It never looks at `closedAt` or waits for the settle. It then runs `listResponses`, computes, and writes the result, the scoreboard, and META 'reveal'. - The answer path (game-service.ts ~540-590) reads META once, checks it with `evaluateAnswer`, calls `putResponse` and acks 'accepted'. It never re-checks META. So an answer that read 'question' before the close but commits after the retry's `listResponses` is stored and acknowledged, but not scored. - When the settling 'closing' run wakes up, `#reveal` sees phase 'reveal' and returns, so nothing re-scores that answer. How a host tab ends up holding 'revealing': - `#transition` sends `host.state` to the requester on a 'none' effect (686-692), so a losing close/next gets 'revealing'. - `nextAction` in apps/web/src/state/commands.ts:46-47 then offers 'Show results' with a live `host.next` command. This is not documented as intended: - ADR-0006 step 2 and ARCHITECTURE.md:82 give the settle's purpose as letting "an answer handler that passed its META check before the close" commit. - The service README (~line 168) does say retry-reveal runs "the reveal without the wait", but it frames retry-reveal as crash recovery ("the next host command re-runs the reveal"). It

### FA-10 (minor) A timer host.close that is lost without an error frame is never retried, even after a reconnect; on Lambda the question stays at 'Time's up'

- Lens: realtime. Files: `apps/web/src/state/driver.ts`, `apps/web/src/state/host.ts`, `apps/web/src/screens/host/useHostSession.ts`
- Evidence: closeSent is cleared in only two cases:
- `unsent`, when Connection.send returned false (driver.ts:194-198).
- `close.refused`, which needs a zqhoot `error` frame with `ref: 'host.close'` (host.ts:473-475).

A reconnect does not clear it. The welcome snapshot for the same question keeps the old driver state (driver.ts:123-125: `if (state.question?.index === q.index) return { state: { ...state, question: q } }`), and `resync` (driver.ts:212-214) only resets the cursor. Lambda has no Scheduler (ws.ts builds GameService without one).

I ran a scratch driver test:

1. sync question 0 (deadline 21000), then tick at 21010. That emits one host.close.
2. resync, then sync with the same question (the reconnect welcome).
3. Tick every 250 ms up to 120000.

Result: 'closes after reconnect 0'.

- Impact: The close can be lost in three ways:
- A frame that Connection.send accepted, sent on a socket that was already dying (Wi-Fi blip at the deadline).
- An invocation that failed outside the service (throttled or timed out), which sends no zqhoot error.
- A close that went through but whose reveal invocation died.

In every case the AWS session never closes the question by itself. The projector shows the 'closing' screen until the host thinks to press 'End question' (then 'Show results'). The VM is unaffected, because its scheduler closes at deadline + grace.

- Auditor's suggested fix: Treat a sent close as unconfirmed until the snapshot leaves phase `question` for that index:
- Clear closeSent on the `resync` after a reconnect.
- Re-send (with the existing backoff) while `now > deadline + some margin` and the snapshot still says `question`.

Add a driver test for the reconnect case.

- Verifier notes:
  - I read the code at 170b09c and the claim holds. **The close is never re-sent (apps/web/src/state/driver.ts)** - Once a tick sends `host.close` (lines 145-151), `closeSent` is true, and `canClose` (line 115) requires `!closeSent`. - `closeSent` is cleared in only two places: - `unsent` (lines 194-198), when `Connection.send` returns false. - `close.refused` (lines 201-209). That input comes only from `host.ts:257-258`, which needs an `error` frame with `ref: 'host.close'`. - A reconnect does not clear it: - `resync` (lines 212-214) resets only `cursor`, `paging` and `nextPollAt`. - A welcome snapshot for the same question index keeps the old state (lines 123-125). - Polling stays off after a close (line 154), so no later stats reply can re-trigger an all-answered close either. **Reconnects do not reset the driver (apps/web/src/screens/host/useHostSession.ts)** - `driver.current = IDLE_DRIVER` runs only when the Connection is re-created, which happens on a change of sessionId, client, auth or epoch (line 93). - Ordinary reconnects inside `Connection` only fire `run({type:'resync'})` (line 161). - I checked the logic directly rather than re-running the auditor's scratch test. The driver is pure and deterministic, so after one timer close, no number of later ticks, resyncs or same-index syncs produces another close. **Nothing on the server closes it instead** - In `packages/service/src/game-service.ts`, the timer close is `this.#scheduler?.scheduleClose` (lines 721-727). The scheduler is omitted on Lambda (`packages/service/README.md`: "omitted (hosts send host.close timer)"). - I found no lazy "overdue question" close in the engine or service. `grep` found only the answer-grace check in `engine/answers.ts:100`. - So on AWS the question stays in phase `question`

### FA-11 (minor) A question broadcast that overtakes the resume welcome makes the player reducer drop the welcome, leaving me/quizTitle unset for that connection

- Lens: realtime. Files: `apps/web/src/state/player.ts`, `packages/service/src/game-service.ts`
- Evidence: How the race happens:
- #resume reads META (`current`) after putConnection, then builds the snapshot (game-service.ts:497-513).
- A concurrent host.next that commits after that read fans `question` (sv+1) out to the new connection. On Lambda that message can arrive before the welcome.
- The reducer applies the question and sets `fresh: false` (player.ts `case 'question'`). It then drops the welcome: player.ts:428 has `if (!state.fresh && msg.snapshot.sv < state.sv) return state;`.
- `me` and `quizTitle` are only ever set from a welcome. Later messages only patch an existing `me` (`me: state.me && {...}`).

A scratch reducer test ran this sequence: connecting, open, question sv 5, welcome sv 4 (Ann), reveal sv 6. It printed `screen get-ready me null title ""` and `after reveal me null`.

- Impact: A phone that opens /play (after join, or on resume) just as the host presses Start or Next plays on with an empty header: no nickname and no running score. This lasts until its next reconnect. The game screens themselves are correct.
- Auditor's suggested fix: When dropping a stale welcome, still take `snapshot.you` (and `quizTitle`/`totalQuestions`) if `me` is null. Keep the stage from the newer broadcast. Add the sequence to player.test.ts.
- Verifier notes:
  - I read the code at 170b09c and the finding holds. Reducer, apps/web/src/state/player.ts: - initialPlayerState (about line 203) starts with me: null and quizTitle: ''. - The `question` case (431-453) sets fresh: false and sv to msg.sv, and never touches me or quizTitle. - The `welcome` case (422-429) returns state unchanged when `!state.fresh && msg.snapshot.sv < state.sv`. - applySnapshot (518-572) is the only place that sets me and quizTitle. reveal, leaderboard and ended only do `me: state.me && {...}`, so a null me stays null. Tracing the auditor's sequence (connecting, open, question sv 5, welcome sv 4, reveal sv 6) gives stage get-ready then reveal, with me null and quizTitle ''. That matches their scratch output. Server side, packages/service/src/game-service.ts #resume (about 480-513): - putConnection completes before the `current` META read. - #playerSnapshot is awaited after that read, and only then is the welcome sent. - A host.next that commits after the read fans out the sv+1 question to the new connection. On Lambda that is a separate invocation doing postToConnection. On the VM it can interleave at any await in the one process. - So the broadcast can reach the client before the welcome. The reducer comment at 424-427 says this race is expected. Existing tests, apps/web/test/player.test.ts 357-406: they cover the stale-welcome case only after an earlier welcome, followed by a reconnect, so me is already set. No test covers the first connection of a page load, where me is null when the stale welcome is dropped. Nothing else in the code handles this case. Impact, apps/web/src/screens/play/PlayerHeader.tsx:23 and PlayScreen.tsx:40: - PlayerHeader renders the nickname and score only when me is set, so the header is blank. - The Lobby eyebrow uses quizTitle

## Acceptance criteria

1. Each decision above is implemented and tested as stated. If you conclude a finding is wrong, don't change code for it. Record it as a deviation with evidence.
2. These pass: `pnpm typecheck`, `pnpm test` (all packages; DynamoDB Local is running on :8000) and `pnpm format:check`.
3. The live games pass on both targets: `pnpm --filter @zqhoot/web test:e2e:live` and `ZQ_E2E_TARGET=lambda-emulator pnpm --filter @zqhoot/web test:e2e:live`.
4. `load/run-local.sh node` meets every gate (join success, answers accepted, delivery). The machine is shared with other test runs, so compare the functional gates, not latency.
5. The engine stays pure: no I/O, clock or randomness. Its coverage does not drop.
6. No changes outside the files you own.
