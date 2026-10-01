# Research summary: decisions forced and conflicts found

Inputs: [kahoot.md](kahoot.md), [mentimeter.md](mentimeter.md), [aws-realtime.md](aws-realtime.md), [realtime-patterns.md](realtime-patterns.md), [responsive-display.md](responsive-display.md). Written 2026-09-29.

## Evidence quality (read first)

The research environment blocked direct fetches of docs.aws.amazon.com, aws.amazon.com, support.kahoot.com, help.mentimeter.com, w3.org, MDN, web.dev, caniuse and grafana.com. The session's 200-call WebSearch budget ran out partway through. What the agents used instead:

| Evidence | Where it was used | Reliability |
|---|---|---|
| WebSearch summaries of vendor pages | Kahoot, Mentimeter, some AWS | Paraphrased by the search tool; not verbatim |
| AWS Price List bulk API (`pricing.us-east-1.amazonaws.com`) | All AWS prices | Exact, current (published Sept 2026) |
| `awsdocs` GitHub archives at pinned commits (API Gateway 2023-04, Lambda 2023-10, DynamoDB 2021-09) | AWS quotas and behaviour | Real AWS text, 1-5 years old |
| botocore / AWS SDK v3 source | API operations, error codes, enums, SDK defaults | Current, exact |
| `w3c/wcag`, `mdn/content`, `@mdn/browser-compat-data`, `caniuse-db` | WCAG wording, browser support | Current source text |
| npm registry (`npm view`) | Package existence, versions, licences | Exact |

Before production, someone with normal web access should re-read: the API Gateway WebSocket quota page, the Lambda quotas page (new-account concurrency), the DynamoDB on-demand throughput page, and Kahoot's "How points work".

## Decisions the research forces

### Platform

1. **Keep API Gateway WebSocket + Lambda for realtime on AWS.** It scales to zero and fits the quotas for one 400-player session. It costs about the same per delivered message as AppSync Events ($1.00/M on both) [aws-realtime A5, D1, E3]. AppSync Events is the only native-broadcast alternative that also scales to zero. It stays a documented swap-in behind a transport interface; its connection duration, idle behaviour and delivery latency are unverified. IoT Core is ruled out: MQTT and IoT policies for anonymous phones add the most complexity for no gain.
2. **Fan-out = one Lambda invocation, bounded pool of about 50 `PostToConnection` calls, recipients from one Query.** The management API has no multicast [aws-realtime A3]. The SDK v3 default of `maxSockets: 50` sets the practical pool size. Handle 410 by deleting the connection record and 429 by retrying with jitter. The AWS sample's 410 branch deletes the wrong connection ID; don't copy it [aws-realtime source 26].
3. **Lambda on `nodejs24.x`, arm64, esbuild zip bundles.** `nodejs22.x` is deprecated 2027-04-30 and `nodejs24.x` 2028-04-30 [aws-realtime B2, secondary]. Zip cold starts for Node on arm64 are about 115-135 ms (hello-world floor, secondary). No VPC, so no NAT [aws-realtime B2].
4. **Nothing with a fixed monthly fee.** Idle total is about $0.02/month (S3 storage), or $0.52 with a Route 53 hosted zone. Avoid KMS customer keys, Secrets Manager, WAF, Lambda provisioned concurrency and API Gateway caching [aws-realtime E4]. Consequences: no Secrets Manager for the VM JWT secret on AWS, no WAF, and CloudWatch log retention must be set explicitly.

### Data

5. **Answers: one item per (question, player), conditional put `attribute_not_exists`, no counter items.** First answer wins, retries are idempotent, and `ReturnValuesOnConditionCheckFailure: ALL_OLD` returns the stored answer for free [realtime-patterns 2]. Aggregate at reveal with a strongly consistent Query.
6. **Spread each question's answers over 4 partition keys.** realtime-patterns says 400 writes in 2 s is about 200 WCU/s, a fifth of the 1,000 WCU/s partition ceiling. aws-realtime notes that 400 answers inside about 300 ms would exceed it. Four shards cost 3 extra Queries at reveal and remove the concern.
7. **The session item is written only by host and timer transitions, with a state guard** (`phase = :expected AND questionIndex = :n`). Joins, answers, heartbeats and reconnects never touch it [realtime-patterns 3].
8. **Keep the frozen quiz snapshot out of the hot session item.** The answer path reads the session state strongly consistently, 400 times in about 2 s. A quiz snapshot of tens of KB in that item would push reads past 3,000 RCU/s on one partition (inference from the per-partition ceiling in aws-realtime C1). The snapshot is immutable, so Lambda instances can cache it.
9. **TTL on every live-session item, and filter expired items on read.** TTL deletes "typically within two days" and expired items are still returned until then [aws-realtime C1].

