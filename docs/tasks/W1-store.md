# W1-store: Store implementations + contract tests

Owner: Sonnet implementation agent. Reviewer: independent Opus agent.

## Goal

Implement the `Store` interface in `packages/store/src/store.ts` twice: `MemoryStore` (for the VM target and tests, with optional JSON-file persistence) and `DynamoStore` (for AWS, single-table design). Also write one contract test suite that both implementations must pass. The DynamoDB run uses DynamoDB Local.

Read first: `docs/adr/0003-state-model-and-dynamodb.md` (key design; follow it exactly or record a deviation), `docs/adr/0006-answers-aggregation-reveal.md`, `docs/adr/0015-vm-deployment.md` (persistence), `packages/store/src/store.ts` (the contract; its doc comments are normative) and `packages/engine/src/model.ts` (records).

## Files you own

- `packages/store/**`. Do not edit `src/store.ts` method signatures; you may add doc comments. If the contract is wrong, implement the closest correct behaviour and report it under deviations.
- Nothing outside `packages/store`. Dependencies already installed: `@aws-sdk/client-dynamodb@3.1142.0` and `@aws-sdk/lib-dynamodb@3.1142.0`. `@aws-sdk/util-dynamodb` is available transitively; if you import it directly, add it to `package.json` at the exact version the lockfile already resolves (`pnpm why @aws-sdk/util-dynamodb`) and report it. Do not add any other dependencies.

## Environment

DynamoDB Local is running at `http://localhost:8000` (in-memory, any region, any credentials). If it's not running when you start, launch it with:

```
cd /opt/dynamodb-local && nohup java -Djava.library.path=./DynamoDBLocal_lib -jar DynamoDBLocal.jar -inMemory -port 8000 > /tmp/ddb-local.log 2>&1 &
```

Tests read the endpoint from `ZQ_DDB_ENDPOINT` (default `http://localhost:8000`). Use a unique table name per test file run.

## Required exports (`src/index.ts`)

```ts
export * from './store.ts'; // Store, ConflictError, result types
export { MemoryStore } from './memory.ts';
export { DynamoStore, type DynamoStoreOptions } from './dynamo.ts';
export { tableDefinition, ensureTable } from './dynamo-schema.ts';
export { RESPONSE_SHARDS, responseShard } from './keys.ts';
export { attachFilePersistence, loadMemoryStore, type FilePersistence } from './persistence.ts';
```

- `new MemoryStore({ now?: () => number })`. Every read treats records with `expiresAt <= now()` as absent. `sweepExpired()` deletes expired sessions and all their dependent records. `toJSON()` and `static fromJSON(data, opts)` round-trip the full state, including rate-limit windows. Store deep copies (`structuredClone`) on write and on read, so callers can never alias internal state.
- `attachFilePersistence(store, path, { debounceMs = 1000 })` returns `{ flush(): Promise<void>; close(): Promise<void> }`. It writes `store.toJSON()` debounced after any mutation, atomically (write `path.tmp`, fsync, rename). `loadMemoryStore(path, opts)` returns a new store, empty if the file doesn't exist. MemoryStore therefore needs an internal mutation hook; keep it private to the package.
- `new DynamoStore({ tableName, client?: DynamoDBDocumentClient, endpoint?, region?, now?: () => number, pageSize?: number })`.
  - `pageSize` sets `Limit` on Queries, so tests can force pagination.
  - The document client uses `marshallOptions: { removeUndefinedValues: true }`.
- `tableDefinition(tableName): CreateTableCommandInput`: PAY_PER_REQUEST, `pk`/`sk` S, GSI `gsi1` on `gsi1pk`/`gsi1sk`, projection ALL. The Terraform module must match this, so document it in a comment.
- `ensureTable(client, tableName)` creates the table if missing and enables TTL on `expiresAt`, ignoring errors from backends that don't support it.
- `responseShard(playerId)` = FNV-1a 32-bit over the UTF-16 code units of `playerId`, modulo `RESPONSE_SHARDS` (4).

## DynamoDB mapping (ADR-0003)

- `expiresAt` in items is **epoch seconds** (DynamoDB TTL format), `Math.ceil(ms/1000)`. Domain objects keep milliseconds. On read, treat `expiresAt * 1000 <= now()` as absent.
- Record bodies are stored as native attributes (lib-dynamodb marshalling) alongside the key attributes. Strip key and TTL attributes when mapping back to records.
- **Quiz**
  - `putQuiz` without `expectedVersion`: `attribute_not_exists(pk)`. With it: `version = :expected`. Condition failure → `ConflictError`.
  - `listQuizzes` uses a `ProjectionExpression`, so full question lists are not read. Store `title`, `questionCount`, `updatedAt` and `version` as top-level attributes.
- **Sessions**
  - `createSession` writes META and SNAP in one `TransactWriteItems`, both `attribute_not_exists(pk)`.
  - META also carries `gsi1pk = HOST#{hostId}` and `gsi1sk = SESS#{createdAt as 13-digit zero-padded ms}#{sessionId}`.
  - `listSessionsByHost` queries `gsi1` descending with `Limit` and maps to `SessionSummary`.
  - The GSI is eventually consistent. Document that newly created sessions may appear after a short delay.
