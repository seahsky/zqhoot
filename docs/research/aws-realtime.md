# AWS realtime stack research for zqhoot (400 players per session, scale to zero)

Read date: 2026-09-29. Prices are us-east-1 list prices before any free tier unless stated. Quotas are per account per Region unless stated.

**Tag legend.** `[primary]` = AWS documentation, AWS pricing data, AWS blog or What's New, AWS SDK or API-model source. `[secondary]` = third party. **Inference:** = my reasoning. **Assumption:** = an arithmetic input I chose. "Unverified (background knowledge)" = not sourced in this session.

**Provenance note.** `docs.aws.amazon.com` and `aws.amazon.com` were blocked for fetching, and the session's WebSearch budget (200 calls) ran out before I finished. Evidence used, each marked in Sources: (1) WebSearch summaries of current AWS pages ("search-summary"); (2) the AWS Price List bulk API (exact prices and version history); (3) archived AWS documentation text from the `awsdocs` GitHub repos at pinned commits (real AWS text but old: API Gateway 2023-04, Lambda 2023-10, DynamoDB 2021-09; conflicts with newer sources are noted); (4) AWS SDK and API-model sources (botocore 1.43.104, AWS SDK for JavaScript v3); (5) third-party dumps and mirrors (`[secondary]`).

## Key findings

1. **No broadcast primitive on API Gateway WebSocket.** The management API has exactly three operations, each taking one `ConnectionId`: `PostToConnection`, `GetConnection`, `DeleteConnection` [8][primary]. A 400-player broadcast is 400 `PostToConnection` calls.
2. **Connection-rate limit is the tightest hard number.** New WebSocket connections: 500/s (adjustable) with a separate burst of 500 that is *not* adjustable, shared by all WebSocket APIs in the account and Region [3][4]. One 400-player join fits; two sessions opening in the same second may not.
3. **Throttle is shared.** The account-level throttle (10,000 rps, burst 5,000) covers HTTP, REST, WebSocket and WebSocket callback (`@connections`) APIs together [2][3]. The rate is adjustable; the burst is not.
4. **Fixed WebSocket limits.** Idle timeout 10 min, maximum duration 2 h, message 128 KB, frame 32 KB, none adjustable [1][3]. `$disconnect` is best-effort [6].
5. **Prices.** WebSocket $1.00/M messages (32 KB metering) plus $0.25/M connection minutes. HTTP API $1.00/M requests. REST API $3.50/M [10][11].
6. **Lambda concurrency.** Default 1,000 (adjustable). New accounts get a reduced quota [12]. A `[secondary]` AWS-org document puts the reduced value at 10 [28]. Each function scales by 1,000 concurrent executions per 10 s, not adjustable [13][4]. This is the most likely blocker on a fresh account.
7. **Lambda arm64.** $0.0000133334/GB-s vs $0.0000166667 for x86 (first tier); $0.20/M requests on both [14]. `nodejs22.x` and `nodejs24.x` exist [8]; deprecation 2027-04-30 and 2028-04-30 `[secondary]` [16]. Hello-world arm64 zip cold start about 115-135 ms `[secondary]` [17].
8. **No NAT needed.** A Lambda outside a VPC reaches AWS public endpoints. NAT is needed only for VPC-attached functions [18][primary, archived 2023].
9. **DynamoDB on-demand prices halved on 2024-11-01.** Now $0.625/M write and $0.125/M read request units, confirmed from Price List versions [20]. Partition ceiling is 3,000 RCU / 1,000 WCU [19]. `TransactWriteItems` allows 100 actions [8].
10. **AppSync Events has native broadcast.** One publish reaches all subscribers. Price is $1.00/M operations plus $0.08/M connection minutes [22]. Deliveries count as operations, metered per 5 KB [4][23]. Quotas: 2,000 connects/s, 10,000 inbound events/s, 1,000,000 outbound metered events/s [4].
11. **Per-message price is identical.** A 400-way broadcast costs about $0.0004 on either service. AppSync's advantage is removing the fan-out loop, connection table and throttle tokens, not price. Private per-player messages get no fan-out benefit if a publish request targets one channel (**Inference**, single-channel targeting unverified).
12. **Full-session cost (list price).** API Gateway option about $0.082. AppSync hybrid option about $0.094, or about $0.078 if per-player messages are merged into broadcasts (section E3). Messages dominate.
13. **Idle cost.** About $0.02/month (1 GB in S3), or about $0.52 with a Route 53 hosted zone (E4). Avoid KMS customer keys ($1), Secrets Manager ($0.40/secret), WAF ($5 per web ACL plus $1 per rule) and API Gateway Portals ($125) [25].
14. **IoT Core is workable but ruled out for v1.** MQTT clients, IoT policies and anonymous-player auth add complexity for no price gain. Limits are generous: 3,000 connects/s, 20,000 in/out publishes/s, 24 h WebSocket lifetime [4].
15. **Top 400-player risks.** New-account Lambda concurrency, the non-adjustable 500 connection burst, and the undocumented `PostToConnection` rate and back-pressure (429).

---

## A. API Gateway WebSocket APIs

### A1. Quotas

| Quota | Value | Adjustable | Source |
|---|---|---|---|
| New connections per second (all WebSocket APIs) | 500 | Yes | [3][4] primary/secondary; [1] search-summary confirms 500 |
| New connections burst | 500 | **No** | [3] primary mirror; [4] secondary |
| Concurrent connections | No quota; bounded by rate and max duration (500/s x 2 h = 3,600,000) | n/a | [1][2] primary |
| Idle connection timeout | 10 minutes (600 s) | No | [1][3] primary |
| Maximum connection duration | 2 hours (7,200 s) | No | [1][3] primary |
| Message payload | 128 KB | No | [1][3] primary |
| Frame size | 32 KB; larger frame or message closes the connection with code 1009 | No | [2][9] primary archived |
| Routes (resources/routes per REST/WebSocket API) | 300 | Yes | [3] primary mirror; [2] archived |
| Integrations per API | 300 | Yes | [2] primary archived |
| Stages per API | 10 | Yes | [2] primary archived |
| Lambda authorizers per API | 10 (result size 8 KB) | Yes / No | [2] primary archived |
| Integration timeout | 29 s max (50 ms to 29,000 ms) | Upper bound not adjustable | [3] primary mirror; [1] search-summary |
| Binary frames | Not supported: connection closed with code 1003 | n/a | [9] primary archived |

