# ADR-0013: Security

Status: accepted (2026-09-29); CORS and CSP `connect-src` amended (2026-09-29, wave 1 gate finding G6); CORS moved into the app and the CSP `connect-src` narrowed to the exact API origin (2026-09-29, G4)

## Decision

### Input validation

- Every WebSocket frame: byte length ≤ 4 KB, then `JSON.parse` in a try/catch, then `ClientMessage.safeParse`. Failures get `error{bad-request}` and count against the rate limit. The engine never sees unvalidated data.
- Every HTTP body and path parameter is parsed with its protocol schema. Quiz bodies also go through `QuizInput` refinements: the correct option must exist, IDs must be unique.
- Nickname and free text are normalised by the engine (NFKC, control and bidi characters stripped or rejected). React escapes text on render. `dangerouslySetInnerHTML` is banned, and a test greps the web source for it.
- Media: declared type allowlist, size enforced by S3 policy or while streaming on the VM, magic-byte check on the VM, no SVG.

### Rate limits

| Limit                       | AWS                                                                                                                                                                                                                                                                                                                                                                             | VM                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| WebSocket message size      | Handler rejects > 4 KB (API Gateway frame cap 32 KB)                                                                                                                                                                                                                                                                                                                            | `ws` `maxPayload` 8 KB, handler 4 KB                            |
| Per-connection message rate | Stage default route throttling (rate 2,000, burst 1,000 per stage) caps the aggregate; per-connection enforcement is not possible without a read per message and is omitted                                                                                                                                                                                                     | Token bucket, 10 msg/s, burst 20; abusers closed with code 1008 |
| Failed PIN lookups          | 30 per IP per minute (`RL#pin#{ip}`), shared by `GET /api/join/:pin` and the WebSocket `join` message. Keyed on API Gateway's `requestContext.http.sourceIp` (HTTP API, not behind CloudFront, [ADR-0002](0002-realtime-transport.md)) or `requestContext.identity.sourceIp` (WebSocket). A blocked IP is refused before the PIN is looked up, so live and dead PINs look alike | same, in memory                                                 |
| Joins per session           | `maxPlayers` (default 500)                                                                                                                                                                                                                                                                                                                                                      | same                                                            |
| Nickname attempts           | 10 per connection (the connection is closed after that)                                                                                                                                                                                                                                                                                                                         | same                                                            |
| Local login                 | n/a                                                                                                                                                                                                                                                                                                                                                                             | 10 per IP per 15 minutes                                        |
| HTTP API                    | Stage throttling: rate 200, burst 400                                                                                                                                                                                                                                                                                                                                           | Token bucket per IP: 20 req/s                                   |

There are no per-IP join caps: a class behind one NAT can legitimately join 400 times from one IP ([realtime-patterns](../research/realtime-patterns.md) 7).

### Transport and headers

- **WebSocket `Origin` check:** `$connect` (AWS) and the upgrade handler (VM) reject an `Origin` that isn't the configured site origin. This blocks cross-site WebSocket hijacking with host credentials.
- **CORS allow-list (AWS):** the browser calls the HTTP API directly at its `execute-api` endpoint, so every call is cross-origin ([ADR-0002](0002-realtime-transport.md)). **The app answers CORS, not API Gateway:** the http Lambda applies Hono's `cors` middleware to `/api/*` (`createHttpApp`'s optional `cors: { origins }` dependency), and the HTTP API has no `cors_configuration`. It allows only the site origin (`ZQ_SITE_ORIGIN`: the CloudFront domain, or the custom domain when one is set) plus any origins in the optional `ZQ_CORS_EXTRA_ORIGINS` (comma-separated, each an exact `https://host` origin): never `*`, and exact string matches rather than patterns. Any other `Origin` gets no `Access-Control-*` header at all.
  - Methods `GET, POST, PUT, DELETE, OPTIONS`; request headers `authorization` and `content-type`; exposed headers `content-disposition` (the results CSV's file name), `retry-after` (so a rate-limited client can read the wait) and `x-request-id`; preflight cached for 86400 s (`Access-Control-Max-Age`; browsers cap it lower).
  - No credentials (`Access-Control-Allow-Credentials` is never sent): hosts send a bearer token in `Authorization`, and no cookie is ever used. The web client must not send `credentials: 'include'`.
  - CORS is not authentication. Every route still validates its input and host routes still verify the JWT; the allow-list only decides which sites' scripts may read responses in a browser.
  - The VM serves the app and the API from one origin, so it needs no CORS: `createHttpApp` gets no `cors` dependency there.
  - Why the app and not API Gateway: an API Gateway CORS configuration needs the site URL, so the API resource would depend on the CloudFront distribution and the distribution's CSP could not name the API's host (a Terraform cycle). An earlier revision broke the cycle with a Region-wide wildcard over the `execute-api` hosts in `connect-src`, which let a script already running on the page talk to any API Gateway API in the Region; that is gone. The Lambda already receives the site origin in its environment without a cycle. With API Gateway adding no CORS headers (it would also discard the function's), the API resource is independent and the CSP names it exactly. The preflight now invokes the function (`ANY /api/{proxy+}` includes `OPTIONS`), which browsers cache.
- **CloudFront response headers policy / Caddy:**
  - `Content-Security-Policy: default-src 'self'; connect-src 'self' {apiOrigin} {wsUrl} {cognitoDomain} {mediaUploadOrigin}; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' {cognitoDomain} {mediaUploadOrigin}`. On the VM `{apiOrigin}` and `{mediaUploadOrigin}` are absent (same-origin API and media).
  - `{apiOrigin}` is the HTTP API's exact origin (`https://{api id}.execute-api.{region}.amazonaws.com`), needed because the browser calls it directly. It is never a wildcard: the Terraform module rejects one, and a test asserts that no `*` appears anywhere in the CSP.
  - `{mediaUploadOrigin}` is the media bucket's regional S3 endpoint (`https://{bucket}.s3.{region}.amazonaws.com`), where the browser posts presigned uploads ([ADR-0011](0011-media.md)).
  - HSTS (1 year), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`.
- TLS everywhere: CloudFront and API Gateway on AWS, Caddy on the VM.

### Secrets

- No secret is in the web bundle or `config.json`.
- **AWS:** there are no application secrets. Cognito verification uses public JWKS, and Lambdas use their IAM roles.
- **VM:** `ZQ_JWT_SECRET` and the admin password hash come from `.env`, which is gitignored; `.env.example` has placeholders. Terraform never writes secrets into state for the serverless target. For the aws-vm target, secrets are passed at deploy time, not in `user_data`.

### Least-privilege IAM

| Function | Allowed                                                                                                                                                                                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| λ ws     | `dynamodb:GetItem, PutItem, UpdateItem, DeleteItem, Query, BatchWriteItem, TransactWriteItems, ConditionCheckItem` on the table ARN; `execute-api:ManageConnections` on `arn:aws:execute-api:{region}:{account}:{apiId}/{stage}/POST/@connections/*` and `DELETE` likewise; logs to its own group |
| λ http   | same DynamoDB actions on the table and `/index/gsi1`; `s3:PutObject` on `{media-bucket}/media/*`; `lambda:InvokeFunction` on λ ws; logs to its own group                                                                                                                                          |

No wildcard resources except the `@connections/*` path segment, which is inherent to the API.

## Consequences

- Without WAF (fixed monthly fee), volumetric abuse on AWS is bounded by API Gateway throttles and Lambda concurrency, not blocked. Operators who need more can attach WAF to the HTTP API stage and CloudFront; that is not in the default stack.