- **`reservePin`**
  - Conditional put of `PIN#{pin}`, allowed if the item doesn't exist _or_ has expired (`attribute_not_exists(pk) OR expiresAt <= :nowSec`). A failed condition returns false.
  - `releasePin`: delete with `sessionId = :sid`, ignoring a failed condition.
- **`addPlayer`**
  - `TransactWriteItems`: Put player (`attribute_not_exists`) and Put `NICK#{nicknameKey}` (`attribute_not_exists`, holding `playerId`).
  - `TransactionCanceledException` with the NICK condition failed → `'nickname-taken'`. Any other cancellation → throw.
- **`updatePlayer`** is an `UpdateItem` with `attribute_exists(pk)`. A missing player throws.
- **Connections**
  - `putConnection` writes both `CONN#{id}/CONN` and `SESS#{sid}/CONN#{id}`, in a `TransactWriteItems` or a `BatchWriteItem` with unprocessed-item retry.
  - `deleteConnection` reads the by-id item to find the session, then deletes both. It is idempotent.
  - `listConnections` queries `begins_with(sk, 'CONN#')` with pagination and filters out expired items.
- **Responses**
  - pk `RESP#{sid}#{qIndex}#{shard}`, sk `P#{playerId}#{slot as 2 digits}`.
  - `putResponse` uses `attribute_not_exists(pk)` and `ReturnValuesOnConditionCheckFailure: 'ALL_OLD'`. On `ConditionalCheckFailedException`, unmarshal the item on the exception into `existing`. Verify in the SDK source whether lib-dynamodb already unmarshals it.
  - `listResponses` runs the 4 shard Queries in parallel, `ConsistentRead: true`, paginated, merged and sorted by (`receivedAt`, `responseId`).
  - `listPlayerResponses` queries the player's shard with `begins_with(sk, 'P#{playerId}#')`.
  - `setResponseStatus` parses `responseId` as `{playerId}-{slot}`, **splitting on the last `-`** because nanoid IDs may contain `-`. It is an UpdateItem with `attribute_exists`.
- **Results.** `RESULT#{qIndex 3-digit padded}`. `listQuestionResults` returns them in index order.
- **Scoreboard.** Conditional create or replace, as `putQuiz`.
- **`hitRateLimit(key, limit, windowMs, now)`**
  - `windowStart = now - (now % windowMs)`.
  - UpdateItem `ADD #c :one`, set `expiresAt` = window end + 60 s, `ReturnValues: 'UPDATED_NEW'`.
  - Return `count <= limit`.
- Strongly consistent reads (`ConsistentRead: true`) for: `getSession`, `getScoreboard`, `getPlayer`, `listPlayers`, `countPlayers`, `listResponses`, `listPlayerResponses`, `getQuestionResult`, `getSessionIdByPin`, `getConnection`. The GSI query cannot be consistent.
- Any error other than an expected condition failure propagates unchanged.

## Contract test suite

`test/contract.ts` exports `runStoreContract(name: string, makeStore: (clock: { now: () => number; set(ms: number): void }) => Promise<Store>)`. `test/memory.test.ts` and `test/dynamo.test.ts` call it. The DynamoDB test must **fail** (not skip) if DynamoDB Local is unreachable, unless `ZQ_SKIP_DYNAMO=1`.

Cover every `Store` method:

- **Happy paths.**
- **Conflicts:** `putQuiz` / `updateSession` / `putScoreboard` version mismatch, create-when-exists.
- **Races with `Promise.all`:**
  - 10 concurrent `addPlayer` with the same `nicknameKey` → exactly one `'ok'`.
  - 10 concurrent `putResponse` for the same identity → exactly one `created`, and the others return the stored record.
  - 20 concurrent `hitRateLimit` → the count is exact.
- **Expiry via the injected clock:** sessions, PIN reuse after expiry, connections, rate-limit windows.
- **Ordering:** `listResponses` across shards; `listSessionsByHost` newest first, with `limit` respected.
- **Pagination:** DynamoStore with `pageSize: 3` and more than 10 items per list.
- **`releasePin`:** only releases for the owning session.
- **`setResponseStatus`** with a `playerId` that contains `-`.
- **`countPlayers` vs `listPlayers`**, including kicked players.
- **Record round-trip:** a fully populated record of every type comes back deep-equal. Include optional fields present and absent, and nested `AnswerPayload` variants.

Also `test/persistence.test.ts`:

- Mutations are debounced into one write.
- `flush` writes immediately.
- A reload yields equal state.
- A write is atomic: there is no partial file if the process dies between writes; simulate by checking the temp-and-rename sequence.
- `sweepExpired` removes dependent records.

## Acceptance criteria

1. `pnpm --filter @zqhoot/store typecheck` and `pnpm --filter @zqhoot/store test` pass, with DynamoDB Local running, and the contract suite runs for both implementations.
2. Every `Store` method is covered by the contract suite for both implementations. The same test code runs for both; implementation-specific tests (pagination, persistence) are in addition to it.
3. The DynamoDB key layout matches ADR-0003. Deviations are documented in the package README and in your report.
4. `packages/store/README.md` documents the key layout, consistency guarantees, expiry semantics and how to run the tests.
5. `pnpm exec prettier --check packages/store` passes. Comments explain non-obvious _why_ only.