The SDK model also caps `PostToConnection` `Data` at 131,072 bytes [8][primary]. The current page, the archived 2023 tables and the 2025 `[secondary]` dump agree on 500 connections/s, 10 min, 2 h, 128 KB and 32 KB [1][2][3][4].

### A2. Throttling

| Item | Value | Adjustable | Source |
|---|---|---|---|
| Account-level throttle, per Region, across HTTP, REST, WebSocket and WebSocket callback APIs | 10,000 rps steady state | Yes | [2][3] primary |
| Account-level burst (token bucket max) | 5,000 | **No** ("determined by the API Gateway service team") | [2][3] primary |
| Lower default in some Regions (for example Cape Town, Milan, Jakarta, UAE, Hyderabad, Melbourne, Spain, Zurich, Tel Aviv, Calgary, Malaysia, Thailand, Mexico) | 2,500 rps / 1,250 burst | Rate yes | [1] primary, search-summary |
| Route-level and stage-level throttle | Configurable per route via `ThrottlingRateLimit` / `ThrottlingBurstLimit`; cannot exceed account limits | n/a | [5][8] primary |
| Per-connection inbound message rate | Not documented in sources I could read | Unknown | Not verified |

- **Shared with REST: yes.** The archived table is titled "Throttle quota per account, per Region across HTTP APIs, REST APIs, WebSocket APIs, and WebSocket callback APIs" [2] ("callback" = the `@connections` API). The current protect page says limits apply "across all APIs within an AWS account, per Region" and are "best-effort ... targets rather than guaranteed request ceilings" [5].
- **Inference:** each answer costs about 3 tokens (inbound route request, integration, `PostToConnection` ack). The 10,000 rps ceiling is then about 3,300 answers/s, roughly 8 sessions of 400 answering in the same second, or about 40 if answers spread over 5 s.

### A3. `@connections` management API

- **Operations.** `POST /@connections/{id}` (PostToConnection), `GET` (GetConnection: `ConnectedAt`, `LastActiveAt`, `Identity.SourceIp`, `UserAgent`), `DELETE` (DeleteConnection). SigV4/IAM authorization is required (`execute-api:ManageConnections`) [7][8][primary].
- **No multicast.** No operation accepts a list of connection IDs or a group [8]. The AWS sample chat app does Scan, then `Promise.all` of one `PostToConnection` per connection, deleting stale ones on HTTP 410 [26][primary, aws-samples code]. A re:Post summary notes latency becomes an issue beyond about 1,000 recipients [26][secondary].
- **Errors on `PostToConnection`** [8][primary]:
  - 403 `ForbiddenException`: caller not authorized.
  - **410 `GoneException`: "The connection with the provided id no longer exists."**
  - 413 `PayloadTooLargeException`: "The data has exceeded the maximum size allowed."
  - 429 `LimitExceededException`: "The client is sending more than the allowed number of requests per unit of time **or the WebSocket client side buffer is full**."
- **Handling.**
  - On 410, treat the connection as gone: delete its record and do not retry. The AWS sample does this [26].
  - On 429, retry with exponential backoff and jitter (re:Post guidance `[secondary]` [26]). AWS SDK for JavaScript v3 already classifies `LimitExceededException` as a throttling error, so the default retry strategy retries it [27][primary].
  - Slow phones can trigger the "buffer full" case even when your rate is fine (**Inference:** from the error text).
- **Rate limit and latency.** No numeric `PostToConnection` limit or latency is documented in anything I could read; re:Post says the rate is unknown [26][secondary]. Calls count against the shared account throttle [2]. E1 uses an **Assumption:** with sensitivity.
- **Client concurrency.** Node SDK v3 `NodeHttpHandler` defaults to `keepAlive: true` and `maxSockets: 50` [27][primary], so an unbounded `Promise.all` runs at about 50 concurrent requests. N=50 in E1 is the out-of-the-box behavior.

### A4. Routes and lifecycle events

- **Route selection.** The route selection expression for chat-style APIs is `$request.body.action` (for example `{"action":"sendmessage",...}`). Only JSON messages route by content. Non-JSON goes to `$default` [9][primary]. `$default` is also the fallback when nothing matches or the expression cannot be evaluated [9][primary, current page via search-summary].
- **`$connect`.** Runs during the upgrade. Until its integration completes, the connection is pending. Failure means no connection, and the client gets 401/403 on auth failure. Authorization can be configured on `$connect` only [6][primary].
- **`$disconnect`.** "Executed after the connection is closed ... `$disconnect` is a best-effort event. API Gateway will try its best to deliver the `$disconnect` event to your integration, but it cannot guarantee delivery." [6][primary]. The wording is in both the 2023 archive and the current page (search-summary).
- **Two-way responses.** A route response is optional, and without one nothing is returned to the client. The route response selection expression is currently restricted to `$default` [9][primary]. **Inference:** acks can use a route response (still one billed message) instead of an extra `PostToConnection` call.
- **Design consequence (Inference):** because `$disconnect` can be lost, run a heartbeat and TTL cleanup, and treat 410 as authoritative.

### A5. Pricing (us-east-1, Price List published 2026-09-21 [10][primary])

| Item | Price |
|---|---|
| WebSocket messages, first 1 billion/month | $1.00 per million |
| WebSocket messages, over 1 billion/month | $0.80 per million |
| WebSocket connection minutes | $0.25 per million |
| HTTP API requests, first 300 million | $1.00 per million ($0.90 after) |
| REST API requests, first 333 million | $3.50 per million |
| REST API dedicated cache (from $0.02/hour) and Portals ($125/month) | Not used; avoid |

- **Metering.** Messages are metered in 32 KB increments (a 33 KB message is 2). Connection minutes are rounded to a minute. Ping/pong control frames are not metered [11][primary, search-summary].
- **Free tier.** 1 million messages and 750,000 connection minutes per month for WebSocket, plus 1 million HTTP API calls, "for up to 12 months" [11][primary, search-summary].
- **Not verified:** whether `GetConnection`/`DeleteConnection` calls are billed separately. The pricing text I read lists only messages and connection minutes.

---

## B. Lambda

### B1. Concurrency and scaling

