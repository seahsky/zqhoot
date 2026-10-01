# W2-ratelimit: shared-state PIN lookup blocking

Owner: Sonnet implementation agent. Reviewer: independent Opus agent.

## Problem

`GET /api/join/:pin` counts only **failed** lookups per IP (`hitRateLimit('pin:'+ip, 30, 60_000)`), because a classroom behind one NAT legitimately makes hundreds of successful lookups. Once an IP is over the limit, every lookup from it must get 429 until the window passes (W2-service spec).

The current implementation keeps that block in a per-instance `pinBlocks` map in `packages/service/src/http-app.ts`. On Lambda, which runs many HTTP containers, a container that hasn't seen the over-limit miss still answers 200 for a valid PIN from a blocked IP. All misses get 429 everywhere, so an attacker who keeps guessing past the limit can still tell a live PIN (200) from a dead one (429). The limit therefore does not stop enumeration.

## Change

1. **Store contract** (`packages/store/src/store.ts`): add a read-only method:
   ```ts
   /** Read-only companion to hitRateLimit: true while the current window's count for `key` is within `limit`. Does not increment. */
   peekRateLimit(key: string, limit: number, windowMs: number, now: number): Promise<boolean>;
   ```
   Semantics must match `hitRateLimit`: the same window arithmetic (`windowStart = now - (now % windowMs)`) and the same key layout. A missing or expired window counts as 0.
2. **Implementations:**
   - `MemoryStore`: read the counter.
   - `DynamoStore`: one strongly consistent `GetItem` on the rate-limit item, treating an expired TTL as absent.
3. **Contract tests** in `packages/store/test/contract.ts`, run for both stores:
   - peek on an unused key → true
   - after `limit` hits → true
   - after `limit + 1` hits → false
   - peek never increments (hit after many peeks still counts from the real count)
   - windows roll over
   - expiry via the injected clock
4. **Service** (`packages/service/src/http-app.ts`):
   - In `GET /api/join/:pin`, call `peekRateLimit('pin:'+ip, 30, 60_000, now)` **before** the lookup. When blocked, return 429 for every lookup, hit or miss.
   - Misses still call `hitRateLimit`.
   - Remove the per-instance `pinBlocks` map entirely.
   - Keep the ordering such that a successful lookup never increments the counter.
5. **Service tests** (`packages/service/test/http.test.ts`, both stores):
   - Two independent `createHttpApp` instances sharing one store (simulating two Lambda containers): drive one IP over the limit on instance A, then a **valid** PIN from the same IP on instance B → 429.
   - A different IP on instance B → 200.
   - After the window passes (fake clock) → 200 again.
   - 400 successful lookups from one IP → all 200.
6. **Docs:** update the rate-limit notes in `packages/service/README.md` and `packages/store/README.md`. `docs/adr/0013-security.md` already states the intended behaviour; do not edit ADRs.

## Files you own

- `packages/store/src/store.ts`, `memory.ts`, `dynamo.ts`, `packages/store/test/contract.ts`, `packages/store/README.md`
- `packages/service/src/http-app.ts`, `packages/service/test/http.test.ts`, `packages/service/README.md`

## Acceptance criteria

1. `pnpm --filter @zqhoot/store test` and `pnpm --filter @zqhoot/service test` pass, with DynamoDB Local at `http://localhost:8000`. Both typechecks pass.
2. No per-instance blocking state remains in `http-app.ts` (grep for `pinBlocks` returns nothing).
3. The two-instance test above exists and passes on both stores.
4. `pnpm exec prettier --check packages/store packages/service` passes.
