# Real-time patterns for zqhoot: fan-out, answer bursts, reconnect, fairness, limits, nicknames

Accessed: 2026-09-29. Scope: a 400-player live quiz on (a) AWS API Gateway WebSocket + Lambda + DynamoDB and (b) one Node.js process with `ws` and an in-memory store, both driving one pure game engine.

## How to read the citations

- `P<n>` = **[primary]** source (official docs, library README or source, vendor blog, bug tracker, npm registry). `S<n>` = **[secondary]** source (third-party repo, blog, forum, another agent's research file). Numbers refer to the Sources list.
- **Inference:** marks my own reasoning. **Unverified (background knowledge)** marks memory that no source backed. **Not verified** lists what I searched for and could not confirm.
- Evidence limits. `docs.aws.amazon.com`, `aws.amazon.com`, `developer.mozilla.org`, `webkit.org`, `bugs.webkit.org`, `rfc-editor.org`, `w3c.github.io`, `web.dev`, `caniuse.com` and `npmjs.com` were blocked, and the session-wide WebSearch budget (200 calls) ran out mid-task. AWS facts therefore come from: (i) archived `awsdocs` GitHub snapshots (API Gateway 2023-04-03, DynamoDB 2021-09-07, Lambda 2022-06-10) and botocore API models, read verbatim but possibly stale; (ii) current AWS pages known only through the search tool's summary, marked "search summary" (official page, body not read). MDN and web.dev text was read from their GitHub source repos.

## Key findings

1. `ws` writes a server-side `Buffer` payload to each socket without copying it (`mask: false`); a string has its byte length recomputed on every send [P4]. Pre-serialise once, and pass `{ binary: false }` if clients expect text frames [P3].
2. `perMessageDeflate` is off by default; the README warns of significant CPU/memory cost and "catastrophic memory fragmentation" [P1][P2]. Keep it off.
3. `ws` `maxPayload` defaults to 100 MiB [P2]; API Gateway caps a frame at 32 KB and a message at 128 KB [P7]. Set `maxPayload` to a few KB.
4. The API Gateway management API has three operations (PostToConnection, GetConnection, DeleteConnection): fan-out is one POST per connection [P12]. The AWS sample scans a table, uses `Promise.all`, and deletes rows on HTTP 410 [P5].
5. All APIs in an account and Region share a 10,000 RPS throttle (bucket 5,000) that includes WebSocket callback APIs [P7]. **Inference:** about 25 simultaneous 400-recipient broadcasts would exhaust it.
6. For 400 recipients, one Lambda with a bounded pool of about 25-50 is enough; SDK v3 defaults to `keepAlive: true, maxSockets: 50` [P22]. Worker Lambdas or SQS matter at thousands of connections [S1][S2].
7. One DynamoDB item per (question, player) with `attribute_not_exists` gives idempotency and first-answer-wins. A failed conditional write still consumes WCU [P15]; `ReturnValuesOnConditionCheckFailure: ALL_OLD` returns the stored item for free [P14].
8. A partition tops out at 1,000 WCU/s [P15][P16]. 400 small answers in 2 s is about 200 WCU/s: no sharding, no counter item; aggregate with one strongly consistent Query at reveal [P14].
9. Touch the session item only on phase transitions, with a version or state compare-and-set. Never on join, answer, heartbeat or reconnect.
10. Mobile sockets die. WebKit closes a WebSocket ("WebSocket is closed due to suspension.") when a page enters the back/forward cache [P34]; Socket.IO lists Wi-Fi to 4G switches and frozen tabs as normal disconnect causes [P45]. Use snapshot-on-reconnect with full-jitter backoff [P27].
11. Browsers have no WebSocket ping API [P35]; API Gateway idles out after 10 minutes and ends connections after 2 hours [P7]. Use application-level heartbeats.
12. Screen Wake Lock: Chrome for Android 84 (caniuse: 85 without a flag); Safari and iOS Safari 16.4, partial in Home Screen web apps until 18.4 [P40][P41]. It is released when the page is hidden [P39].
13. Fairness: client-measured elapsed time, bounded above and below by server wall time, removes downlink jitter. The lower bound matters because `performance.now()` can pause during sleep [P47]. Kahoot's timing method is Not verified.
14. `timesync` exists (1.0.11) but was last published 2022-09-05 [P50]; its algorithm is about 30 lines [P49]. Clock sync is needed only for a shared "opens at T" display.
15. Nicknames: `obscenity@0.4.6` (MIT, zero deps, confusable/leet/repeat transformers) [P50][P51][P52] behind our own NFKC and invisible-character stripping; its tracker shows open invisible-character and spaced-word evasions [P53].

## 1. Fan-out to 400 clients

### 1a. Single Node process with `ws`

- **Broadcast idiom.** The README loops `wss.clients` and sends when `readyState === WebSocket.OPEN` [P1].
- **No payload copy.** In `Sender.frame`, `merge` is true only when `options.mask` is set, so a server allocates only a header and writes `[header, data]` between `cork()`/`uncork()` [P4]. `Sender.send` calls `Buffer.byteLength(data)` for each string send [P4]. **Inference:** the socket then also encodes the string per recipient.
- **Text vs binary.** `send()` sets `binary: typeof data !== 'string'` unless overridden [P3], so a pre-encoded `Buffer` goes out as a binary frame unless you pass `{ binary: false }`.
- **Inference:** `const buf = Buffer.from(JSON.stringify(msg))` once, then `ws.send(buf, { binary: false })` per socket. Per-player messages (own score, rank) cannot be shared: send the shared payload once and a tiny per-player message.
- **Backpressure.** `bufferedAmount` is "the number of bytes of data that have been queued using calls to `send()` but not yet transmitted" [P2], computed as socket writable length plus sender buffered bytes [P3]. `send` accepts a callback that receives an error on failure [P2]. **Inference:** skip or `terminate()` a socket whose `bufferedAmount` exceeds a threshold (64-256 KB); state messages are level-triggered, so dropping a slow client's stale update is safe. `ws` documents no such policy.
- **Compression.** Disabled by default on the server [P2]. When enabled each socket compresses its own copy (`perMessageDeflate.compress` in the per-socket sender [P4]). `concurrencyLimit` defaults to 10 and `threshold` to 1024 bytes, but the threshold applies only "if context takeover is disabled" [P2]. The README advises a representative load test before production use [P1]. **Inference:** sub-KB messages to 400 sockets gain little bandwidth for real CPU and memory cost.
- **Heartbeat.** The README pattern pings every 30 s, marks `isAlive=false`, and terminates sockets that miss a pong; pongs are automatic [P1].

### 1b. Lambda + API Gateway

- **Management API.** Three operations only: `PostToConnection`, `GetConnection`, `DeleteConnection` [P12], called as `POST/GET/DELETE .../@connections/{connection_id}` [P9]. Errors: `GoneException` ("connection ... no longer exists"), `LimitExceededException` ("more than the allowed number of requests per unit of time or the WebSocket client side buffer is full"), `PayloadTooLargeException` [P12].
- **AWS sample.** `sendmessage` scans the connections table, maps rows to `PostToConnectionCommand`, awaits `Promise.all`, and on `statusCode === 410` deletes the row [P5]. Its README gives no scale guidance [P6].
- **Await before returning.** A community write-up reports un-awaited broadcast promises being cancelled when a real Lambda handler returned (search summary) [S5].
- **Pool size.** SDK v3's Node handler builds agents with `keepAlive = true; maxSockets = 50` [P22]. **Inference:** a larger pool queues on sockets unless you supply your own agent. With pool `c` and per-call latency `L`, the last recipient trails the first by about `ceil(400/c) x L`. PostToConnection latency is Not verified; measure it.
- **Account throttle.** 10,000 RPS, bucket 5,000, shared across HTTP, REST, WebSocket and WebSocket callback APIs [P7]. **Inference:** each recipient is one request against it. On `LimitExceededException`, retry after a few hundred ms with exponential backoff and jitter (search summary) [S4].
- **Bigger designs.** One sample spreads connections over 2,500 DynamoDB partitions and 10 SQS queues, with 250 concurrent Lambdas and 1,000 connections per invocation [S1]. Another reports 15 ms for 100 recipients and 59 ms for 1,000 from one Scan plus `Promise.all`, and calls about 1,000 users the limit of that pattern; whether it hit real API Gateway is not stated [S2].
- **Lambda limits (2022 snapshot).** Default concurrency 1,000; burst 500-3,000 by Region; async payload 256 KB [P21]. Worker fan-out spends that concurrency; SQS adds queue latency (SQS quotas Not verified: archived docs are stubs).
- **GoneException cleanup.**
  - The sample deletes the row on 410 [P5]; the AWS announcement and knowledge-center pages describe the same practice (search summaries) [P23][P24]. The knowledge center also suggests `GetConnection` before posting [P23]; **Inference:** that doubles calls in a broadcast.
  - `$disconnect` is "best-effort ... cannot guarantee delivery" [P10], so 410-driven cleanup is required.
  - DynamoDB TTL deletes "typically within two days" and expired items still appear in reads (search summary) [P20]; filter on `expiresAt`.
  - **Inference:** on 410, clear `connId` conditionally (`connId = :old`) so a newer reconnect is not clobbered.

### 1c. Managed pub/sub, briefly

- **AppSync Events:** serverless WebSocket pub/sub with channel namespaces, removing connection and fan-out management [P25]. Search-summarised quotas: 5 events per HTTP publish, 25 publishes/s per WebSocket, 240 KB per event, 2,000 connection requests/s, $1.00 per million operations [P25]. **Inference:** a 400-recipient broadcast is about 400 outbound operations, roughly $0.0004.
- **IoT Core (MQTT over WebSockets):** $0.08 per million connection-minutes, $1 per million messages (first billion), account limit 20,000 publishes/s (2,000 in some Regions) (search summary) [P26]. Prices Not verified against live pages.
- **Inference:** both remove the fan-out loop and 410 handling but add an auth model, cannot serve the Node target, and need per-player channels for private messages. Skip for v1; keep transport behind an interface.

## 2. Answer-burst handling (400 answers in about 2 s)

- **Item design.** `PK = S#<code>#Q#<n>`, `SK = P#<playerId>`, attributes `choice`, `recvAt`, `claimedElapsedMs`, `ttl`. Write with `PutItem` and `ConditionExpression: attribute_not_exists(PK)`.
  - AWS: this "will only succeed if no matching item exists" [P14]. A failed put raises `ConditionalCheckFailedException` [P15], so the first answer wins and retries are harmless.
  - It still consumes WCU: one for a missing item, or the existing item's size in KB [P15] (also covered by an AWS blog, search summary [P19]).
  - `ReturnValuesOnConditionCheckFailure: ALL_OLD` returns the stored item and consumes no read capacity [P14], so a duplicate can be acknowledged with the original answer.
- **No counter item.** Atomic counters (`UpdateItem` ADD) are not idempotent [P15]; a single small item is bounded by one partition's throughput [P17]. AWS's remedy is write sharding: a random or calculated key suffix, then Query every suffix and merge [P15]. Aggregating by Query at reveal avoids counters entirely.
- **Partition limit.** Traffic per partition must stay under 3,000 RCU and 1,000 WCU [P15][P16]. Adaptive capacity boosts hot partitions but not past the partition maximum [P15][P16]. The 2021 guide says DynamoDB keeps up to 300 s of unused capacity as burst, subject to change [P15]. New on-demand tables start at up to 4,000 writes/s (search summary) [P16].
- **Arithmetic (Inference).**
  - 400 items of 1 KB or less is 400 WCU: 200 WCU/s over 2 s, a fifth of 1,000. Even 400 writes in 0.5 s (800/s) fits; mobile jitter alone spreads arrivals over hundreds of ms.
  - Different partition-key values hash to (potentially) different partitions [P15].
  - Throttled writes surface as errors: retry with jittered backoff [P27].
  - If sessions grow to thousands of players, shard the key (`#0..#7` by `hash(playerId) % 8`) and Query all shards.
- **Reveal aggregation.** `Query` returns all items under one partition-key value, at most 1 MB per page, with `LastEvaluatedKey` for pagination; capacity is based on item size, not projection or filter [P14]. Use `ConsistentRead: true` so late writes are included [P14]. **Inference:** 400 small items fit in one page.
- **Live "N answered" (Inference).** Poll `Select: COUNT` every 1-2 s (same capacity as a read [P14], tiny volume), or use a sharded counter [P15], or count acks in the engine.
- **No session read on the hot path (Inference).** Store `recvAt` per answer and apply deadline plus grace when scoring at reveal, so 400 Lambdas never read the session item. Accept-then-filter is safe because correct answers leave the server only at reveal.
- **Timestamp source.** WebSocket integration context exposes `requestTimeEpoch` (ms), `connectedAt`, `messageId`, `identity.sourceIp` [P11]. **Inference:** prefer `requestTimeEpoch` to Lambda's `Date.now()`, which a cold start delays. Whether it is the message-receipt instant is Not verified.
- **Cold starts (Inference).** A new instance is created when all are busy [P21], so 400 simultaneous answers need about 400 instances, possibly cold. Use provisioned concurrency if this matters.
- **Node target.** `Map<questionId, Map<playerId, Answer>>`, set only if absent. The event loop runs one handler at a time, so check-then-set needs no lock (Unverified background). Reveal iterates the map.
- **Shared engine contract (Inference).** Store interface: `putAnswerIfAbsent()`, `listAnswers()`, compare-and-set `transition()`, identical semantics in both adapters.

## 3. Avoiding write contention on the session item

- **Optimistic concurrency.** Keep `version`; write with `ConditionExpression: version = :v` and `SET version = :v + 1`; on `ConditionalCheckFailedException` re-read and re-decide (search summary) [P18]. The 2021 guide shows the conditional-write pattern and notes a conditional write is idempotent when the check is on the attribute being updated [P15]. Global tables are last-writer-wins, so versions do not protect across Regions [P18].
- **Prefer a state guard (Inference).** `phase = :expected AND qIndex = :n` makes a host's double-click on "next" fail harmlessly.
- **Transitions that touch the session item (Inference):** create, open lobby, start, open question (`qIndex`, `openAt`, `deadline`), close/reveal, next, end. One writer each (host or timer), so conflicts are rare.
- **Transitions that must not:**
  - Join: write a `PLAYER` item.
  - Answer: write an answer item.
  - Heartbeat, connect, disconnect, reconnect: update only the `PLAYER` item's `connId` and `lastSeen`.
  - Scores: update `PLAYER` items at reveal, guarded by `lastScoredQ < :q` because ADD-style counters are not idempotent [P15].
- **Reads.** Reconnect needs one strongly consistent `GetItem` of the session plus one of the player. The recipient list is one `Query` on the session partition for `P#` items, not a table Scan as in the sample [P5].
- **Timers (Inference).** No process stays alive on Lambda: close by scheduled invocation or host message, and treat `now > deadline` as closed on read.

## 4. Reconnect and resume on mobile

### What happens to sockets

- **Visibility.** `visibilityState` is `hidden` for background tabs, minimised windows, and when "the OS screen lock is active" [P30]. `visibilitychange` fires when the user switches app on mobile and is "the last event that's reliably observable" [P29].
- **`pagehide` is unreliable** "especially on mobile" [P32]; `pageshow` also fires on "restoring a frozen page on mobile OSes" and bfcache restores [P31].
- **WebKit closes bfcache-bound sockets.** `WebSocket::suspend` with reason `BackForwardCache` calls `channel->fail("WebSocket is closed due to suspension.")`; other reasons call `channel->suspend()` [P34]. **Inference:** reconnect on `pageshow` when `persisted` is true.
- **Chrome/bfcache.** web.dev says some browsers will not cache pages with an open WebSocket, and advises closing on `pagehide`/`freeze` and reopening on `pageshow`/`resume` [P33]. The source was last updated 2023-05-25; re-check current behaviour.
- **Timers.** Chrome throttles hidden-tab timers after 10 s, Firefox after 30 s, but tabs using WebSockets or WebRTC "go unthrottled" [P28]. Socket.IO v2 heartbeats still timed out in throttled tabs, and Socket.IO lists "switch from WiFi to 4G" and "the browser itself may freeze an inactive tab" among normal disconnect causes [P45].
- **iOS specifics.** One user issue says "iOS Safari suspends a backgrounded tab and tears down the WebSocket on sleep/app-switch" [S7]; another reports a desktop background-tab drop after about 5 minutes [S6]. Exact iOS and Android Chrome lifetimes are Not verified.
- **Wi-Fi to cellular.** `navigator.onLine` is "inherently unreliable" [P36]; the Network Information API is absent in Safari and iOS Safari [P37]. **Inference:** rely on heartbeat timeout; use `online` only as a "retry now" hint.

### Heartbeats and API Gateway

- **Limits.** 10-minute idle timeout, 2-hour connection duration, neither adjustable [P7]. The management API has no ping operation [P12]. A re:Post summary says API Gateway does not send server pings but answers client ping frames [S3]. Whether a server PostToConnection resets the idle timer is Not verified.
- **Browsers can't ping.** The `WebSocket` interface has only `send()` and `close()` [P35].
- **Inference:** client `{"t":"ping"}` every 2-4 minutes, a timeout after about 2 missed pongs, and a planned reconnect before 2 hours.
- **Reference.** Socket.IO's heartbeat uses `pingInterval: 25000`, `pingTimeout: 20000`, server pings and client pongs [P43].

### Backoff

- **Full jitter.** The AWS Architecture Blog compares Full, Equal and Decorrelated Jitter: equal jitter is "the loser", full jitter does less work than decorrelated at slightly more time, and jitter "should be considered a standard approach for remote clients" (search summary) [P27]. Formula: Unverified (background knowledge): `sleep = random(0, min(cap, base * 2^attempt))`.
- **Reference defaults.** Socket.IO client: `reconnectionDelay` 1000, `reconnectionDelayMax` 5000, `randomizationFactor` 0.5 [P46].
- **Inference:** full jitter, base 500 ms, cap 8-10 s, unlimited attempts, reset after 10 s stable. On `visibilitychange` to visible or `pageshow`, retry once after 0-500 ms random delay: classroom phones wake together and API Gateway allows 500 new connections/s per account per Region [P7].

### Resume design

- **Token.** `sessionStorage` is per tab, survives reloads and restores, clears on tab close, and can throw `SecurityError` [P38]. **Inference:** store `{sessionCode, playerId, resumeToken}` in `sessionStorage` with a `localStorage` fallback (try/catch both); the token is a random secret checked server-side.
- **Snapshot beats replay.** Socket.IO's recovery stores an offset per packet but "will not always be successful" and you must still handle resync [P42]; its default is at-most-once and the server keeps no buffer [P44]. **Inference:** with about 1 KB of state, make every server message a level-triggered snapshot (`{qIndex, phase, ...}`); on `hello{token, lastSeq}` reply with a full snapshot (question, time left, the player's answer and score); clients drop messages older than their current phase. No replay buffer is needed, which suits Lambda. Derive `seq` from `(qIndex, phase)`; never write per message.
- **Screen Wake Lock.** Chrome/Chrome Android 84 per MDN BCD (caniuse: 84 flagged, 85 default), Samsung Internet 14, Firefox 126, Safari and iOS Safari 16.4 [P40][P41]. On iOS 16.4-18.3 it "does not work in standalone Home Screen Web Apps" (WebKit bug 254545); full support from 18.4 [P40]. HTTPS only, released when the document is not visible, re-request on `visibilitychange` [P39]. **Inference:** request it during play, but it does not stop a manual lock or app switch.