| Item | Value | Adjustable | Source |
|---|---|---|---|
| Default account concurrent executions | 1,000 | Yes ("tens of thousands") | [12][4] primary archived / secondary |
| New accounts | "New AWS accounts have reduced concurrency and memory quotas. AWS raises these quotas automatically based on your usage." Exact number not given | Yes | [12] primary (archived 2023-10 and current search-summary) |
| Reduced value seen in practice | 10 | n/a | [28] secondary (an AWS-org repo says new accounts "sometimes have the ... quota at the reduced default of `10`, on which reserving any concurrency is rejected") |
| Per-function scaling rate | 1,000 concurrent executions every 10 s (or 10,000 requests/s every 10 s) per function | **No** | [13] primary search-summary; [4] secondary |
| Request-rate cap | 10 x account concurrency (10,000 rps at 1,000) | with concurrency | [13][primary, search-summary]; [12] archived |
| Old model (before Dec 2023) | Region-wide burst 500-3,000, then +500/min | n/a | [12] primary archived |

The 2023 change is confirmed. The current scaling page and the AWS blog "Lambda functions now scale 12 times faster" describe per-function scaling of 1,000 environments per 10 s, and the What's New URL is dated 2023/12 [13][primary].

**Inference:** with a reduced limit of 10, the 10x rule gives about 100 requests/s. A burst of 400 answers in one second would be throttled. Check with `aws lambda get-account-settings` and request an increase before the first real session.

### B2. Runtimes, architecture, pricing, payloads

- **Runtime identifiers.** The AWS-authored Lambda API model lists `nodejs20.x`, `nodejs22.x`, `nodejs24.x` and also `nodejs26.x`, and architectures `x86_64`, `arm64` [8][primary]. Whether `nodejs26.x` is generally available and its dates are not verified.
- **Deprecation dates (`[secondary]`, cfn-lint 1.57.1 data derived from AWS docs [16]):**

| Runtime | Deprecated | Create blocked | Update blocked |
|---|---|---|---|
| nodejs20.x | 2026-04-30 | 2027-02-01 | 2027-03-03 |
| nodejs22.x | 2027-04-30 | 2027-06-01 | 2027-07-01 |
| nodejs24.x | 2028-04-30 | 2028-06-01 | 2028-07-01 |

  **Inference:** `nodejs24.x` on arm64 is the sensible target. `nodejs20.x` is already past its deprecation date.
- **Pricing (us-east-1, Price List published 2026-09-19 [14][primary]).**

| | arm64 | x86_64 |
|---|---|---|
| Duration, first tier | $0.0000133334/GB-s (first 7.5 billion GB-s) | $0.0000166667/GB-s (first 6 billion GB-s) |
| Later tiers | $0.0000120001, then $0.0000106667 | $0.0000150000, then $0.0000133334 |
| Requests | $0.20 per million | $0.20 per million |

  arm64 duration is 20% cheaper [14][15]. Free tier: 1 million requests and 400,000 GB-s per month [15][primary, search-summary].
- **Memory and CPU.** 128 MB to 10,240 MB; 1,769 MB is one vCPU-equivalent; timeout 900 s [12][primary archived].
- **Payload limits.** Synchronous 6 MB each way; asynchronous 256 KB [12][4]. A WebSocket message is at most 128 KB [1], so it fits either path (**Inference:**).
- **Cold starts (`[secondary]`).** lambda-perf 2026-04-12, hello-world zip, 10 cold starts each, init duration only [17]. Averages:

| Runtime, arch | 128 MB | 256 MB | 512 MB | 1024 MB |
|---|---|---|---|---|
| nodejs22.x arm64 | 115 ms | 121 ms | 121 ms | 118 ms |
| nodejs24.x arm64 | 122 ms | 119 ms | 134 ms | 128 ms |
| nodejs24.x x86_64 | 142 ms | 139 ms | 140 ms | 147 ms |

  Worst single value about 190 ms for arm64 zip; container images averaged about 200-345 ms, so prefer zip. These are no-dependency functions, so a real handler with AWS SDK clients will be slower.
- **esbuild effect.** Not verified; no credible quantified source found. The table above is only the floor.
- **VPC and NAT.** "By default, Lambda runs your functions in a secure VPC with access to AWS services and the internet." Only functions connected to your own VPC lose internet access and then need NAT or VPC endpoints [18][primary, archived 2023-10]. DynamoDB and `execute-api` are public endpoints, so a non-VPC Lambda needs no NAT gateway.

---

## C. DynamoDB on-demand

### C1. Capacity behavior and limits

| Topic | Fact | Source |
|---|---|---|
| Per-partition ceiling | "3,000 RCUs or 1,000 WCUs" per partition | [19] primary archived 2021-09; [21] secondary agrees |
| Adaptive capacity | Automatic, no cost; boosts hot partitions up to the partition maximum | [19] primary |
| Isolate hot items ("split for heat") | May rebalance so a partition holds only a single hot item, delivering up to 3,000 RCU / 1,000 WCU to that key. Not available for tables with an LSI, or provisioned tables with Streams | [19] primary |
| On-demand scaling | "Instantly accommodates up to double the previous peak traffic"; throttling can occur if you exceed double the previous peak within 30 minutes | [19] primary |
| Initial on-demand throughput | New table: previous peak 2,000 write / 6,000 read units, so up to 4,000 write / 12,000 read immediately | [19] primary archived (may have changed) |
| Warm throughput | `WarmThroughput` (read/write units a table "can instantaneously support") can be raised via `UpdateTable` before a peak | [8] primary API model |
| Maximum on-demand throughput | `OnDemandThroughput` `MaxReadRequestUnits`/`MaxWriteRequestUnits` caps a table; -1 removes the cap | [8] primary API model |
| Per-table default | 40,000 read and 40,000 write request units on-demand | [19] primary; [4] secondary says adjustable |
| Item size | 400 KB, including attribute names | [19] primary |
| `TransactWriteItems` | Up to **100** actions, aggregate 4 MB (the 2021 doc said 25) | [8] primary current; [19] archived |
| `BatchWriteItem` | 25 put/delete requests, 16 MB total, no conditions, unprocessed items must be retried | [8] primary |
| Conditional writes | Supported on Put/Update/Delete and as `ConditionCheck` in transactions | [8] primary |
| Counter with `UpdateItem` | `ADD` is supported ("put, delete, or add attribute values") | [8] primary |
| Transaction cost | Transactional writes cost 2 write request units per 1 KB | [19] primary |
| TTL timing | "DynamoDB typically deletes expired items within two days of expiration." Expired items still appear in reads until deleted. The 2021 doc said "within 48 hours". TTL deletions consume no write throughput | [8][19] primary |

