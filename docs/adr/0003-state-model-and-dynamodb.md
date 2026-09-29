# ADR-0003: Session state model and DynamoDB single-table design

Status: accepted (2026-09-29)

## Context

On Lambda every event is handled by a stateless invocation, so state lives in DynamoDB. Answer bursts (400 in about 2 s) must not contend on one item. The per-partition ceiling is 3,000 RCU / 1,000 WCU ([aws-realtime](../research/aws-realtime.md) C1). The answer path reads session state 400 times per burst, so that item must stay small. TTL deletes lazily ("typically within two days"), so expired items can still be read.

## Decision

### Records

Domain records are defined in `packages/engine/src/model.ts`: `SessionMeta`, `QuizSnapshot`, `PlayerRecord`, `ConnectionRecord`, `ResponseRecord`, `Scoreboard`, `StoredQuestionResult`. The `Store` interface in `packages/store/src/store.ts` is the only persistence contract.

- **SessionMeta** (< 1 KB): phase, question index, `openAt`/`deadline`/`closedAt`, lock, `version`. Written only by host commands and the question timer, with `ConditionExpression: version = :expected`.
- **QuizSnapshot**: the quiz frozen at session creation, including answers. Immutable, so each Lambda instance caches it by session ID.
- **Scoreboard**: one item with every player's score, streak and last rank, about 70 bytes per player (28 KB at 400; fits the 400 KB item limit to about 5,000 players). Written only at reveal, by the single host-command path, guarded by `version` and `appliedThrough` so a retried reveal never scores twice.

### Table

One on-demand table. Keys: `pk` (S), `sk` (S). TTL attribute: `expiresAt` (epoch seconds). One GSI.

| Entity | pk | sk | Other key attributes | TTL |
|---|---|---|---|---|
| Quiz | `HOST#{hostId}` | `QUIZ#{quizId}` | | none |
| Session meta | `SESS#{sid}` | `META` | `gsi1pk = HOST#{hostId}`, `gsi1sk = SESS#{createdAt padded}#{sid}` | 30 d |
| Quiz snapshot | `SESS#{sid}` | `SNAP` | | 30 d |
| PIN claim | `PIN#{pin}` | `PIN` | | session expiry, released at end |
| Player | `SESS#{sid}` | `PLAYER#{pid}` | | 30 d |
| Nickname claim | `SESS#{sid}` | `NICK#{nicknameKey}` | | 30 d |
| Connection (by id) | `CONN#{connId}` | `CONN` | | 3 h |
| Connection (by session) | `SESS#{sid}` | `CONN#{connId}` | | 3 h |
| Response | `RESP#{sid}#{qIndex}#{shard}` | `P#{pid}#{slot}` | shard = FNV-1a(pid) mod 4 | 30 d |
| Question result | `SESS#{sid}` | `RESULT#{qIndex padded 3}` | | 30 d |
| Scoreboard | `SESS#{sid}` | `SCORES` | | 30 d |
| Rate-limit window | `RL#{key}` | `W#{windowStart}` | | window end + 60 s |

GSI `gsi1` (`gsi1pk`, `gsi1sk`), projection ALL, sparse (only META items carry it). It serves "list my sessions". No LSI, so item collections have no 10 GB limit and DynamoDB can isolate hot items ([aws-realtime](../research/aws-realtime.md) C1).

### Access patterns

| Pattern | Operation |
|---|---|
| Resolve PIN | GetItem `PIN#{pin}` |
| Join | TransactWriteItems: Put player + Put nickname claim, both `attribute_not_exists(pk)` |
| Count players | Query `SESS#{sid}` begins_with `PLAYER#`, `Select: COUNT` |
| Answer | GetItem `CONN#…`; GetItem META (strongly consistent); PutItem response `attribute_not_exists(pk)` with `ReturnValuesOnConditionCheckFailure: ALL_OLD` |
| Broadcast | Query `SESS#{sid}` begins_with `CONN#` |
| Reveal | 4 × Query `RESP#{sid}#{i}#{0..3}` (consistent) + Query players + GetItem SCORES, then Put RESULT + conditional Put SCORES + conditional Put META |
| Host session list | Query `gsi1` `HOST#{hostId}`, newest first |

### Expiry

Every live-session item carries `expiresAt`. Both stores treat an item with `expiresAt <= now` as absent on read. `MemoryStore` sweeps expired sessions every minute. On `host.end`, the PIN claim is deleted so the PIN can be reused.

## Consequences

- Answers never touch META, SCORES or any shared counter; each lands on one of four partition keys per question. At 400 answers in 300 ms (≈ 1,300/s), each key sees ≈ 330 WCU/s.
- META is read strongly consistently on every answer: about 200 RCU/s during a 2 s burst, against 3,000 per partition.
- Storage for one session is about 2 MB, which costs nothing within the 25 GB free storage.
- The JSON shape of records is stored as native DynamoDB maps via `@aws-sdk/lib-dynamodb` (`removeUndefinedValues: true`).
