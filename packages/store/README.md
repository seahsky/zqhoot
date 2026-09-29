# @zqhoot/store

Implementations of the `Store` interface in [`src/store.ts`](src/store.ts), the only persistence
contract of the engine. Design: [ADR-0003](../../docs/adr/0003-state-model-and-dynamodb.md) (key
design), [ADR-0006](../../docs/adr/0006-answers-aggregation-reveal.md) (answer writes) and
[ADR-0015](../../docs/adr/0015-vm-deployment.md) (VM persistence).

| Export                                                            | Use                                                                |
| ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| `MemoryStore`                                                     | VM target and tests. `toJSON()` / `fromJSON()` for the whole state |
| `attachFilePersistence`, `loadMemoryStore`                        | Debounced, atomic JSON file for `MemoryStore`                      |
| `DynamoStore`                                                     | AWS target, single table                                           |
| `tableDefinition`, `ensureTable`                                  | The table both the tests and Terraform must create                 |
| `RESPONSE_SHARDS`, `responseShard`                                | Response partition sharding                                        |
| `ConflictError`, `NotFoundError`, result types, `MemoryStoreData` | Errors and types                                                   |

## Errors

- `ConflictError`: a version check or a create-when-exists failed. Callers re-read and re-decide.
- `NotFoundError`: `updatePlayer` or `setResponseStatus` targeted a record that does not exist
  (or has expired). Any other error (throttling, network, a missing table) propagates unchanged.

## DynamoDB key layout

One on-demand table, keys `pk` (S) and `sk` (S), TTL attribute `expiresAt`, one GSI. This matches
ADR-0003; `tableDefinition()` in [`src/dynamo-schema.ts`](src/dynamo-schema.ts) is the source of
truth that the Terraform `data` module mirrors (PAY_PER_REQUEST, `gsi1` on `gsi1pk`/`gsi1sk`,
projection ALL, TTL on `expiresAt`).

| Entity                  | pk                            | sk                              | Other attributes                                                                      | TTL (`expiresAt`, seconds)   |
| ----------------------- | ----------------------------- | ------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------- |
| Quiz                    | `HOST#{ownerId}`              | `QUIZ#{quizId}`                 | `questionCount`                                                                       | none                         |
| Session meta            | `SESS#{sid}`                  | `META`                          | `gsi1pk = HOST#{hostId}`, `gsi1sk = SESS#{createdAt, 13 digits}#{sid}`, `expiresAtMs` | `meta.expiresAt`             |
| Quiz snapshot           | `SESS#{sid}`                  | `SNAP`                          |                                                                                       | `meta.expiresAt` at creation |
| PIN claim               | `PIN#{pin}`                   | `PIN`                           | `sessionId`                                                                           | `expiresAt` argument         |
| Player                  | `SESS#{sid}`                  | `PLAYER#{playerId}`             |                                                                                       | `expiresAt` argument         |
| Nickname claim          | `SESS#{sid}`                  | `NICK#{nicknameKey}`            | `playerId`                                                                            | `expiresAt` argument         |
| Connection (by id)      | `CONN#{connId}`               | `CONN`                          | `expiresAtMs`                                                                         | `conn.expiresAt`             |
| Connection (by session) | `SESS#{sid}`                  | `CONN#{connId}`                 | `expiresAtMs`                                                                         | `conn.expiresAt`             |
| Response                | `RESP#{sid}#{qIndex}#{shard}` | `P#{playerId}#{slot, 2 digits}` | shard = FNV-1a 32 over UTF-16 code units of `playerId`, mod 4                         | `expiresAt` argument         |
| Question result         | `SESS#{sid}`                  | `RESULT#{qIndex, 3 digits}`     |                                                                                       | `expiresAt` argument         |
| Scoreboard              | `SESS#{sid}`                  | `SCORES`                        |                                                                                       | `expiresAt` argument         |
| Rate-limit window       | `RL#{key}`                    | `W#{windowStart}`               | `count`                                                                               | window end + 60 s            |

Record bodies are stored as native attributes beside the key attributes (lib-dynamodb marshalling,
`removeUndefinedValues: true`) and the key and TTL attributes are stripped when mapping back. A
client passed to `DynamoStore` must be configured with the same marshalling option.

Operations, as implemented:

