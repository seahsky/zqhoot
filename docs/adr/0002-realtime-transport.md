# ADR-0002: Realtime transport

Status: accepted (2026-09-29); HTTP routing amended (2026-09-29, wave 1 gate finding G6)

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
- **HTTP on AWS** is called **directly**: the browser sends API requests to the HTTP API's `execute-api` endpoint (`apiBaseUrl` in `config.json`), cross-origin, with an API Gateway CORS allow-list of the site origin ([ADR-0013](0013-security.md)). CloudFront serves only the static site and `/media/*`. On the VM the same paths are same-origin behind Caddy, and `apiBaseUrl` stays empty.
- **WebSocket** clients also connect directly to the API Gateway endpoint, or to its custom domain when one is configured. Proxying WebSockets through CloudFront to API Gateway would need a path rewrite that we cannot test here without an AWS account.
- **AppSync Events** is the documented swap-in, not a v1 path. The protocol already avoids depending on per-connection delivery order across message types, and `ts` stamping degrades gracefully to one timestamp per publish ([ADR-0005](0005-timing-fairness-scoring.md)).
- **IoT Core** is rejected: MQTT and IoT policies for anonymous phones add the most complexity for no gain.

### Why HTTP no longer goes through CloudFront

The first version routed `/api/*` through CloudFront to keep one origin. Behind CloudFront the Lambda's `requestContext.http.sourceIp` is a CloudFront edge address, so the per-IP limit on failed PIN lookups (30 a minute; [ADR-0013](0013-security.md)) would be shared by everyone behind the same edge, and an attacker enumerating PINs could pick between the CloudFront path and the `execute-api` endpoint to get separate buckets. Calling API Gateway directly makes `sourceIp` the real client address, with nothing to trust or forward.

Rejected: forwarding the viewer's address through CloudFront (a custom origin request policy that includes `CloudFront-Viewer-Address`, or reading `X-Forwarded-For`). It would need a policy that still leaves out `Host` and keeps `Authorization`, and, because the `execute-api` endpoint stays publicly reachable, a way to trust the header only on requests that really came through CloudFront (for example a secret origin header checked in the function). We cannot verify those CloudFront behaviours without an AWS account, and each adds a way to get the rate limit wrong silently.

## Consequences

- We own connection bookkeeping: connection items in DynamoDB, 410 cleanup, and TTL because `$disconnect` is best-effort ([ADR-0007](0007-broadcast.md)).
- The 500 non-adjustable connection burst means two 400-player sessions opening in the same second can see refused connections. Client backoff with full jitter absorbs this ([ADR-0008](0008-reconnect-resume.md)).
- Every HTTP call on AWS is cross-origin, so preflight `OPTIONS` requests precede `POST`/`PUT`/`DELETE` and any call with an `Authorization` header. The API's CORS configuration lets the browser cache a preflight for 86400 s (browsers cap it lower), and API Gateway answers it without invoking the function. The web client sends no cookies, so credentialed CORS is off.
- The CSP `connect-src` on the AWS site must allow the API host ([ADR-0013](0013-security.md)). The API's CORS allow-list needs the site URL and the distribution's CSP would need the API's host, which is a dependency cycle in Terraform, so the CSP allows the Region's `execute-api` hosts with a wildcard instead of the exact host.
- The rate limits on AWS key on `requestContext.http.sourceIp` with no forwarded-header handling: the adapter must not read `X-Forwarded-For` or any other client-supplied address header, which a caller could forge.
- Cross-origin WebSocket on AWS: `$connect` checks the `Origin` header against the configured site origin ([ADR-0013](0013-security.md)).