## 5. Latency fairness in timed scoring

**Bias (Inference).** Server-measured time is `downlink + think + uplink`. Downlink includes the recipient's fan-out position: on Lambda the 400th trails the first by about `ceil(400/c) x L` (section 1b); on Node the send loop is tiny next to mobile jitter.

| Approach | Removes | Weakness |
|---|---|---|
| (a) Per-connection sent-at on server | Fan-out position | Sent-at is not client receipt; PostToConnection success or a `send` callback is not a client ack. Needs 400 extra writes or an ack round trip. |
| (b) Client elapsed, server-bounded | Downlink and most uplink jitter | Client untrusted; needs two-sided bounds. |
| (c) Shared "opens at T" announced ahead | Fan-out position, downlink variance | Needs clock offset (section 6); question text must be withheld until T to avoid early reading. |
| (d) Grace window | Rejection of slow legitimate answers | Fixes rejection, not ranking. |

**Recommendation (Inference): (b) + (c).**

1. Broadcast the question with `openAt` (server epoch ms) a few hundred ms ahead (at least the p99 fan-out spread). Clients display at `openAt` via their clock offset and start `performance.now()` on display.
2. The client sends `elapsedMs`. The server computes `wall = recvAt - openAt`. Since `wall = uplink + elapsed_true`, require `wall - maxUplink <= elapsedMs <= wall` and score the clamped value.
3. The lower bound stops impossibly fast claims and catches a timer paused in sleep: MDN says `performance.now()` should tick during OS sleep but only Windows browsers do [P47].
4. Subtract half the measured RTT (section 6) from `wall` to narrow the band.
5. Grace of about 1 s governs acceptance only. Take `recvAt` from API Gateway's `requestTimeEpoch` and `openAt` from the same service to avoid mixing clocks.