- Conditions on items that have a TTL treat an expired item that DynamoDB has not deleted yet as
  absent. A create is guarded by `attribute_not_exists(pk) OR expiresAt <= :nowSec` (written
  `ABSENT_OR_EXPIRED` in `dynamo.ts`), a replace or update by `... AND expiresAt > :nowSec`.
  Quizzes have no TTL and use the plain conditions.
- `putQuiz`: `attribute_not_exists(pk)` to create, `version = :expected` to replace.
  `putScoreboard`: the create condition above to create, and to replace
  `version = :expected AND expiresAt > :nowSec`.
- `createSession`: one `TransactWriteItems` with META and SNAP, both with the create condition.
  `updateSession`: a `Put` of META guarded by `version = :expected AND expiresAt > :nowSec`.
- `reservePin`: the create condition `OR sessionId = :sid`, so the session that holds a PIN can
  claim it again (which renews it) and only another live session is refused. `releasePin`: delete
  guarded by `sessionId = :sid`.
- `addPlayer`: `TransactWriteItems` of the player and its `NICK#` claim, both with the create
  condition. A failed nickname claim gives `'nickname-taken'`; a failed player put (same
  `playerId` again) throws `ConflictError`. `updatePlayer` is guarded by
  `attribute_exists(pk) AND expiresAt > :nowSec`.
- `putConnection` / `deleteConnection`: a transaction each, so the by-id and by-session items
  never disagree. `deleteConnection` reads the by-id item first to find the session.
  `putConnection` reads it too: when the connection was registered under another session, the
  same transaction deletes that session's by-session item, and the by-id put is conditional on
  the session that was read. If a concurrent put moved the connection in between, the read and
  the transaction are repeated (three attempts, then `ConflictError`).
- `putResponse`: the create condition with `ReturnValuesOnConditionCheckFailure: ALL_OLD`.
  On a duplicate the stored record comes from the exception itself, without another read.
  lib-dynamodb unmarshalls only successful outputs (`unmarshallOutput` in its command base), so
  the item on `ConditionalCheckFailedException` is still in raw `AttributeValue` form and is
  converted with `@aws-sdk/util-dynamodb`.
- `listResponses`: four consistent Queries in parallel (one per shard), each paginated, merged and
  sorted by (`receivedAt`, `responseId`).
- `setResponseStatus`: the `responseId` is `{playerId}-{slot}`, split on the **last** `-`
  (nanoid ids may contain `-`); an `UpdateItem` guarded by
  `attribute_exists(pk) AND expiresAt > :nowSec`.
- `hitRateLimit`: `windowStart = now - now % windowMs`, `UpdateItem ADD count 1`, returns
  `count <= limit`.
- `peekRateLimit`: the same `windowStart` and key, one strongly consistent `GetItem` on the
  rate-limit item (no write). An item past its TTL counts as absent, so the answer is
  `(count ?? 0) <= limit`. The service calls it before a PIN lookup so that a block set through one
  Lambda container is seen by all.
- Transactions cancelled only by concurrent transactions on the same items (`TransactionConflict`,
  `ThrottlingError`) are retried up to eight times with jittered backoff; real condition
  failures are never retried.

### The GSI is eventually consistent

`listSessionsByHost` queries `gsi1` (newest first), and DynamoDB cannot read a GSI consistently. A
session created a moment ago may appear in the list after a short delay. Anything that needs the
session right after creating it must use `getSession` (consistent) or the ID it already has.

### Table setup

`ensureTable(client, name)` creates the table if it is missing, waits until it is active and
enables TTL on `expiresAt`, ignoring errors from backends without TTL support. It is meant for
tests and local development. Production tables are created by Terraform.

## Consistency guarantees