### Realtime behaviour

10. **Snapshot-on-reconnect, not message replay.** Every server message is level-triggered state for its phase. `hello` gets a full role-specific snapshot. No replay buffer, which suits stateless Lambda [realtime-patterns 4].
11. **Application-level heartbeat.** Browsers cannot send WebSocket pings, API Gateway closes idle connections after 10 minutes and ends every connection after 2 hours, and `$disconnect` is best-effort [aws-realtime A1, A4]. Clients ping about every 60-120 s. Clients also reconnect on `visibilitychange`/`pageshow` and plan a reconnect before 2 hours. On Node, the server does protocol pings every 30 s.
12. **Full-jitter reconnect backoff** (500 ms base, about 10 s cap), because API Gateway's 500 new-connection burst is not adjustable and a class of phones waking together is a thundering herd [aws-realtime F4, realtime-patterns 4].
13. **Screen Wake Lock during play**, as progressive enhancement: iOS Safari 16.4+, not in Home Screen web apps before 18.4, HTTPS only, released when hidden [realtime-patterns 4, responsive-display].
14. **Nickname pipeline:** NFKC, strip `\p{Cf}` and default-ignorables, reject bidi controls, collapse spaces, cap graphemes, confusable skeleton for uniqueness, then `obscenity@0.4.6` on the folded copy. Always escape on output. Kahoot's own history includes nickname HTML injection on the host screen [realtime-patterns 8].

### Product and UX