**Kahoot and similar.**
- The other agent's research file, from a search summary of Kahoot's "How points work", reports `round((1 - ((response time / question timer) / 2)) x points possible)` with full points for correct answers under 0.5 s [S10]. Whether Kahoot times on client or server is Not verified [S10]. **Inference:** the 0.5 s bypass may be latency tolerance.
- Two third-party cheat tools hint at client influence: KaHack offers "Answer Speed" and warns not to set its points slider above 987 "because that's how Kahoot calculates the points" [S8]; `kahoot-rand` joins many times with random answers [S9]. **Inference:** anecdotal; I did not read the tools' code.

**Cheating risks of client timestamps (Inference).** Forged send times, paused timers, replayed fast answers, multi-account flooding [S9]. The two-sided bound plus one accepted answer per (question, player) confines each to the tolerance band.

## 6. Clock sync over WebSocket

- **Algorithm.** Client stamps send time, server returns its time, offset is server time minus (receive time minus rtt/2) [P48][P49]. `timesync`'s README quotes: probe 5 or more times, sort by latency, keep samples within about one standard deviation of the median, average [P48].
- **Its code.** `offset = timestamp - end + roundtrip / 2`; drops results with `roundtrip >= median + std`; averages the rest [P49]. Defaults: `repeat: 5`, `delay: 1000` ms, `timeout: 10000` ms, `now: Date.now`, hourly resync [P48].
- **Status.** `timesync` 1.0.11, MIT, last published 2022-09-05 [P50]. A monotonic clock survives sleep better than `Date.now` [P47].
- **Min-RTT variant (Inference).** Take the lowest-RTT sample; the error is bounded by half that RTT because one-way delays may be asymmetric. Attribution to Cristian (1989): Unverified (background knowledge).
- **Mobile accuracy.** Not verified; no source with measured cellular or Wi-Fi numbers. **Inference:** with RTT of tens to low hundreds of ms, expect roughly 10-50 ms at best, worse on asymmetric cellular.
- **Recommendation (Inference).** About 30 lines of client code: 8 probes 200-300 ms apart over the game socket, keep the min-RTT sample, resync on reconnect and every few minutes. Use for `openAt` display alignment and RTT, never for scoring authority.