- **Counter contention (Inference).** 400 `ADD` updates/s on one item is about 400 WCU/s for an item of 1 KB or less. That is under the 1,000 WCU/s single-key ceiling [19] but leaves 2.5x headroom. All 400 answers in about 300 ms would exceed it (about 1,300/s). Shard the counter across several items and sum on read, or derive counts from a query.
- **Key design (Inference).** Do not put every answer of a session under one partition key. Use `sessionId#playerId` or a sharded suffix so writes spread across partitions.

### C2. Pricing (us-east-1, Price List published 2026-09-11 [20][primary])

| Item | Price |
|---|---|
| On-demand write request unit | $0.625 per million |
| On-demand read request unit | $0.125 per million |
| Storage | First 25 GB-month free, then $0.25 per GB-month |
| DynamoDB Streams reads | 2.5 million read request units free per month, then $0.0000002 each ($0.02 per 100,000) |
| TTL deletions | Free (no write units consumed) [19] |

- **November 2024 price cut, verified.** Price List version 20241022205153 (effective 2024-10-01) shows $1.25/M write and $0.25/M read. Version 20250113172805 (effective 2024-11-01) shows $0.625/M and $0.125/M [20][primary]. That is a 50% reduction.
- **Streams and Lambda.** Whether Lambda-triggered stream reads are free is **Unverified (background knowledge):** I believe they are not charged, but I could not source it. Even if charged, the rate above makes it negligible for this workload.

---

## D. Fan-out alternatives that also scale to zero

### D1. AWS AppSync Events

- **What it is.** An Event API providing WebSocket pub/sub with channels and channel namespaces. Connection, publish and subscribe authorization are configured separately [8][primary].
- **Auth modes.** `API_KEY`, `AWS_IAM`, `AMAZON_COGNITO_USER_POOLS`, `OPENID_CONNECT`, `AWS_LAMBDA` (only one Lambda authorizer per API). Namespaces can override per-channel publish/subscribe modes, and can run `OnPublish`/`OnSubscribe` handlers (behavior `CODE` or `DIRECT`; Lambda data-source invoke type `REQUEST_RESPONSE` or `EVENT`) [8][primary]. Lambda authorizer result TTL is 0-3,600 s [8].
- **Native broadcast: yes.** AWS describes an Event API as providing "real-time message publishing and message subscriptions over WebSockets" [8][primary]. One published event produces one inbound event, and outbound deliveries are metered separately per 5 KB delivered [4] (Service Quotas text reproduced in a `[secondary]` dump). Secondary snippets describe "outbound broadcasts" to each subscriber as billable operations [23][secondary]. I could not read AWS's own channel-fan-out description.
- **Clients can publish** over the WebSocket (25 publish requests per second per connection) or over HTTP [4][23]. A publish request carries at most 5 events [4]. That a publish request targets a single channel is **Unverified (background knowledge).**
- **Protocol (`[secondary]`, sample-client code [23]).** Endpoint `wss://{realtimeDomain}/event/realtime`; subprotocols `aws-appsync-event-ws` plus `header-<base64url auth JSON>`; `connection_init` then `connection_ack` carrying `connectionTimeoutMs` (about 300 s); server `ka` keep-alives about every 60 s.
- **Quotas (us-east-1 defaults, `[secondary]` dump dated 2025-06-25 [4]; descriptions reproduce AWS Service Quotas text).**

| Quota | Default | Adjustable |
|---|---|---|
| Event API connect requests per second | 2,000 | Yes |
| Inbound events per second per API | 10,000 | Yes |
| Outbound metered events per second per API (one metered event = 5 KB delivered) | 1,000,000 | Yes |
| Publish requests per second per WebSocket connection | 25 | No |
| Request tokens per second per account (publishes consume tokens by resources and 5 KB messages) | 2,000 | Yes |
| Subscriptions per client connection | 200 | Yes |
| Events per publish request | 5 | No |
| Publish payload | 1.2 MB | No |
| Subscription (delivered message) payload | 240 KB | No |
| Channel segments / characters per segment | 5 / 50 | No |
| Channel namespaces per API / Event APIs per Region | 50 / 50 | Yes |
| Authentication providers per API | 50 | No |

  Not found: a subscribers-per-channel limit, maximum connection duration, idle behavior. Not verified.
- **Pricing (Price List published 2026-09-11 [22][primary]).** $1.00 per million Event API operations and $0.08 per million connection minutes. Metering detail (`[secondary]` [23]): operations include inbound publishes, outbound deliveries (per 5 KB), handler invocations, connects, subscribe requests and WebSocket pings; an `OnPublish` handler adds an operation per event.

### D2. AWS IoT Core (MQTT over WebSocket)

- **Pricing (Price List [24][primary]).** $1.00 per million messages (first 1 billion; $0.80 next 4 billion; $0.70 above) and $0.08 per million connection minutes (MQTT). Message metering size is **Unverified (background knowledge):** 5 KB increments.
- **Limits (us-east-1 defaults, `[secondary]` dump [4]; older mirror of the AWS General Reference agrees [24]).**

| Quota | Default | Adjustable |
|---|---|---|
| Connect requests per second per account | 3,000 (the ~2023 mirror said 500) | Yes |
| Inbound / outbound publish requests per second per account | 20,000 / 20,000 | Yes |
| Publish requests per second per connection | 100 | No |
| Subscriptions per connection | 50 | Yes |
| Concurrent connections per account | 500,000 | Yes |
| MQTT payload | 128 KB | No |
| WebSocket connection duration | 24 h | No |
| Keep-alive default | 1,200 s | No |

- **Fit.** One publish is fanned out by the broker (native). Anonymous phone clients need Cognito unauthenticated identities with SigV4 or a custom authorizer Lambda, plus IoT policies per topic (**Inference:**). That is the heaviest client and auth story of the three.

### D3. Comparison for zqhoot (400 subscribers, server-authoritative, some private messages)