- Consistent reads (`ConsistentRead: true`): `getSession`, `getSnapshot`, `getScoreboard`,
  `getPlayer`, `listPlayers`, `countPlayers`, `listResponses`, `listPlayerResponses`,
  `getQuestionResult`, `getSessionIdByPin`, `getConnection` (the spec's list), and also
  `getQuiz`, `listQuizzes`, `listQuestionResults`, `listConnections` and the read inside
  `deleteConnection`. The extra ones keep read-your-writes for the quiz editor and make sure a
  broadcast reaches a connection that was registered a moment ago.
- The only eventually consistent read is `listSessionsByHost` (GSI, see above).
- Every conditional operation is atomic: the condition and the write are one DynamoDB request or
  transaction (`MemoryStore` gets the same effect from running each method without yielding).
- Ordering: `listResponses` by (`receivedAt`, `responseId`); `listPlayerResponses` by slot;
  `listQuestionResults` by question index; `listSessionsByHost` by `createdAt` descending, ties by
  session id descending; `listQuizzes` by `updatedAt` descending, ties by id; `listPlayers` and
  `listConnections` by id. Both implementations return the same order.

## Expiry

Both stores treat a record whose `expiresAt` has passed as absent on every read.

- **Domain records keep milliseconds** (`SessionMeta.expiresAt`, `ConnectionRecord.expiresAt`, the
  `expiresAt` arguments). In DynamoDB the item attribute `expiresAt` is **epoch seconds**,
  `Math.ceil(ms / 1000)`, because that is what TTL reads. An item is expired when
  `expiresAt * 1000 <= now()`. So `DynamoStore` has one-second granularity: a record that expires
  at `t` ms lives until the next whole second. `MemoryStore` is exact to the millisecond.
- SessionMeta and ConnectionRecord would collide with the TTL attribute, so their millisecond value
  is also stored as `expiresAtMs` and restored on read. It round-trips exactly.
- DynamoDB deletes expired items lazily (typically within two days), so an expired item can
  linger. Reads filter it out, and so do the conditions of every write: a create may replace an
  expired item (`createSession`, `addPlayer`, `putResponse`, `putScoreboard`, `reservePin`), and
  an update or a version-checked replace of one fails like it would for a missing item
  (`updatePlayer` and `setResponseStatus` throw `NotFoundError`, `updateSession` and
  `putScoreboard` throw `ConflictError`). An update can therefore never bring an expired record
  back. Both stores behave the same here.
- One difference remains for a reused session ID. `MemoryStore.createSession` over an expired
  session first drops that session's records, as `sweepExpired` would. DynamoDB cannot do that,
  so records of the old session that outlive its META (their own `expiresAt` is later) are seen
  by the new one. IDs are random, so this needs an ID collision.
- The snapshot expires with the session's `expiresAt` **at creation**. `updateSession` does not
  refresh it.
- `MemoryStore.sweepExpired()` frees expired records: whole sessions whose meta has expired
  (with players, nickname claims, connections, responses, results, scoreboard, snapshot and PIN
  claim) and any other record past its own expiry, including rate-limit windows. It does not
  schedule itself; the hosting process should call it periodically (ADR-0003: once a minute).
  It notifies persistence when it removed something.
- A rate-limit window is chosen by the `now` argument, not by the store clock, and lives until its
  window end plus 60 s. `MemoryStore` starts a fresh count when it meets a window past that time;
  DynamoDB would keep counting an expired window that TTL has not deleted yet. The two only differ
  if a caller passes a `now` far in the past.
  `peekRateLimit` reads the same window without changing it and treats an expired one as empty in
  both stores.
- `reservePin` returns `false` only when another live session holds the PIN. The session that
  holds it may claim it again, which replaces the claim and its expiry.

## MemoryStore persistence

`new MemoryStore({ now? })` keeps everything in maps and deep-copies (`structuredClone`) on write
and on read, so callers never alias internal state. `toJSON()` returns the whole state (including
rate-limit windows and expiry times) as plain data and `MemoryStore.fromJSON(data, opts)` restores
it.

```ts
const store = loadMemoryStore(`${dataDir}/state.json`); // empty store if the file is missing
const persistence = attachFilePersistence(store, `${dataDir}/state.json`, { debounceMs: 1000 });
// on SIGTERM
await persistence.close(); // final write, then stop
```

- The first mutation after a write starts a `debounceMs` timer, and the state is written when it
  fires. Further mutations do not restart the timer, so a busy session is still saved every
  `debounceMs` (ADR-0015 promises about a second of staleness).
- A write goes to `state.json.tmp`, is `fsync`ed, then renamed over `state.json`, and the
  directory is `fsync`ed so the rename survives a power loss (best effort: a filesystem that
  cannot sync a directory is ignored). A crash leaves either the old or the new complete file,
  never a partial one. A stale `.tmp` file is overwritten by the next write.
- The file is created with mode `0600`: it holds every quiz with its answers and every player's
  token hash.
- Saving stringifies the internal state directly (no `toJSON()` deep clone), one synchronous pass
  on the event loop per write.
- `flush()` writes now (after any write in flight). `close()` writes once more and stops
  listening. Failed background writes go to `onError` (default `console.error`); `flush()` and
  `close()` reject instead.
- `loadMemoryStore` is synchronous. A corrupt or unknown-format file throws instead of silently
  starting empty. Persisted connection records refer to sockets that no longer exist after a
  restart; the server should clear or ignore them at startup.

## Running the tests

```sh
pnpm --filter @zqhoot/store typecheck
pnpm --filter @zqhoot/store test
```

The contract suite (`test/contract.ts`, `runStoreContract`) runs against `MemoryStore`
(`test/memory.test.ts`) and twice against `DynamoStore` (`test/dynamo.test.ts`: with `pageSize: 3`
to force pagination everywhere, and with default paging). The DynamoDB tests need DynamoDB Local:

```sh
cd /opt/dynamodb-local && nohup java -Djava.library.path=./DynamoDBLocal_lib -jar DynamoDBLocal.jar -inMemory -port 8000 > /tmp/ddb-local.log 2>&1 &
curl -s -o /dev/null -w '%{http_code}' http://localhost:8000   # 400 means it is up
```

| Variable          | Default                 | Meaning                                                                             |
| ----------------- | ----------------------- | ----------------------------------------------------------------------------------- |
| `ZQ_DDB_ENDPOINT` | `http://localhost:8000` | DynamoDB endpoint used by the tests                                                 |
| `ZQ_SKIP_DYNAMO`  | unset                   | `1` skips the DynamoDB tests. Without it, an unreachable endpoint **fails** the run |

Each run creates its own tables (`zqhoot-test-*`) and drops them afterwards, so several runs can
share one DynamoDB Local. Every test uses unique IDs. Test clocks start in the year 2100 so
DynamoDB Local's own TTL sweeper never deletes test data.

Other files: `test/persistence.test.ts` (debouncing, atomic write sequence with injected failures,
reload, `sweepExpired`), `test/dynamo-errors.test.ts` (scripted SDK errors, no DynamoDB needed),
`test/keys.test.ts`.

## Deviations from ADR-0003 and the task spec

1. `expiresAtMs` on META and connection items (see Expiry). The ADR does not say how a
   millisecond domain field and the seconds TTL attribute share a name.
2. More consistent reads than the spec lists (see Consistency).
3. `NotFoundError` is a new export, thrown for a missing record on `updatePlayer` and
   `setResponseStatus`; a `responseId` that is not `{playerId}-{slot}` counts as missing.
4. `addPlayer` with an existing `playerId` (and a free nickname) throws `ConflictError`.
   With both the player and the nickname taken it returns `'nickname-taken'`.
5. Transaction retries on `TransactionConflict` / `ThrottlingError` (not in the spec).
6. `listSessionsByHost` filters expired items and keeps querying until `limit` live sessions are
   found, because `Limit` counts items before that filter.
7. `@aws-sdk/util-dynamodb@3.996.9` (the version the lockfile already resolved) is a direct
   dependency, only for unmarshalling the item on `ConditionalCheckFailedException`. The lockfile
   importer entry for this package was updated accordingly.
8. Persistence: the timer is not restarted by later mutations, `onError` option, synchronous
   `loadMemoryStore`, and `flush()` always writes.
9. `sweepExpired()` is not self-scheduling.
10. `reservePin` also succeeds for the session that already holds the PIN (the condition gains
    `OR sessionId = :sid`). This is the meaning of the `store.ts` doc comment ("False if another
    live session holds it"), which is unchanged; the task spec's condition alone would refuse the
    holder.
11. Every conditional write on an item with a TTL treats an expired item as absent (see Expiry),
    not just `reservePin`: the create conditions are
    `attribute_not_exists(pk) OR expiresAt <= :nowSec` instead of plain `attribute_not_exists(pk)`,
    and `updatePlayer`, `setResponseStatus`, `updateSession` and
    `putScoreboard` add `expiresAt > :nowSec`. This makes the contract's "records past
    `expiresAt` must not be returned" hold for writes as well, and matches `MemoryStore`.
12. `putConnection` reads the by-id item first (one extra consistent read per call) so that a
    connection moved to another session leaves no stale by-session item.
13. `listSessionsByHost` accepts an infinite `limit` in both stores and then returns every live
    session.
14. Persistence writes the state file with mode `0600` and syncs the directory after the rename.