## 7. Rate limiting and abuse protection

- **Duplicates** are harmless: the conditional put fails [P14][P15], but failures still cost WCU [P15], so add a cheap per-connection budget (Inference).
- **Node.** Set `maxPayload` (default 100 MiB [P2]) to about 4 KB; add an in-memory token bucket per socket (say 5 msgs/s, burst 10); close abusers with code 1008 (Inference); validate every message with `zod` before the engine.
- **API Gateway.** Throttling is a token bucket applied "on a best-effort basis ... targets rather than guaranteed request ceilings" at account, stage and route level [P8]. WebSocket route throttling is set per route, e.g. `aws apigatewayv2 update-stage --route-settings '{"messages":{"ThrottlingBurstLimit":100,"ThrottlingRateLimit":2000}}'` [P8], via `DefaultRouteSettings` and `RouteSettings` with `ThrottlingBurstLimit`/`ThrottlingRateLimit` [P13]. Route limits cannot exceed the account limit (10,000 RPS, bucket 5,000) [P7][P8]. These are per route, not per client; I found no per-connection or per-IP throttle for WebSocket APIs (Not verified).
- **Per-IP joins on Lambda (Inference).** `$connect` is documented as the place to "throttle connections or control who connects" [P10] and exposes `identity.sourceIp` [P11]. Use a DynamoDB counter `RL#<ip>#<minute>` with TTL.
- **Shared NAT (Inference).** A classroom may share one public IP: a per-IP join cap must exceed session capacity. Use a per-session join cap of 400 and per-IP PIN-guess limits.
- **Connections and size.** 500 new connections/s per account per Region [P7]; reconnect storms share it, hence full jitter. Frame 32 KB, message 128 KB, larger frames close with code 1009 [P7]. Validate at about 4 KB.
- **Join abuse is real.** A Kahoot reverse-engineering repo has a "flood" tool that joins arbitrarily many times and a "rand" tool that answers randomly from many joins [S9].
- **WAF.** A Regional web ACL can be associated with an API Gateway stage and supports per-client-IP rate-based rules [P62]. Whether WebSocket stages are supported is Not verified.

