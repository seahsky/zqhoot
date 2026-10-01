# Wave 1 gate review findings

Independent Opus audit of commit `399c575` with four lenses (contracts, security, conformance, tests); each finding was checked by adversarial verifiers (2 for major/blocker, 1 for minor). 15 reported, 14 kept, 1 refuted.

| #   | Lens        | Severity (auditor → verifiers) | Finding                                                                                                                                                                         | Routed to                      |
| --- | ----------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| G1  | contracts   | major → major, major           | Open-ended reveal payload is unbounded: player `reveal`, `host.state` and the stored RESULT item exceed the 128 KB WebSocket and 400 KB DynamoDB limits at 400 players          | G1-engine-fixes                |
| G2  | contracts   | major → major, minor           | Player reducer applies a welcome snapshot whose sv is lower than state already applied, contradicting ADR-0004; with the specified resume order a newer broadcast gets reverted | G2-web-fixes                   |
| G3  | contracts   | minor → minor                  | A `duplicate` ack followed by an accepted entry truncates the wrong optimistic entries (word cloud shows the duplicate instead of the new word)                                 | G2-web-fixes                   |
| G4  | contracts   | minor → minor                  | Resuming during the reveal phase loses the correct answer for single-choice questions                                                                                           | G1-engine-fixes + G2-web-fixes |
| G5  | security    | major → minor, major           | Open-ended responses shown to players can be traced to their authors: responseId embeds playerId, and leaderboard/podium entries map playerId to nickname                       | G1-engine-fixes                |
| G6  | security    | major → major, major           | Per-IP limit on failed PIN lookups would count CloudFront's IP instead of the player's                                                                                          | G3-aws-client-ip               |
| G7  | security    | minor → minor                  | Word-cloud and open-text entries accept unlimited stacked combining marks (Zalgo)                                                                                               | G1-engine-fixes                |
| G8  | conformance | blocker → minor, major         | Player end screen uses "Game over", a Kahoot string on the do-not-copy list                                                                                                     | G2-web-fixes                   |
| G9  | conformance | major → minor, minor           | welcome snapshot with a lower sv overrides newer state, contrary to ADR-0004 level-triggered rule                                                                               | G2-web-fixes                   |
| G10 | conformance | minor → minor                  | Player who resumes during reveal of a single-choice question is not shown the correct answer                                                                                    | G1-engine-fixes + G2-web-fixes |
| G11 | tests       | major → major, major           | Gallery horizontal-scroll check can never fail on phone-320, phone-390 and tablet-768                                                                                           | G2-web-fixes                   |
| G12 | tests       | minor → minor                  | Ack reconciliation keeps the wrong entries when a duplicate ack is not the last pending send                                                                                    | G2-web-fixes                   |
| G13 | tests       | minor → minor                  | The PlayPage wiring for 'reconnect between questions' is untested                                                                                                               | G2-web-fixes                   |
| G14 | tests       | minor → minor                  | Protocol TIMING values that encode ADR and AWS limits are not pinned by any test                                                                                                | G1-engine-fixes                |

Refuted:

- [tests] Resumed reveal loses the correct answer for single-choice questions; resume test only covers the 'correct' variant: the verifier showed the behaviour is deliberate and tested.

## Details

### G1: Open-ended reveal payload is unbounded: player `reveal`, `host.state` and the stored RESULT item exceed the 128 KB WebSocket and 400 KB DynamoDB limits at 400 players

Files: `packages/engine/src/reveal.ts`, `packages/engine/src/aggregate.ts`, `packages/engine/src/views.ts`, `packages/protocol/src/play.ts`, `packages/store/src/dynamo.ts`, `docs/adr/0004-wire-protocol.md`

