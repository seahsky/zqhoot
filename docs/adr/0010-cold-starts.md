# ADR-0010: Cold start mitigation without losing scale-to-zero

Status: accepted (2026-09-29)

## Context

A cold `nodejs24.x` arm64 zip function initialises in about 115-135 ms for hello-world, per a secondary benchmark ([aws-realtime](../research/aws-realtime.md) B2). Ours load the AWS SDK, zod and the engine, so we expect several hundred ms. Provisioned concurrency is ruled out (always-on cost).

## Decision

1. **Small bundles.** esbuild, ESM, `platform: node`, `target: node24`, minified, tree-shaken. The needed AWS SDK v3 clients are bundled instead of relying on the runtime's copy, which pins versions and lets tree-shaking work. Source maps go to a separate file.
2. **arm64, 512 MB** for both functions (Terraform variables). More memory buys CPU, which shortens init and fan-out.
3. **Init outside the handler:** SDK clients, the JWKS verifier and the zod schemas are created at module scope.
4. **Warm-up when the lobby opens.** After creating a session, λ http invokes λ ws N times concurrently (default 4, variable `warm_concurrency`) with `{"warmup":true}`, `InvocationType: 'Event'`. The warm-up handler waits 200 ms so concurrent invocations land on separate execution environments, and touches DynamoDB so TLS sessions are established. The lobby then generates steady traffic (joins, host pings), which keeps those environments warm into the game.
5. **Timing is immune to cold starts.** `receivedAt` comes from API Gateway's `requestTimeEpoch` ([ADR-0005](0005-timing-fairness-scoring.md)), so a cold start delays the ack, not the score.

## Consequences

- The warm-up costs 4 invocations × about 0.3 s × 0.5 GB ≈ 0.6 GB-s per session, well under a cent.
- Nothing runs when no session is open.
- The first join after a long idle on the HTTP side (PIN lookup) still pays one cold start of λ http. That is acceptable.