| Criterion | API Gateway WebSocket | AppSync Events | IoT Core MQTT/WS |
|---|---|---|---|
| Broadcast | No; N `PostToConnection` calls | Yes | Yes |
| Connection state | You store IDs, handle 410 and lost `$disconnect` | Managed by service | Managed by broker |
| Private message | `PostToConnection` to one ID | Publish to a per-player channel (one publish each, if single-channel per request; namespace auth via handler) | Publish to per-player topic (IoT policy) |
| Price per delivered message | $1.00/M (32 KB) | $1.00/M (5 KB) | $1.00/M |
| Connection minute | $0.25/M | $0.08/M | $0.08/M |
| Join burst | 500/s rate, 500 burst (no) | 2,000/s (adjustable) | 3,000/s (adjustable) |
| Max connection | 2 h; idle 10 min | Not verified | 24 h |
| Auth for anonymous players | Lambda authorizer or logic in `$connect` | API key, Lambda authorizer, or Cognito | Custom authorizer or Cognito identity |
| Client | Plain WebSocket JSON | Custom subprotocol with base64url auth header | MQTT client library |

---

## E. Arithmetic

Unit prices: WebSocket $1.00/M msgs and $0.25/M conn-min [10]; AppSync Events $1.00/M ops and $0.08/M conn-min [22]; HTTP API $1.00/M [10]; Lambda arm64 $0.0000133334/GB-s and $0.20/M requests [14]; DynamoDB $0.625/M WRU and $0.125/M RRU [20].

### E1. One broadcast to 400 connections via API Gateway

- **API calls:** 400 `PostToConnection` (no multicast [8]).
- **Messages billed:** 400 outbound plus 1 inbound host trigger = 401 (each at most 32 KB, so 1 metered message each). Cost 401 x $1.00/M = **$0.000401**.
- **Throttle tokens:** 400 of the 5,000 burst (8%) [2].
- **Assumption:** concurrency N = 50 (the SDK default socket cap [27]); per-call latency L = 30 ms (no published figure exists; sensitivity below); plus 20 ms DynamoDB `Query` (about 47 KB, 12 RRU strongly consistent, at an assumed 120 B per connection item) and 10 ms overhead; 512 MB, arm64.

| L (per call) | Waves (400/50) | First-to-400th spread | Lambda duration | Lambda cost |
|---|---|---|---|---|
| 15 ms | 8 | 120 ms | 150 ms | $0.0000012 |
| **30 ms** | **8** | **240 ms** | **270 ms** | **$0.0000020** |
| 60 ms | 8 | 480 ms | 510 ms | $0.0000036 |
| 100 ms | 8 | 800 ms | 830 ms | $0.0000057 |

  Cost per broadcast at L = 30 ms: $0.000401 + $0.000002 + about $0.000001 DynamoDB = about **$0.0004**. The spread excludes phone-network latency, which is common to all recipients. **Inference:** if 240-800 ms of skew is too much, shard across K parallel Lambda invocations (K = 8 gives about L plus invoke overhead), at the risk of 8 cold starts (about 120-350 ms init [17]).

### E2. The same broadcast via AppSync Events

- One HTTP publish = 1 inbound operation plus 400 outbound deliveries = **401 operations = $0.000401**. The same price as above [22][23].
- **Assumption:** the publishing Lambda makes 1 call of about 50 ms, about 80 ms billed at 512 MB, giving about $0.0000007 including the request.
- Outbound quota use is 400 of 1,000,000 per second [4].
- First-to-last delivery latency is inside the service and not documented. Not verified.
- No `PostToConnection` loop, no connection-table query, and no throttle tokens beyond the single publish request (**Inference:**).

### E3. Full session (400 players, 20 questions, about 30 minutes)

**Assumptions.**
- Lobby 5 minutes with joins spread evenly; average player connected 35 minutes; host 35 minutes.
- **Assumption:** an AppSync publish request targets one channel, so each per-player message is its own publish.
- Per-question sequence: question broadcast, 400 answers, 400 acks, reveal broadcast, 400 per-player results, leaderboard broadcast, plus 3 host control messages.
- Lobby player-count broadcast every 10 s for 5 minutes, averaging 200 recipients.
- End of game: results broadcast plus 400 per-player final results.
- 100% of players answer. All payloads at most 5 KB. Every Lambda at 512 MB, arm64.
- Handler durations: answer 60 ms; `$connect`/`$disconnect`/join 50 ms; question 300 ms; reveal plus scoring plus 800 posts 600 ms; leaderboard 300 ms; lobby tick 200 ms; 10 GB-s allowance for cold starts.
- DynamoDB items at most 1 KB. Per answer: 1 conditional put plus 1 counter update. Per question: 400 score writes. Queries at 12-15 strongly consistent RRU. One state `GetItem` per answer.

**Message count, API Gateway option.**

| Phase | Messages |
|---|---|
| Per question: 2,000 outbound (question, ack, reveal, result, leaderboard x 400) + 400 answers + 3 host = 2,403 | x 20 = 48,060 |
| Lobby joins (400 in + 400 ack) | 800 |
| Lobby player-count updates (30 x 200) | 6,000 |
| Host start | 1 |
| Final results (400 + 400) | 800 |
| **Total billed messages** | **55,661** |

Connection minutes: 400 x 35 + 35 = 14,035.

**API Gateway WebSocket option.**

| Item | Quantity | Cost |
|---|---|---|
| WebSocket messages | 55,661 | $0.0557 |
| Connection minutes | 14,035 | $0.0035 |
| Lambda requests | 9,294 (8,000 answers, 1,202 connect/disconnect/join, 92 host and lobby ticks) | $0.0019 |
| Lambda duration | 295 GB-s (answers 240, connects 30, broadcasts 12, lobby 3, cold 10) | $0.0039 |
| DynamoDB writes | 25,302 WRU | $0.0158 |
| DynamoDB reads | 9,620 RRU | $0.0012 |
| **Total** | | **about $0.082** |

If per-player results are merged into the reveal and leaderboard broadcasts, 8,000 fewer messages save $0.008, giving about $0.074.

**AppSync Events option (hybrid: AppSync for server-to-client push, HTTP API for join and answers).**
- **Why hybrid.** The ack is the HTTP response, so it costs no operation. Answers over the Events WebSocket would need an `OnPublish` handler, and the ack would need a private-channel publish. That is about 32,000 extra operations versus 8,000 HTTP requests, roughly $0.024 more (**Inference:** based on [23] handler-operation metering).
- **Channels.** Each player subscribes to `/game/{sid}/all` and `/game/{sid}/p/{pid}` (2 subscriptions of the 200 allowed).