## 8. Nickname filtering

### Rules

1. **NFKC first.** NFKC is "Compatibility Decomposition, followed by Canonical Composition" [P58]. Locally it folds fullwidth letters, ligatures, mathematical bold, circled letters and long s to ASCII [P61].
2. **Cross-script confusables survive NFKC.** Cyrillic U+0430 and Greek omicron are unchanged [P61]. Unicode confusables data maps `0430 -> 0061` [P59]. Use a confusables skeleton for uniqueness and matching (Inference).
3. **Strip or reject invisibles.** Locally, `\p{Cf}` has 170 code points including U+200B-200F, U+202A-202E, U+2060-2064, U+2066-206F, U+FEFF, soft hyphen, tag characters; `\p{Bidi_Control}` is U+061C, U+200E-200F, U+202A-202E, U+2066-2069; `\p{Default_Ignorable_Code_Point}` has 4,174 code points including variation selectors and blank Hangul fillers (U+115F-1160, U+3164, U+FFA0); NFKC keeps U+200B [P61].
4. **Reject bidi controls.** They make text display differently from logical order ("Trojan Source") [P60].
5. **Collapse `\p{Zs}`** (NBSP U+00A0, ideographic space U+3000) to one space; trim [P61].
6. **Length in graphemes and code points.** A Zalgo cluster of 20 combining marks is 21 code points but 1 grapheme; a family emoji is 11 UTF-16 units, 7 code points, 1 grapheme [P61]. Cap combining marks per base (Inference).
7. **Reject `\p{Cc}`, private use, unassigned; escape on output.** A Kahoot tool README describes nicknames (limited to 15 characters) that injected HTML and ran script on the host screen, later fixed [S9].
8. **Match on a folded copy** (NFKC, strip invisibles, confusable-fold, lowercase); store and display the sanitised copy, not the folded one (Inference).

### Packages (`npm view`, 2026-09-29)

| Package | Version | Licence | Last publish | Notes |
|---|---|---|---|---|
| `obscenity` | 0.4.6 | MIT | 2026-01-18 | No deps; ESM+CJS `exports`; Node >=18; 152,763 B unpacked; English dataset; transformers for confusables, leet-speak, repeats, non-alphabetic skip; whitelist; word boundaries [P50][P51][P52] |
| `@2toad/profanity` | 3.3.0 | MIT | 2026-03-24 | Multi-language; `wholeWord` default true ("Arsenic" not flagged); README shows no leet/homoglyph handling [P50][P56] |
| `leo-profanity` | 1.9.0 | MIT | 2026-01-17 | Shutterstock word list; en, fr, ru; whitelist API; Node >=18 [P50][P55] |
| `bad-words` | 4.1.5 | MIT | 2026-07-19 | List-based `clean()`; depends on `badwords-list`; repo now `nyvorin/badwords`; README shows no normalisation or homoglyph handling [P50][P54] |
| `naughty-words` | 1.2.0 | CC-BY-4.0 | 2020-07-13 | Data only (LDNOOBW lists); attribution licence; stale [P50][P57] |

