# ADR-0002: Realtime transport

Status: accepted (2026-09-29)

## Context

The AWS target must scale to zero, so no always-on compute or connection brokers. Candidates researched ([aws-realtime.md](../research/aws-realtime.md) section D):

|                             | API Gateway WebSocket                     | AppSync Events                         | IoT Core MQTT/WS              |
| --------------------------- | ----------------------------------------- | -------------------------------------- | ----------------------------- |
| Broadcast                   | No; one `PostToConnection` per connection | Native                                 | Native                        |
| Price per delivered message | $1.00/M (32 KB units)                     | $1.00/M ops (5 KB units)               | $1.00/M                       |
| Connect burst               | 500/s, burst 500 (burst not adjustable)   | 2,000/s                                | 3,000/s                       |
| Connection lifetime         | 2 h max, 10 min idle                      | Not verified                           | 24 h                          |
| Client                      | Plain WebSocket + JSON                    | Custom subprotocol, base64 auth header | MQTT client                   |
| Per-player private message  | `PostToConnection`                        | Per-player channel + channel auth      | Per-player topic + IoT policy |

A 400-player session costs within about $0.01-0.02 of each other on the first two ([aws-realtime](../research/aws-realtime.md) E3).

## Decision

- **AWS:** API Gateway WebSocket API with routes `$connect`, `$disconnect` and `$default`, all integrated with one Lambda (`ws`). The route selection expression is `$request.body.type`. Only `$default` is defined, so every message reaches the same handler, which validates with zod.
- **VM:** the `ws` library on the Node HTTP server, path `/ws`.
- Both implement the `Transport` port in `packages/service`:
  ```ts
  interface Transport {
    /** Stamps `ts` per recipient, sends, reports which connections are gone. */
    send(
      batch: Array<{ connectionId: string; message: OutboundMessage }>,
    ): Promise<{ gone: string[] }>;
    close(connectionId: string, code?: number): Promise<void>;
  }
  ```
- **HTTP** goes through CloudFront under `/api/*`, so the site, API and media share one origin with no CORS. **WebSocket** clients connect directly to the API Gateway endpoint, or to its custom domain when one is configured. Proxying WebSockets through CloudFront to API Gateway would need a path rewrite that we cannot test here without an AWS account.
- **AppSync Events** is the documented swap-in, not a v1 path. The protocol already avoids depending on per-connection delivery order across message types, and `ts` stamping degrades gracefully to one timestamp per publish ([ADR-0005](0005-timing-fairness-scoring.md)).
- **IoT Core** is rejected: MQTT and IoT policies for anonymous phones add the most complexity for no gain.

## Consequences

- We own connection bookkeeping: connection items in DynamoDB, 410 cleanup, and TTL because `$disconnect` is best-effort ([ADR-0007](0007-broadcast.md)).
- The 500 non-adjustable connection burst means two 400-player sessions opening in the same second can see refused connections. Client backoff with full jitter absorbs this ([ADR-0008](0008-reconnect-resume.md)).
- Cross-origin WebSocket on AWS: `$connect` checks the `Origin` header against the configured site origin ([ADR-0013](0013-security.md)).