| Item | Quantity | Cost |
|---|---|---|
| Broadcast publishes (3 per question x 20) x (1 inbound + 400 outbound) | 24,060 ops | |
| Per-player result publishes (8,000 x [1 in + 1 out]) | 16,000 ops | |
| Lobby ticks (30 x [1 + 200]) | 6,030 ops | |
| Final results | 1,201 ops | |
| Connects and subscribes (400 x 3) | 1,200 ops | |
| Keep-alives (**Assumption:** 1 metered op per connection-minute, from the 60 s `ka` [23] and "pings count" [23]) | 14,000 ops | |
| **AppSync operations** | **62,491** | **$0.0625** |
| Connection minutes | 14,035 | $0.0011 |
| HTTP API requests (400 join + 8,000 answers + 92 host and ticks) | 8,492 | $0.0085 |
| Lambda | 8,892 requests, 262 GB-s | $0.0053 |
| DynamoDB | 24,500 WRU, 8,540 RRU (no connection table) | $0.0164 |
| **Total** | | **about $0.094** |

- Merging per-player results into broadcasts: about $0.078.
- If keep-alives are not metered: about $0.080.
- **Take-away (Inference):** the two options are within about $0.01-0.02 of each other per 400-player session (about $0.0002 per player). Cost is not a differentiator.
- **Not included (same either way):** static and media delivery. **Assumption:** 4 MB per player x 400 = 1.6 GB x $0.085/GB [25] = about $0.14 at pay-as-you-go list price before any free tier. CloudFront's Free flat-rate plan ($0; 1 million requests, 100 GB, 5 GB storage, throttled not billed) or a free-tier allowance would bring this near zero [25]. The always-free CloudFront allowance is **Unverified (background knowledge).**

### E4. Idle monthly cost (zero sessions)

| Component | Idle charge | Source |
|---|---|---|
| CloudFront | $0 (per-request and per-GB only; Free plan is $0) | [25] |
| S3 (assume 1 GB site plus media) | 1 GB x $0.023 = **$0.02** | [25] |
| API Gateway (HTTP and WebSocket) | $0 (no fixed fee) | [10] |
| Lambda | $0 | [14] |
| DynamoDB on-demand | $0 (first 25 GB-month free; no minimum) | [20] |
| Cognito, 0-5 host users | $0 (global free tier 0-10,000 MAU on Essentials) | [25] |
| AppSync Events / IoT Core | $0 (no fixed fee in Price List) | [22][24] |
| **Route 53 hosted zone** | **$0.50/month** (first 25 zones; $0.40/M queries) | [25] |
| CloudWatch Logs | $0.03/GB-month storage, $0.50/GB ingest. Set retention or stored logs accumulate | [25] |
| **Avoid:** KMS customer key | $1/month per key | [25] |
| **Avoid:** Secrets Manager | $0.40/secret/month | [25] |
| **Avoid:** WAF | $5/web ACL/month + $1/rule/month | [25] |
| **Avoid:** API Gateway Portals | $125/month | [10] |
| **Avoid:** NAT gateway, provisioned concurrency, Lambda in VPC | Not in this stack | [18] |

**Idle total:** about **$0.02/month** with a non-Route-53 DNS provider, about **$0.52/month** with a Route 53 zone. Domain registration and public ACM certificate costs are **Unverified (background knowledge)**.

---

## F. Risks to the 400-player requirement (default or new account)

| # | Quota | Default | Adjustable via Service Quotas? | Why it matters | Source |
|---|---|---|---|---|---|
| 1 | Lambda concurrent executions | 1,000 established; reduced on new accounts (10 seen `[secondary]`) | Yes | 400 near-simultaneous answers need about 20 concurrent at 50 ms. 10 concurrent means about 100 rps and throttling | [12][28] |
| 2 | Lambda scaling rate | +1,000 executions per 10 s per function | No | 400-connect burst with `$connect` Lambda: about 40 concurrent, well inside | [13][4] |
| 3 | WebSocket new connections rate | 500/s | Yes | 400 joins in 1 s fits | [3][4] |
| 4 | WebSocket new connections burst | 500 | **No** | Only 100 spare. Two simultaneous 400-joins, or a reconnect storm, exceed it. Use client jitter and backoff | [3][4] |
| 5 | Account throttle (all API types) | 10,000 rps / 5,000 burst (2,500/1,250 in some Regions) | Rate yes, burst no | 400 acks plus 400 inbound answers plus broadcasts share the bucket. Pick a Region with the higher default | [2][3] |
| 6 | `PostToConnection` rate | Not documented; 429 also on "client side buffer is full" | Unknown | Cannot size fan-out from a number. Load-test and retry with backoff | [8][26] |
| 7 | WebSocket idle / duration | 10 min / 2 h | No | Lobby longer than 10 minutes needs heartbeat; a 2 h session needs reconnect | [1][3] |
| 8 | Lambda-authorizer per `$connect` | Extra invocation per connect | n/a | Doubles connect-time Lambda load (**Inference:**) | [6] |
| 9 | DynamoDB partition | 1,000 WCU / 3,000 RCU per partition | No | Hot counter and single-partition answer keys | [19] |
| 10 | DynamoDB on-demand initial peak | 4,000 write / 12,000 read units immediately (fresh table, archived) | Warm throughput can be raised | Ample for 400 players. Pre-warm if many sessions start together | [19][8] |
| 11 | AppSync Events request tokens | 2,000/s | Yes | 400 private publishes in 250 ms is about 1,600/s (80% of quota). Merge per-player messages | [4] |
| 12 | AppSync Events publish per connection | 25/s | No | Not an issue at 1 answer per question | [4] |
| 13 | IoT connect rate (if used) | 3,000/s (500 in the older mirror) | Yes | Fine for 400 | [4][24] |

---

## Implications for zqhoot (inference)