- **Weekly downloads:** Not verified (`api.npmjs.org` and `npmjs.com` returned 403; `npm view` shows none).
- **Scunthorpe problem** (innocent words containing obscene substrings): Unverified (background knowledge). `obscenity`'s README shows non-matches such as "the pen is mightier", "banana s o", "grapes" [P51]. No empirical false-positive test was run (npm view only).
- **Recommendation: `obscenity@0.4.6`.**
  - Only candidate whose README documents leet-speak, confusable and repeat transformers plus whitelists, in a zero-dependency MIT package with ESM/CJS builds [P50][P51][P52]. Last published 2026-01-18; 9 open issues, 6 open PRs [P51][P53].
  - Caveats: pre-1.0 semver. Open issues: invisible-character evasion (#100: `a‍sshole` passes; maintainer suggests stripping in pre-processing), spaced words (#98: `f u c k`), `I`/`l` confusion (#108), leet-speak boundary bug (#126) [P53].
  - Our pre-processing (rules 1-5) closes #100. Browser and tree-shaking support are Not verified (README targets NodeJS; `sideEffects` undeclared [P50]); validate server-side in both targets.
  - Add a reserved-name list and a per-session uniqueness check on the confusable skeleton.
- **Others** rely on exact word lists and would need our own normalisation and confusable folding.

## 9. Package versions (npm registry, 2026-09-29)

| Package | Version | Published | Licence |
|---|---|---|---|
| `ws` | 8.22.0 | 2026-09-26 | MIT |
| `zod` | 4.6.5 | 2026-09-13 | MIT |
| `@aws-sdk/client-apigatewaymanagementapi` | 3.1142.0 | 2026-09-28 | Apache-2.0 |
| `@aws-sdk/client-dynamodb` | 3.1142.0 | 2026-09-28 | Apache-2.0 |
| `@aws-sdk/lib-dynamodb` | 3.1142.0 | 2026-09-28 | Apache-2.0 |
| `nanoid` | 6.0.1 | 2026-08-03 | MIT |
| `qrcode` | 1.5.4 | 2024-08-05 (modified 2025-11-13) | MIT |
| `timesync` | 1.0.11 | 2022-09-05 | MIT |

Source: `npm view <pkg> --json` [P50].

## Recommended patterns for zqhoot (Inference, concrete)

1. **Transport interface.** The engine emits effects (`send(playerId, msg)`, `broadcast(audience, msg)`); adapters for Node/`ws` and Lambda/API Gateway. Messages are level-triggered snapshots on a `(qIndex, phase)` logical clock.
2. **Node fan-out.** Serialise once to a `Buffer`, `ws.send(buf, { binary: false })`, skip sockets over a `bufferedAmount` threshold, `perMessageDeflate` off, `maxPayload` about 4 KB, 30 s ping/pong sweep.
3. **Lambda fan-out.** One invocation; recipients from one Query of `P#` items; pool of about 40; per-recipient try/catch; always awaited; 410 clears `connId` conditionally; `LimitExceededException` retried with jitter. Move to worker Lambdas only if p95 broadcast time or account RPS becomes a problem.
4. **Answer writes.** Item per (question, player), conditional put, `ALL_OLD` on failure, `recvAt` from `requestTimeEpoch`, deadline applied at reveal, one strongly consistent Query, in-memory scoring, no counters, no session read on the hot path.
5. **Session item.** Version- and state-guarded compare-and-set on host and timer transitions only; player facts live on `PLAYER` items.
6. **Reconnect.** Full-jitter backoff (500 ms base, about 10 s cap), immediate retry on visible or `pageshow`, ping every 2-4 min, token in `sessionStorage` plus `localStorage`, snapshot on `hello`, planned reconnect before 2 hours, Wake Lock during play.
7. **Fairness.** Client elapsed time bounded both sides by server wall time, `openAt` announced ahead, about 1 s acceptance grace, scoring formula independent of transport.
8. **Clock sync.** 8-probe min-RTT routine over the game socket for display alignment and RTT, not authority.
9. **Rate limits.** `zod` everywhere; Node per-socket token bucket; generous API Gateway route throttles (a class joins at once); per-session join cap 400; per-IP limits only on PIN guesses; DynamoDB idempotency for answers.
10. **Nicknames.** NFKC, strip `\p{Cf}`/`\p{Default_Ignorable_Code_Point}`, reject bidi, collapse `\p{Zs}`, grapheme cap, confusable skeleton for uniqueness, `obscenity@0.4.6` on the folded copy, escape on output.

## Not verified / open questions

- **Kahoot latency handling.** Pages blocked and search budget ended; formula is second-hand [S10]. Searched: GitHub issues "kahoot latency lag compensation", "kahoot scoring formula", repo search "kahoot clone scoring".
- **iOS Safari and Android Chrome socket lifetimes** on lock or background: only WebKit's bfcache path [P34] and user reports [S6][S7]. Apple, WebKit bugs and Chrome docs blocked.
- **Whether a server PostToConnection resets the idle timer**, and API Gateway's reply to client pings: re:Post summary only [S3].
- **Per-connection PostToConnection rate; per-client throttling and WAF support for WebSocket APIs** [S4].
- **Live 2026 AWS docs.** Quotas come from 2021-2023 snapshots plus search summaries; re-check before committing numbers.
- **Cristian's original paper; measured clock-sync accuracy on mobile.** Searched: GitHub repos "cristian algorithm websocket clock offset", issues on mobile sync accuracy.
- **Whether `requestTimeEpoch` is message-receipt time; Lambda/API Gateway clock skew.**
- **PostToConnection latency, Lambda cold-start times, SQS quotas.**
- **DynamoDB "split for heat" for item collections** (blog pages seen by title only).
- **npm weekly downloads** for all candidates.
- **`obscenity` browser support, tree-shaking, empirical false-positive rate** (no install allowed).
- **RFC 6455 text** (rfc-editor.org blocked): ping/pong semantics rest on the `ws` README [P1].
- **Human minimum reaction time** for a lower bound: not sourced.

## Sources

Accessed 2026-09-29. `awsdocs` links are pinned commits of archived repositories, so content may be older than the live docs.

**Primary**

- P1. ws README. https://github.com/websockets/ws/blob/master/README.md
- P2. ws API docs. https://github.com/websockets/ws/blob/master/doc/ws.md
- P3. ws `lib/websocket.js` (`bufferedAmount`, `send`). https://github.com/websockets/ws/blob/master/lib/websocket.js
- P4. ws `lib/sender.js` (`frame`, `send`, `dispatch`). https://github.com/websockets/ws/blob/master/lib/sender.js
- P5. aws-samples/simple-websockets-chat-app `sendmessage/app.js`. https://github.com/aws-samples/simple-websockets-chat-app/blob/master/sendmessage/app.js
- P6. aws-samples/simple-websockets-chat-app README. https://github.com/aws-samples/simple-websockets-chat-app
- P7. API Gateway quotas (snapshot 2023-04-03, commit 781597d). https://github.com/awsdocs/amazon-api-gateway-developer-guide/blob/781597d7e2e5375258f6029786877eb8b435dd0f/doc_source/limits.md
- P8. Protecting your WebSocket API (same snapshot). https://github.com/awsdocs/amazon-api-gateway-developer-guide/blob/781597d7e2e5375258f6029786877eb8b435dd0f/doc_source/websocket-api-protect.md
- P9. `@connections` commands (same snapshot). https://github.com/awsdocs/amazon-api-gateway-developer-guide/blob/781597d7e2e5375258f6029786877eb8b435dd0f/doc_source/apigateway-how-to-call-websocket-api-connections.md
- P10. `$connect`/`$disconnect` routes (same snapshot). https://github.com/awsdocs/amazon-api-gateway-developer-guide/blob/781597d7e2e5375258f6029786877eb8b435dd0f/doc_source/apigateway-websocket-api-route-keys-connect-disconnect.md
- P11. WebSocket context variables (same snapshot). https://github.com/awsdocs/amazon-api-gateway-developer-guide/blob/781597d7e2e5375258f6029786877eb8b435dd0f/doc_source/apigateway-websocket-api-mapping-template-reference.md
- P12. botocore ApiGatewayManagementApi model. https://github.com/boto/botocore/blob/develop/botocore/data/apigatewaymanagementapi/2018-11-29/service-2.json
- P13. botocore ApiGatewayV2 model (`RouteSettings`, `Stage`). https://github.com/boto/botocore/blob/develop/botocore/data/apigatewayv2/2018-11-29/service-2.json
- P14. botocore DynamoDB model (PutItem, Query, `ReturnValuesOnConditionCheckFailure`, `ConsistentRead`). https://github.com/boto/botocore/blob/develop/botocore/data/dynamodb/2012-08-10/service-2.json
- P15. DynamoDB Developer Guide snapshot 2021-09-07 (commit bfe8e5e): https://github.com/awsdocs/amazon-dynamodb-developer-guide/blob/bfe8e5ee42f3cae9f0b58580f8d3816d21781d6a/doc_source/bp-partition-key-design.md ; .../bp-partition-key-sharding.md ; .../WorkingWithItems.md ; .../HowItWorks.Partitions.md
- P16. DynamoDB partition-key, burst and adaptive capacity docs (search summary). https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-partition-key-design.html ; https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/burst-adaptive-capacity.html
- P17. AWS Database Blog, "Implement resource counters with Amazon DynamoDB" (search summary). https://aws.amazon.com/blogs/database/implement-resource-counters-with-amazon-dynamodb/
- P18. DynamoDB optimistic locking with version number (search summary). https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/BestPractices_OptimisticLocking.html
- P19. AWS Database Blog, "Handle conditional write errors in high concurrency scenarios" (search summary). https://aws.amazon.com/blogs/database/handle-conditional-write-errors-in-high-concurrency-scenarios-with-amazon-dynamodb/
- P20. DynamoDB TTL docs (search summary). https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html
- P21. Lambda Developer Guide snapshot 2022-06-10 (commit 4c88540): https://github.com/awsdocs/aws-lambda-developer-guide/blob/4c88540480b84a2d2938ba64bca1827791664b66/doc_source/invocation-scaling.md ; .../gettingstarted-limits.md
- P22. smithy-typescript `node-http-handler.ts` (`keepAlive = true; maxSockets = 50`). https://github.com/smithy-lang/smithy-typescript/blob/main/packages/node-http-handler/src/node-http-handler.ts
- P23. AWS knowledge center, "Troubleshoot 410 GoneException errors with API Gateway WebSocket APIs" (search summary). https://aws.amazon.com/premiumsupport/knowledge-center/410-gone-api-gateway/
- P24. AWS Compute Blog, "Announcing WebSocket APIs in Amazon API Gateway" (search summary). https://aws.amazon.com/blogs/compute/announcing-websocket-apis-in-amazon-api-gateway/
- P25. AWS AppSync Events (search summaries): https://aws.amazon.com/blogs/mobile/announcing-aws-appsync-events-serverless-websocket-apis/ ; https://docs.aws.amazon.com/general/latest/gr/appsync.html ; https://aws.amazon.com/appsync/pricing/
- P26. AWS IoT Core pricing and quotas (search summary). https://aws.amazon.com/iot-core/pricing/ ; https://docs.aws.amazon.com/general/latest/gr/iot-core.html
- P27. AWS Architecture Blog, "Exponential Backoff And Jitter" (search summary). https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
- P28. MDN, Page Visibility API (mdn/content source). https://github.com/mdn/content/blob/main/files/en-us/web/api/page_visibility_api/index.md
- P29. MDN, `visibilitychange`. https://github.com/mdn/content/blob/main/files/en-us/web/api/document/visibilitychange_event/index.md
- P30. MDN, `Document.visibilityState`. https://github.com/mdn/content/blob/main/files/en-us/web/api/document/visibilitystate/index.md
- P31. MDN, `pageshow`. https://github.com/mdn/content/blob/main/files/en-us/web/api/window/pageshow_event/index.md
- P32. MDN, `pagehide`. https://github.com/mdn/content/blob/main/files/en-us/web/api/window/pagehide_event/index.md
- P33. web.dev, Back/forward cache (GoogleChrome/web.dev source, updated 2023-05-25). https://github.com/GoogleChrome/web.dev/blob/main/src/site/content/en/blog/bfcache/index.md
- P34. WebKit `WebSocket.cpp` (`suspend`). https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/websockets/WebSocket.cpp
- P35. MDN, `WebSocket` interface. https://github.com/mdn/content/blob/main/files/en-us/web/api/websocket/index.md
- P36. MDN, `Navigator.onLine`. https://github.com/mdn/content/blob/main/files/en-us/web/api/navigator/online/index.md
- P37. MDN, Network Information API; support data from `@mdn/browser-compat-data` 8.1.3. https://github.com/mdn/content/blob/main/files/en-us/web/api/network_information_api/index.md
- P38. MDN, `Window.sessionStorage`. https://github.com/mdn/content/blob/main/files/en-us/web/api/window/sessionstorage/index.md
- P39. MDN, Screen Wake Lock API. https://github.com/mdn/content/blob/main/files/en-us/web/api/screen_wake_lock_api/index.md
- P40. `@mdn/browser-compat-data` 8.1.3, `api.WakeLock` (also https://github.com/mdn/browser-compat-data/blob/main/api/WakeLock.json). https://www.npmjs.com/package/@mdn/browser-compat-data
- P41. `caniuse-db` 1.0.30001813, `wake-lock` feature data. https://www.npmjs.com/package/caniuse-db
- P42. Socket.IO docs, Connection state recovery. https://github.com/socketio/socket.io-website/blob/main/docs/categories/01-Documentation/connection-state-recovery.md
- P43. Socket.IO docs, How it works (heartbeat). https://github.com/socketio/socket.io-website/blob/main/docs/categories/01-Documentation/how-it-works.md
- P44. Socket.IO docs, Delivery guarantees. https://github.com/socketio/socket.io-website/blob/main/docs/categories/01-Documentation/delivery-guarantees.md
- P45. Socket.IO docs, Troubleshooting. https://github.com/socketio/socket.io-website/blob/main/docs/categories/01-Documentation/troubleshooting.md
- P46. Socket.IO client options. https://github.com/socketio/socket.io-website/blob/main/docs/client-options.md
- P47. MDN, `performance.now()`. https://github.com/mdn/content/blob/main/files/en-us/web/api/performance/now/index.md
- P48. `timesync` README (npm). https://github.com/enmasseio/timesync
- P49. `timesync` source `src/timesync.js`. https://github.com/enmasseio/timesync/blob/master/src/timesync.js
- P50. npm registry metadata via `npm view <pkg> --json`, run 2026-09-29, for `ws`, `zod`, `@aws-sdk/client-apigatewaymanagementapi`, `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`, `nanoid`, `qrcode`, `obscenity`, `bad-words`, `leo-profanity`, `@2toad/profanity`, `naughty-words`, `timesync`. https://registry.npmjs.org/
- P51. obscenity README (npm and GitHub, incl. repository page). https://github.com/jo3-l/obscenity
- P52. obscenity docs, Transformers. https://github.com/jo3-l/obscenity/blob/main/docs/guide/transformers.md
- P53. obscenity issues: https://github.com/jo3-l/obscenity/issues ; https://github.com/jo3-l/obscenity/issues/100 ; https://github.com/jo3-l/obscenity/issues/98
- P54. bad-words README (npm). https://github.com/nyvorin/badwords
- P55. leo-profanity README (npm). https://github.com/jojoee/leo-profanity
- P56. @2toad/profanity README (npm). https://github.com/2Toad/Profanity
- P57. naughty-words README (LDNOOBW). https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words
- P58. MDN, `String.prototype.normalize`. https://github.com/mdn/content/blob/main/files/en-us/web/javascript/reference/global_objects/string/normalize/index.md
- P59. ICU mirror of Unicode `confusables.txt` (UTS #39 data, header dated 2026-08-06). https://github.com/unicode-org/icu/blob/main/icu4c/source/data/unidata/confusables.txt
- P60. Trojan Source README (bidi and invisible-character attacks). https://github.com/nickboucher/trojan-source
- P61. Local execution: Node v22.22.2 (Unicode 17.0, ICU 78.2), regex property escapes, `String.prototype.normalize`, `Intl.Segmenter`, 2026-09-29. Not a web source.
- P62. API Gateway, Using AWS WAF (same 2023-04-03 snapshot). https://github.com/awsdocs/amazon-api-gateway-developer-guide/blob/781597d7e2e5375258f6029786877eb8b435dd0f/doc_source/apigateway-control-access-aws-waf.md

**Secondary**

- S1. ymwjbxxq/aws-api-gateway-websocket-at-scale. https://github.com/ymwjbxxq/aws-api-gateway-websocket-at-scale
- S2. morid648/dynamo-wave-chat. https://github.com/morid648/dynamo-wave-chat
- S3. AWS re:Post, "Websocket API server side Ping/Pong" (search summary; page blocked). https://repost.aws/questions/QUV-egTr6_Skylz2_OHp8irw/websocket-api-server-side-ping-pong
- S4. AWS re:Post, "API Gateway Management API PostToConnection rate limiting" (search summary; page blocked). https://repost.aws/questions/QUa3KEHJgTTJOts1TCBodaxQ/api-gateway-management-api-posttoconnection-rate-limiting
- S5. Dai Codes blog, "Websocket broadcast issues with AWS gateway and nodejs lambdas" (search summary; page blocked). https://blog.dai.codes/aws-gw-management-api-promises/
- S6. supabase/realtime-js issue 121. https://github.com/supabase/realtime-js/issues/121
- S7. gerchowl/herdr issue 158. https://github.com/gerchowl/herdr/issues/158
- S8. jokeri2222/KaHack README. https://github.com/jokeri2222/KaHack
- S9. unixpickle/kahoot-hack README. https://github.com/unixpickle/kahoot-hack
- S10. zqhoot `docs/research/kahoot.md` (another agent's research; scoring formula derived from a search-tool summary of https://support.kahoot.com/hc/en-us/articles/115002303908-How-points-work). /home/user/zqhoot/docs/research/kahoot.md
