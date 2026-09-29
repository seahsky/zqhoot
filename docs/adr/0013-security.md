# ADR-0013: Security

Status: accepted (2026-09-29)

## Decision

### Input validation

- Every WebSocket frame: byte length ≤ 4 KB, then `JSON.parse` in a try/catch, then `ClientMessage.safeParse`. Failures get `error{bad-request}` and count against the rate limit. The engine never sees unvalidated data.
- Every HTTP body and path parameter is parsed with its protocol schema. Quiz bodies also go through `QuizInput` refinements: the correct option must exist, IDs must be unique.
- Nickname and free text are normalised by the engine (NFKC, control and bidi characters stripped or rejected). React escapes text on render. `dangerouslySetInnerHTML` is banned, and a test greps the web source for it.
- Media: declared type allowlist, size enforced by S3 policy or while streaming on the VM, magic-byte check on the VM, no SVG.

### Rate limits

| Limit                       | AWS                                                                                                                                                                         | VM                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| WebSocket message size      | Handler rejects > 4 KB (API Gateway frame cap 32 KB)                                                                                                                        | `ws` `maxPayload` 8 KB, handler 4 KB                            |
| Per-connection message rate | Stage default route throttling (rate 2,000, burst 1,000 per stage) caps the aggregate; per-connection enforcement is not possible without a read per message and is omitted | Token bucket, 10 msg/s, burst 20; abusers closed with code 1008 |
| Failed PIN lookups          | 30 per IP per minute (`RL#pin#{ip}`)                                                                                                                                        | same, in memory                                                 |
| Joins per session           | `maxPlayers` (default 500)                                                                                                                                                  | same                                                            |
| Nickname attempts           | 10 per connection (the connection is closed after that)                                                                                                                     | same                                                            |
| Local login                 | n/a                                                                                                                                                                         | 10 per IP per 15 minutes                                        |
| HTTP API                    | Stage throttling: rate 200, burst 400                                                                                                                                       | Token bucket per IP: 20 req/s                                   |

There are no per-IP join caps: a class behind one NAT can legitimately join 400 times from one IP ([realtime-patterns](../research/realtime-patterns.md) 7).

### Transport and headers

- **WebSocket `Origin` check:** `$connect` (AWS) and the upgrade handler (VM) reject an `Origin` that isn't the configured site origin. This blocks cross-site WebSocket hijacking with host credentials.
- **CloudFront response headers policy / Caddy:**
  - `Content-Security-Policy: default-src 'self'; connect-src 'self' {wsUrl} {cognitoDomain}; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' {cognitoDomain}`
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