1. **The stack holds.** S3 plus CloudFront, HTTP API plus Lambda arm64 on Node 24, DynamoDB on-demand and Cognito all scale to zero. Idle is about $0.02-$0.52/month. A 400-player session costs roughly $0.08-$0.09 at list price, mostly per-message charges.
2. **Realtime transport: keep API Gateway WebSocket as the v1 baseline, and build a thin transport interface** (`broadcast(session, msg)`, `sendTo(player, msg)`) so AppSync Events can be swapped in. The transport is the only piece with real uncertainty, since cost, protocol and quotas are close. AppSync Events removes the fan-out loop, connection table and lost-`$disconnect` problem, and gives a 2,000/s connect rate. Its unverified areas are connection duration and idle limits, subscribers per channel, delivery latency, and more complex per-player channel authorization. IoT Core is not recommended for v1: MQTT clients, IoT policies and anonymous auth add the most complexity for no price advantage.
3. **Protocol design matters more than the transport.** Prefer broadcasts that carry everything (for example one results message with all 400 scores that each client reads its own entry from) over 400 private messages. This removes about 800 posts per question. Consider answers via HTTP API (response is the ack, $1.00/M, no outbound message) or a route response instead of an extra `PostToConnection`.
4. **Fan-out pattern.** Query the connection table (PK = sessionId, items at most 1 KB) so one page returns all 400. Run 50 concurrent `PostToConnection` calls (the SDK default), delete on 410, retry on 429 with jitter. Shard across parallel Lambdas only if measured spread is too high.
5. **Operational guard rails.**
   - Before the first real event, run `aws lambda get-account-settings` and request a Lambda concurrency increase.
   - Add client reconnect jitter.
   - Run a heartbeat under 10 minutes and TTL cleanup.
   - Prefer `us-east-1`, `us-west-2` or `eu-west-1` for higher throttle defaults.
   - Avoid a Lambda authorizer on `$connect` for anonymous players. Validate a signed join token inside the `$connect` integration.
6. **Concurrent sessions.** Request the WebSocket connection-rate and throttle-rate increases early; the connection burst (500) and throttle burst (5,000) cannot be raised.
7. **DynamoDB design.** Shard counters, avoid one hot partition key for answers, and prefer plain conditional writes over transactions (2x cost).

---

## Not verified / open questions

| Item | What I tried | Status |
|---|---|---|
| Exact new-account Lambda concurrency and memory quota | Search-summaries of Lambda quotas pages; archived doc; GitHub code search | Docs say only "reduced". The 10 figure is `[secondary]` |
| `PostToConnection` numeric rate limit and typical latency | Search-summaries of quotas, `@connections` and re:Post pages; GitHub code search | Not documented. Latency figures in E1 are assumptions |
| Whether ping frames reset the 10-minute idle timer | Search-summaries of quotas and pricing pages | Only "ping/pong not metered" found |
| Whether `GetConnection`/`DeleteConnection` are billed | Price List; pricing summaries | Not found |
| AppSync Events launch date; max connection duration; idle timeout; subscribers per channel; delivery latency; ordering | Price List; Service Quotas dump; botocore model; GitHub code search | Not found. Keep-alive about 60 s and `connectionTimeoutMs` about 300 s come from sample-client code only |
| IoT Core message metering size | Price List | Not found (5 KB is background knowledge) |
| Lambda-triggered DynamoDB Streams reads free | Archived docs; Price List; code search | Unverified |
| Quantified esbuild effect on cold start | GitHub code search | No credible source |
| Current DynamoDB on-demand initial throughput and warm-throughput defaults | Archived 2021 docs; botocore model | Numbers from 2021; API exists |
| CloudFront always-free allowance; CloudWatch free tier; Lambda INIT-phase billing (background: billed since 2025) | Price List lacks free tiers | Unverified. The E3 cold-start GB-s allowance is small |
| `nodejs26.x` status | botocore enum only | Exists in the enum. GA and dates unknown |
| Current text of AWS quota pages | Blocked hosts; used search-summaries, archives, mirror, Service Quotas dump | Numbers agree across sources, but the mirror and archives are dated 2021-2023 |

---

## Sources

Primary sources marked P; secondary S. "Search-summary" means I read the page only through a WebSearch summary of it on 2026-09-29.