15. **Phones show question text and answer text by default.** This is a choice, not a copy. Kahoot shows only answer shapes on phones by default, with an opt-in toggle [kahoot 9]. Showing the text helps accessibility (WCAG 1.4.1) and remote play [responsive-display 5]. Host toggle to hide question text on phones.
16. **Original answer identity:** letters A-D + shapes (A hexagon, B plus, C star, D dome) + Okabe-Ito fills (#0072B2, #D55E00, #F0E442, #009E73) with 3-4 px ink outlines. Vermillion/green differ by 1.13:1 in luminance, so shape and letter must carry identity, never colour alone [responsive-display 6.4]. None of Kahoot's triangle/diamond/circle/square with red/blue/yellow/green is used.
17. **Presenter view = 16:9 stage sized in container units** (`cqh`, fallback `min(1vh, 0.5625vw)`), so 1366x768, 1080p and 4K render the same composition. Minimum essential text 4.3% of stage height, question 7%, answers 5%. Light stage by default (projector black levels wash out in lit rooms), dark stage toggle. Text-size control, because WCAG failure F94 flags viewport-only text sizing [responsive-display 1-2, design rules].
18. **Phones in rem, never bare `vw`.** Inputs ≥ 16 px, controls ≥ 48 px, answer rows ≥ 72 px, answers stacked below about 420 px container width, `svh` with `vh` fallback, safe-area insets, no `maximum-scale` [responsive-display 3, design rules].
19. **WCAG 2.2.1 (timing):** a live timed quiz plausibly fits the real-time-event exception, but don't rely on it. v1 supports untimed questions (host closes) and a reduced-motion numeric countdown with no flashing. Per-player time multipliers are the W3C-endorsed "third party controls time" pattern and are deferred [responsive-display 5.1].
20. **Ranking-style questions need a non-drag alternative** (WCAG 2.5.7). Ranking is not in v1, so this is recorded for later.
21. **Poll percentages are a share of participants, not of selections, if multi-select is ever added** [mentimeter 2]. Word cloud: trim/lowercase/NFKC normalisation, 25-character cap, host-set responses per player. Open-ended: 200-character cap, raw text kept with a `hidden` flag, never deleted. An approval queue is the gap Mentimeter leaves for free text [mentimeter implications 4-5].
22. **Presenter live results coalesce to at most one update per second**, which also satisfies WCAG 2.2.2's frequency control. Phones get only their own ack and state changes [mentimeter implications 7, responsive-display 5.2].
23. **Load tool: k6.** It builds from source here (v1.8.1), has native WebSocket support, and scripts in JS. Its WebSocket module choice is recorded in the ADR. Artillery was not evaluated (docs blocked).
24. **Test matrix:** six Playwright projects (320x568, 390x844 set explicitly because the iPhone 14 descriptor is 390x664, 768x1024, 1366x768, 1920x1080, 3840x2160), `@axe-core/playwright` with `wcag22aa` tags, and a horizontal-scroll assertion [responsive-display 8]. Only Chromium is available in this environment. WebKit/iOS behaviour is not verified here.

## Requirement at risk

**New-account Lambda concurrency.** AWS docs say only that new accounts have "reduced concurrency" quotas that rise with usage. A secondary source puts the reduced value at 10 [aws-realtime B1]. With Lambda's rule of 10 requests/s per unit of concurrency, a quota of 10 caps a function at about 100 requests/s. 400 answers in 2 s is 200 requests/s, so a fresh account would throttle during every answer burst. This is raised with the user in the Phase 2 summary, with options. The established-account default of 1,000 has ample headroom: 400 answers at about 50 ms each need about 20 concurrent executions.

Other quotas that bite in edge cases, not in one session:
- 500 new WebSocket connections/s with a non-adjustable 500 burst. Two 400-player sessions opening in the same second, or a reconnect storm, exceed it.
- The 10,000 rps account throttle (5,000 non-adjustable burst) is shared by every API type, including `PostToConnection`.
- `PostToConnection` has no documented rate. A 429 can also mean the client's buffer is full.

## Conflicts between sources

| Topic | Conflict | Resolution |
|---|---|---|
| Kahoot PIN length | 6 digits (older) vs 7 (2017 GitHub issue); no primary source | Irrelevant to us: zqhoot uses 6-digit PINs, unique among live sessions |
| Kahoot multi-select points | "Up to 500" vs "up to 1000" per correct answer, both from summaries of the same page | Multi-select not in v1 |
| Kahoot streak bonus | Community text describes a bonus; the help centre says streaks give no points (removed March 2020) | Streak shown always; bonus is a per-quiz option, **off by default** |
| Mentimeter code validity | 2 days of inactivity (help centre) vs "about four hours" (unattributed summary) | Irrelevant: our PIN lives for the session, TTL-bounded |
| Mentimeter notify threshold | 10,000 vs 20,000 participants | Irrelevant |
| Scoring time source | realtime-patterns recommends client-measured elapsed time bounded by server time; the brief requires server time | **Server time.** Fan-out skew is removed by announcing `openAt` ahead of time (ADR-0005), not by trusting the client |
| Answer partitioning | realtime-patterns: one partition key per question is fine; aws-realtime: split answers across keys | 4 shards per question (decision 6) |
| DynamoDB `TransactWriteItems` limit | 25 actions (2021 archive) vs 100 (current botocore model) | Take 100 from the current model; we don't use more than 2 anyway |
| DynamoDB TTL wording | "within 48 hours" (2021) vs "typically within two days" (current) | Same in practice; filter on `expiresAt` |
| DynamoDB on-demand initial throughput | 4,000 WRU / 12,000 RRU, from the 2021 archive only | Unverified for 2026; ample for our peak anyway (about 1,000 WRU/s worst case) |
| IoT Core connect rate | 500/s (about 2023 mirror) vs 3,000/s (2025 dump) | Not used |
| Resume-token storage | Brief: `sessionStorage`; realtime-patterns: `sessionStorage` with `localStorage` fallback | `sessionStorage` primary, `localStorage` mirror keyed by session and cleared on session end. iOS may discard a backgrounded tab, which loses `sessionStorage` |
| Projector polarity | No source either way; ambient-light model favours dark ink on light | Light stage default, dark toggle, host-selectable |
