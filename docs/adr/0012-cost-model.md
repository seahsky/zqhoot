# ADR-0012: AWS cost model

Status: accepted (2026-09-29). Unit prices: AWS Price List bulk API, us-east-1, read 2026-09-29 ([aws-realtime](../research/aws-realtime.md) A5, B2, C2, E4). List prices before free tier.

## Unit prices used

| Item                                          | Price                     |
| --------------------------------------------- | ------------------------- |
| API Gateway WebSocket messages (≤ 32 KB each) | $1.00 / million           |
| API Gateway WebSocket connection minutes      | $0.25 / million           |
| API Gateway HTTP API requests                 | $1.00 / million           |
| Lambda arm64 duration                         | $0.0000133334 / GB-second |
| Lambda requests                               | $0.20 / million           |
| DynamoDB on-demand writes                     | $0.625 / million WRU      |
| DynamoDB on-demand reads                      | $0.125 / million RRU      |
| S3 Standard storage                           | $0.023 / GB-month         |
| CloudFront data transfer out (first tier)     | $0.085 / GB               |
| CloudWatch Logs ingestion                     | $0.50 / GB                |

## Idle month (no sessions)

| Component                                                                  | Charge                                                 |
| -------------------------------------------------------------------------- | ------------------------------------------------------ |
| CloudFront, API Gateway, Lambda, DynamoDB requests, Cognito (≤ 10,000 MAU) | $0: pay per use, nothing is always on                  |
| S3: site (≈ 2 MB) + media (assume 1 GB)                                    | 1 GB × $0.023 = **$0.023**                             |
| DynamoDB storage                                                           | < 25 GB, free                                          |
| CloudWatch Logs storage                                                    | Retention 14 days, a few MB ≈ $0.00                    |
| Route 53 hosted zone (only if you use one)                                 | $0.50                                                  |
| **Total**                                                                  | **≈ $0.02/month**, or **≈ $0.52** with a Route 53 zone |

Excluded by design because they carry fixed fees: NAT gateway, provisioned concurrency, KMS customer keys ($1/key), Secrets Manager ($0.40/secret), WAF ($5/web ACL), and API Gateway caching.

## One session: 400 players, 20 questions

**Assumptions.**

- The 20 questions are 15 scored (single-choice / true-false), 2 polls, 1 word cloud (players average 2 entries), 1 open-ended and 1 rating.
- Lobby 5 minutes, game 30 minutes, so each connection lasts about 35 minutes.
- 2 host connections (control + presenter). 10% of players reconnect once.
- Each player sends about 10 heartbeat pings, mostly in the lobby (45 s idle rule).
- Questions stay open 15 s on average, and both host screens poll stats every second.
- Lambda memory 512 MB.

### Messages (API Gateway bills inbound and outbound)

| Flow                                                                                                 | Count                  |
| ---------------------------------------------------------------------------------------------------- | ---------------------- |
| Joins: 400 `join` + 400 `welcome`                                                                    | 800                    |
| Roster deltas to 2 hosts: 400 joins, + 40 reconnects × 2 events                                      | 800 + 160 = 960        |
| Heartbeats: 400 × 10 × (ping + pong)                                                                 | 8,000                  |
| 15 scored questions × (question + answer + ack + reveal + leaderboard = 5 × 400)                     | 30,000                 |
| 4 single-response unscored questions × (4 × 400)                                                     | 6,400                  |
| Word cloud: 400 question + 800 entries + 800 acks + 400 reveal                                       | 2,400                  |
| Host traffic per question: 15 stats polls × 2 hosts × 2 + ≈ 3 commands + ≈ 8 `host.state` = 71; × 20 | 1,420                  |
| End: 400 `ended` + 3                                                                                 | 403                    |
| Reconnects: 40 × (resume + welcome)                                                                  | 80                     |
| **Total**                                                                                            | **≈ 50,460 → $0.0505** |

### Everything else

| Item                              | Arithmetic                                                                                                                                                                                                                                                                                                                 | Cost                               |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Connection minutes                | 402 × 35 = 14,070 × $0.25/M                                                                                                                                                                                                                                                                                                | $0.0035                            |
| HTTP API                          | 400 PIN lookups + ≈ 10 host calls = 410 × $1/M                                                                                                                                                                                                                                                                             | $0.0004                            |
| Lambda requests                   | ≈ 13,500 WebSocket messages in + 884 connect/disconnect + 410 HTTP + 4 warm-up ≈ 14,800 × $0.20/M                                                                                                                                                                                                                          | $0.0030                            |
| Lambda duration                   | answers 8,400 × 40 ms = 336 s; joins 400 × 80 ms = 32 s; pings 4,000 × 5 ms = 20 s; connect/disconnect 884 × 15 ms = 13 s; stats 600 × 60 ms = 36 s; transitions incl. 1 s reveal settle ≈ 41 s; HTTP 410 × 50 ms = 21 s; cold inits ≈ 30 × 0.4 s = 12 s; resumes ≈ 2 s. Total ≈ 513 s × 0.5 GB = 256 GB-s × $0.0000133334 | $0.0034                            |
| DynamoDB writes                   | joins 400 × 6 (transaction of 2 items at 2× + 2 connection items) = 2,400; answers 8,400; connection deletes 884; results 20 × 32 KB = 640; scoreboard 15 × 28 KB = 420; PIN rate-limit counters 400; META ≈ 70; resumes 120; moderation, session creation ≈ 80. ≈ 13,400 WRU × $0.625/M                                   | $0.0084                            |
| DynamoDB reads                    | answers 8,400 × 2 + word-cloud slot reads 800 = 17,600; joins 400 × 20 (PIN, META, player count, connection query) = 8,000; stats 600 × 24 = 14,400; transitions/reveals ≈ 1,200; resumes 680; PIN lookups 800. ≈ 42,700 RRU × $0.125/M                                                                                    | $0.0053                            |
| CloudWatch Logs                   | ≈ 15,000 invocations × ≈ 0.5 KB = 7.5 MB × $0.50/GB                                                                                                                                                                                                                                                                        | $0.0038                            |
| **Subtotal**                      |                                                                                                                                                                                                                                                                                                                            | **≈ $0.078**                       |
| Static app + media via CloudFront | 400 × ≈ 250 KB app bundle = 100 MB; 5 images × 150 KB × 400 phones = 300 MB; 0.4 GB × $0.085                                                                                                                                                                                                                               | ≈ $0.034                           |
| **Total per session**             |                                                                                                                                                                                                                                                                                                                            | **≈ $0.11** (≈ $0.0003 per player) |

**Sensitivity.** Messages are about 65% of the subtotal. Heartbeats are about 16% of all messages, so a longer lobby adds about 400 × 2 × 1.3 messages per minute (≈ $0.001/min). Doubling Lambda memory adds ≈ $0.0034. The new-account 12-month free tiers (1M WebSocket messages, 1M Lambda requests, etc.) would make a first session effectively free. That is not relied on.

## Consequences

- Cost is not a reason to choose AppSync Events over API Gateway: that option's estimate was about $0.094 vs $0.082 in the research's own model ([aws-realtime](../research/aws-realtime.md) E3).
- A dashboard or monitoring stack that runs continuously would dominate the bill. CloudWatch default metrics are free; no custom alarms are created by default.