1. P (search-summary). Current API Gateway pages: WebSocket quotas https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-execution-service-websocket-limits-table.html ; account quotas and throttle defaults https://docs.aws.amazon.com/apigateway/latest/developerguide/limits.html ; integration timeout https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-integration-requests.html
2. P (archived 2023-04-03, `awsdocs` commit 781597d). API Gateway quotas: https://raw.githubusercontent.com/awsdocs/amazon-api-gateway-developer-guide/781597d7e2e5375258f6029786877eb8b435dd0f/doc_source/limits.md
3. P (third-party mirror of the AWS General Reference page, date unknown, about 2023). https://raw.githubusercontent.com/rafty/handson-llm/86c1f55c28f92fffb433c2b4bb205d3b1ec09892/aws_kendra_docs/docs.aws.amazon.com/general/latest/gr/apigateway.html (original: https://docs.aws.amazon.com/general/latest/gr/apigateway.html)
4. S. Service Quotas default-value dumps for us-east-1, commit 1b5234d dated 2025-06-25: https://raw.githubusercontent.com/fanovilla/aws-default-service-quotas/1b5234d266ce370b094fa92e619920bcad1c5cae/quotas/apigateway_quotas.json and the same path with `appsync_quotas.json`, `lambda_quotas.json`, `dynamodb_quotas.json`, `iotcore_quotas.json`
5. P. Protecting WebSocket APIs. Archived: https://raw.githubusercontent.com/awsdocs/amazon-api-gateway-developer-guide/781597d7e2e5375258f6029786877eb8b435dd0f/doc_source/websocket-api-protect.md . Current (search-summary): https://docs.aws.amazon.com/apigateway/latest/developerguide/websocket-api-protect.html
6. P. `$connect`/`$disconnect`. Archived: https://raw.githubusercontent.com/awsdocs/amazon-api-gateway-developer-guide/781597d7e2e5375258f6029786877eb8b435dd0f/doc_source/apigateway-websocket-api-route-keys-connect-disconnect.md . Current (search-summary): https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-route-keys-connect-disconnect.html
7. P. `@connections`. Archived: https://raw.githubusercontent.com/awsdocs/amazon-api-gateway-developer-guide/781597d7e2e5375258f6029786877eb8b435dd0f/doc_source/apigateway-how-to-call-websocket-api-connections.md . Current (search-summary): https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-how-to-call-websocket-api-connections.html ; IAM action `execute-api:ManageConnections` (search-summary): https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-control-access-iam.html
8. P. botocore 1.43.104 AWS API models (`apigatewaymanagementapi`, `apigatewayv2`, `dynamodb`, `appsync`, `lambda`): https://pypi.org/project/botocore/1.43.104/ (files under `botocore/data/`)
9. P. Routes, integrations, selection expressions. Archived: https://raw.githubusercontent.com/awsdocs/amazon-api-gateway-developer-guide/781597d7e2e5375258f6029786877eb8b435dd0f/doc_source/apigateway-websocket-api-routes-integrations.md and `.../apigateway-websocket-api-selection-expressions.md` . Current (search-summary): https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-selection-expressions.html
10. P. AWS Price List, API Gateway, us-east-1, published 2026-09-21: https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonApiGateway/current/us-east-1/index.json
11. P (search-summary). API Gateway pricing page (32 KB metering, ping/pong, free tier): https://aws.amazon.com/api-gateway/pricing/
12. P. Lambda quotas. Archived 2023-10 (`awsdocs` commit 38e9014): https://raw.githubusercontent.com/awsdocs/aws-lambda-developer-guide/38e9014eba7b2de5dff7e353de675d991e58947d/doc_source/gettingstarted-limits.md . Current (search-summary): https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html
13. P (search-summary). https://docs.aws.amazon.com/lambda/latest/dg/scaling-behavior.html ; https://aws.amazon.com/blogs/aws/aws-lambda-functions-now-scale-12-times-faster-when-handling-high-volume-requests/ ; https://aws.amazon.com/about-aws/whats-new/2023/12/aws-lambda-functions-scale-up/
14. P. AWS Price List, Lambda, us-east-1, published 2026-09-19: https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSLambda/current/us-east-1/index.json
15. P (search-summary). https://aws.amazon.com/lambda/pricing/ ; https://aws.amazon.com/blogs/aws/aws-lambda-functions-powered-by-aws-graviton2-processor-run-your-functions-on-arm-and-get-up-to-34-better-price-performance/ ; https://aws.amazon.com/blogs/compute/introducing-tiered-pricing-for-aws-lambda/
16. S. cfn-lint 1.57.1 Lambda runtime lifecycle data: https://pypi.org/project/cfn-lint/1.57.1/ (file `cfnlint/data/AdditionalSpecs/LmbdRuntimeLifecycle.json`)
17. S. Continuous Lambda cold start benchmark, data 2026-04-12: https://raw.githubusercontent.com/maxday/lambda-perf/main/data/2026-04-12.json (method: https://raw.githubusercontent.com/maxday/lambda-perf/main/README.md)
18. P (archived 2023-10). Lambda VPC doc: https://raw.githubusercontent.com/awsdocs/aws-lambda-developer-guide/38e9014eba7b2de5dff7e353de675d991e58947d/doc_source/configuration-vpc.md
19. P (archived 2021-09, `awsdocs` commit bfe8e5e). DynamoDB: https://raw.githubusercontent.com/awsdocs/amazon-dynamodb-developer-guide/bfe8e5ee42f3cae9f0b58580f8d3816d21781d6a/doc_source/{bp-partition-key-design,HowItWorks.ReadWriteCapacityMode,Limits,howitworks-ttl,Streams}.md
20. P. AWS Price List, DynamoDB, us-east-1: current (2026-09-11) https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonDynamoDB/current/us-east-1/index.json ; version 20241022205153 and 20250113172805 under https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonDynamoDB/<version>/us-east-1/index.json
21. S. DynamoDB partition limits restated: https://github.com/aws/agent-toolkit-for-aws (file `skills/specialized-skills/database-skills/amazon-dynamodb/SKILL.md`), via GitHub code search
22. P. AWS Price List, AppSync, us-east-1, published 2026-09-11: https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSAppSync/current/us-east-1/index.json
23. S. AppSync Events metering and protocol snippets, read only as GitHub code-search text fragments (files not fetched): https://github.com/plantonhq/planton (`catalog/aws/awsappsyncapi/cost.yaml`) ; https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop (`cloud-dashboard/src/lib/appsync-realtime.ts`) ; https://github.com/luisleao/aws-amplify-fireworks (`lib/event-client.ts`) ; https://github.com/johnathan-sewell/johnathan-sewell.github.io (`blog/2025/2025-04-25-app-sync/index.md`, "publish is done over HTTP or WebSocket", 240 KB per event) ; https://github.com/Pennsieve/pennsieve-go-core (`docs/realtime-appsync-design.md`, operations list)
24. P. AWS Price List, IoT Core, us-east-1, published 2026-09-11: https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSIoT/current/us-east-1/index.json ; quotas mirror (~2023): https://raw.githubusercontent.com/rafty/handson-llm/86c1f55c28f92fffb433c2b4bb205d3b1ec09892/aws_kendra_docs/docs.aws.amazon.com/general/latest/gr/iot-core.html
25. P. AWS Price List (us-east-1 unless global): CloudFront (2026-09-16) https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonCloudFront/current/index.json ; CloudFront plans https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/CloudFrontPlans/current/index.json ; S3 (2026-09-28) `.../AmazonS3/current/us-east-1/index.json` ; Cognito (2026-09-25) `.../AmazonCognito/current/us-east-1/index.json` ; CloudWatch (2026-09-22) `.../AmazonCloudWatch/current/us-east-1/index.json` ; Route 53 (2026-09-11) `.../AmazonRoute53/current/index.json` ; KMS `.../awskms/current/us-east-1/index.json` ; Secrets Manager `.../AWSSecretsManager/current/us-east-1/index.json` ; WAF (2026-09-14) `.../awswaf/current/us-east-1/index.json` (all under https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/)
26. S (re:Post community threads, search-summary): https://repost.aws/questions/QUa3KEHJgTTJOts1TCBodaxQ/api-gateway-management-api-posttoconnection-rate-limiting ; https://repost.aws/questions/QUf_5CRyaiTtC5HzGmel2HFQ/websocket-broadcasting-messages-issue . AWS sample code (P): https://raw.githubusercontent.com/aws-samples/simple-websockets-chat-app/master/sendmessage/app.js (note: the sample's 410 branch deletes `event.requestContext.connectionId`, the sender, not the stale ID; delete the failing `connectionId` instead)
27. P. AWS SDK for JavaScript v3 source on npm: `@smithy/core` 3.35.0 (throttling error codes include `LimitExceededException`), `@smithy/node-http-handler` 4.12.1 (default `keepAlive: true`, `maxSockets: 50`), `@aws-sdk/client-apigatewaymanagementapi` 3.1142.0: https://www.npmjs.com/package/@smithy/core
28. S. New-account Lambda concurrency of 10: https://github.com/aws/context-ontology-accelerator/blob/fa2ca5da7a7ba83053d09744ed856a2d79769bdd/external-docs/content/deploying.md ; also https://github.com/OneUptime/blog (`posts/2026-02-12-configure-lambda-reserved-concurrency/README.md`) "new accounts can start with reduced quotas". Both via GitHub code search snippets.