Impact: On AWS, a 400-player open-ended question overflows host.state (and the presenter's reveal) once answers are long: one 200-character answer per player is enough. A player `reveal` overflows with two 100-character answers each. PostToConnection rejects the payload, so players are left on "Time's up" and hosts miss the result. That breaks the 400-player requirement for this question type. With three long non-ASCII entries per player, the RESULT write itself fails. META then stays in `revealing` and every retry fails the same way, so the session is stuck. The player web UI does not render open responses at all (Reveal.tsx), so the bytes sent to 400 phones are wasted.

Fix: Bound the reveal payload. Drop `responses` from player reveals: add a player-specific result variant, or send an empty list, since phones do not render it. Give hosts the same paged/cursor treatment LiveStats already uses (the presenter fetches pages via host.stats), or cap to the newest N visible responses plus a count. Store open responses out of the RESULT item: they already exist as RESP# items, so keep only counts and moderation deltas in RESULT. Add an engine test that asserts the serialized size of reveal, host.state and the stored result stays under 128 KB and 400 KB at maximum limits. Correct the 20 KB claim in ADR-0004.

### G2: Player reducer applies a welcome snapshot whose sv is lower than state already applied, contradicting ADR-0004; with the specified resume order a newer broadcast gets reverted

Files: `apps/web/src/state/player.ts`, `docs/adr/0004-wire-protocol.md`, `docs/tasks/W2-service.md`

Impact: A player who reconnects while the host opens a question falls back to the lobby screen for that whole question and cannot answer. A reconnect storm when phones wake as the presenter advances is exactly the case ADR-0008 designs for. The same race after a `reveal` or `ended` broadcast throws the player back to an earlier phase until the next transition. The unit test (player.test.ts:318) enshrines this behaviour, so the contract drift is untested in the ADR's direction.

Fix: Honour sv for snapshots as well, but scope the check to the current connection. The reducer tracks the highest sv received since the latest (re)connect (reset it on the `connection` action entering `connecting` or `reconnecting`). It applies a welcome only when snap.sv is at least that per-connection maximum. That keeps the VM-restart rollback case (the first welcome on a fresh connection still wins over older-connection state) while rejecting a stale welcome that loses the race to a broadcast. Alternatively, make the W2-service spec read meta after putConnection and re-read it if the version changed before sending. Update ADR-0004 or ADR-0008 to state the chosen rule.

### G3: A `duplicate` ack followed by an accepted entry truncates the wrong optimistic entries (word cloud shows the duplicate instead of the new word)

Files: `apps/web/src/state/player.ts`

Impact: The player's list of sent words is wrong ('cat, cat'), and 'dog' seems lost until a resume snapshot corrects it. The remaining count is right, so this is a display-only error in an edge case: sending the same word twice, or two case variants of it, while acks are in flight.

Fix: On a `duplicate` ack, remove that specific optimistic entry: the oldest pending one, as rejectOldestPending already does for refusals. Do not keep it and rely on a later slice. Then the list holds only confirmed and still-pending entries in order. Add this sequence to player.test.ts.

### G4: Resuming during the reveal phase loses the correct answer for single-choice questions

Files: `apps/web/src/state/player.ts`, `packages/engine/src/views.ts`, `packages/protocol/src/play.ts`

Impact: A player whose phone locked during a question and who reconnects on the reveal (a common path per ADR-0008), or who reloads or joins during the reveal, sees "Not this time" without being told the right answer. True/false is unaffected.

Fix: In applySnapshot, keep the held run's PublicQuestion when its index equals snap.questionIndex. Better, add the PublicQuestion (already public at reveal) to PlayerSnapshot in phase reveal, e.g. `reveal.question`, and have buildPlayerSnapshot fill it.

### G5: Open-ended responses shown to players can be traced to their authors: responseId embeds playerId, and leaderboard/podium entries map playerId to nickname

Files: `packages/engine/src/answers.ts`, `packages/engine/src/reveal.ts`, `packages/engine/src/views.ts`, `packages/protocol/src/play.ts`

Impact: In any quiz that mixes scored questions with an open-ended question, a player who opens browser devtools can see who wrote each supposedly anonymous open-ended answer shown on screen, for every author in the current top 5 (and the final podium). The engine strips nicknames from player results precisely to prevent this. The same ids also appear in the paged host stats cursor, which is harmless there, but the player path defeats the intended anonymity.

Fix: Stop exposing the storage key in player-bound results. In toPlayerResult, replace `id` with an opaque value that does not contain the playerId, such as the response's position in the sorted list or a per-question index. Alternatively, change responseId to a random id stored on the ResponseRecord; the store's setResponseStatus would then need another way to find the item than splitting `{playerId}-{slot}`. Add a secrecy test asserting that no player-bound open-ended response id contains any playerId.

### G6: Per-IP limit on failed PIN lookups would count CloudFront's IP instead of the player's

Files: `infra/terraform/modules/static-site/main.tf`, `docs/tasks/W2-server-lambda.md`, `docs/adr/0013-security.md`

Impact: (a) All players behind the same CloudFront edge IPs share one 30-per-minute bucket of failed lookups. PIN typos from a large class, or from unrelated users of the same edge, lock out legitimate joiners. A single attacker can also burn the bucket on purpose. (b) An attacker enumerating PINs is limited per edge IP rather than per client, and can choose between the CloudFront path and the direct execute-api endpoint to get separate buckets. The ADR-0013 brute-force control does not work as specified on the AWS target.

Fix: Choose an explicit client-IP source for the AWS HTTP path and write it into both the infra and the W2-server-lambda spec before that adapter is built:

- Infra: forward a viewer-address header by using an origin request policy that includes CloudFront-Viewer-Address (a managed policy that includes CloudFront headers, or a custom policy that whitelists it).
- Adapter: read that header, falling back to the last X-Forwarded-For entry that CloudFront appended.
- Direct calls to the execute-api endpoint then need their own handling, for example ignoring forwarded headers there, or rejecting requests that do not come through CloudFront.
  Add a Terraform test that /api/* forwards the chosen header.

### G7: Word-cloud and open-text entries accept unlimited stacked combining marks (Zalgo)

Files: `packages/engine/src/text.ts`, `packages/engine/src/nickname.ts`

Impact: Word-cloud entries are stored `visible` with no moderation step (ADR-0006) and go straight into live stats and the reveal shown on the presenter. One player can post a word whose diacritic tower spills over neighbouring words on the projector and on every phone's reveal. The profanity filter does not catch it.

Fix: Apply the same anti-stacking check (hasZalgo / MAX_MARKS_PER_BASE) inside normalizeWord and normalizeOpenText, rejecting the entry (returning null gives ack reason `invalid`), and add tests next to the existing nickname Zalgo tests.

### G8: Player end screen uses "Game over", a Kahoot string on the do-not-copy list

Files: `apps/web/src/screens/play/Ended.tsx`, `apps/web/src/screens/play/announce.ts`, `apps/web/src/dev/manifest.ts`

Impact: Violates hard requirement 6 (no Kahoot/Mentimeter copy) and ADR-0016. The string appears on every player's phone at the end of every game.

Fix: Replace it with original copy, such as 'Final results' or 'That\'s a wrap', in Ended.tsx, announce.ts and the gallery title. Add the kahoot.md section 11 and mentimeter.md section 9 strings ('Game over', 'Play again', 'Spin!', 'Please wait for the presenter', 'Presentation is closed', ...) as case-insensitive patterns in source-scan.test.ts so they cannot come back.

### G9: welcome snapshot with a lower sv overrides newer state, contrary to ADR-0004 level-triggered rule

Files: `apps/web/src/state/player.ts`, `apps/web/README.md`, `docs/adr/0004-wire-protocol.md`

Impact: A player who reconnects at the moment the host opens a question (common, since phones wake when the host advances) falls back to the lobby screen. That player sees no question and cannot answer until the next broadcast (the reveal), so they lose that question's points. This breaks ADR-0004's guarantee that ordering between concurrent invocations does not matter.

Fix: Apply a welcome snapshot only when `snap.sv >= state.sv`, or when the stage is 'connecting' or the connection has just reopened and no higher-sv message has arrived since the hello. To cover the VM-restart rollback the README cites, reset `sv` on socket open, before the hello, instead of on every welcome, so only messages on the new connection compete. Alternatively, amend ADR-0004 and make the service re-read META after putConnection. Either way, record the decision in the ADR, not only in the web README.

### G10: Player who resumes during reveal of a single-choice question is not shown the correct answer

Files: `packages/engine/src/views.ts`, `apps/web/src/state/player.ts`

Impact: After a resume in the reveal phase, a player who answered a single-choice question wrongly sees 'Not this time' with no 'The correct answer was ...' card, while connected players do see it. The state is inconsistent but low impact.

Fix: Include the public question (`toPublicQuestion`) in the reveal-phase PlayerSnapshot. It is an additive optional field, so no version bump is needed. Use it in applySnapshot. Alternatively, have the result carry the correct option's text.

### G11: Gallery horizontal-scroll check can never fail on phone-320, phone-390 and tablet-768

Files: `apps/web/e2e/helpers.ts`, `apps/web/playwright.config.ts`

Impact: The brief requires every view to work from 320x568 phones up. The spec's automated guard for that (W1-web-a acceptance 1b) catches nothing on any phone or tablet project. It only runs meaningfully at 1366 px and wider, where overflow is least likely. Any later overflow regression on a phone, including from web-b's host and editor screens that reuse this helper, will ship green.

Fix: Measure against the real viewport: `expect(scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth)`, or compare with `testInfo.project.use.viewport.width` or `visualViewport.width`. Add a self-test: a gallery-only screen with a deliberately over-wide element that must fail the check on phone-320. That keeps the check honest.

### G12: Ack reconciliation keeps the wrong entries when a duplicate ack is not the last pending send

Files: `apps/web/src/state/player.ts`, `apps/web/test/player.test.ts`

Impact: When word-cloud or open entries are sent faster than acks return (slow mobile uplink, Lambda cold start), the 'submitted entries listed' panel can show an entry the server discarded and hide one it stored. The remaining-entries count still matches, so only the list is wrong. Low impact, but it is a critical client path with no test for interleaved accepted and duplicate acks.

Fix: Acks answer the oldest pending send in order, so on a `duplicate` ack remove the oldest pending entry (splice at `responses.length - pending`), as rejectOldestPending already does, instead of trimming the tail. Add reducer tests for [accepted, duplicate, accepted] and for [accepted, accepted] with entries 1 and then 2.

### G13: The PlayPage wiring for 'reconnect between questions' is untested

Files: `apps/web/src/screens/play/PlayPage.tsx`

Impact: ADR-0008 requires the 110-minute proactive reconnect to happen between questions. The Connection class honours the callback and is well tested, but a regression in the only production caller would reconnect mid-question. The player then gets an 'offline' refusal or a delayed answer, and nothing would flag it. This only affects sessions longer than 110 minutes.

Fix: Extract the predicate (screen to may-reconnect) and unit-test it. Alternatively, add a flow.spec case that installs Playwright's clock, advances past plannedReconnectMs while a question is open, and asserts no new socket until the reveal.

### G14: Protocol TIMING values that encode ADR and AWS limits are not pinned by any test

Files: `packages/protocol/src/limits.ts`, `packages/protocol/test/common.test.ts`

Impact: A tuning edit can break a hard platform limit or fairness rule with no test failing. With heartbeatIdleMs of 10 minutes or more, API Gateway closes every quiet player socket between questions. With minLead below the Lambda fan-out time, players see options at different instants, which undermines server-authoritative fairness.

Fix: Add a protocol test that asserts the invariants rather than copying the values: heartbeatIdleMs + pongTimeoutMs < 10 min, plannedReconnectMs + 60 x 5 s < 2 h, minLeadMs.lambda >= 1500, and fullPointsWindowMs < the smallest time limit. Pin answerGraceMs to the ADR-0005 value.
