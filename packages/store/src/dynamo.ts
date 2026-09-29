import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type QueryCommandInput,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type {
  ConnectionRecord,
  PlayerRecord,
  QuizSnapshot,
  ResponseRecord,
  Scoreboard,
  SessionMeta,
  StoredQuestionResult,
} from '@zqhoot/engine';
import type { ModerationStatus, Quiz, QuizSummary, SessionSummary } from '@zqhoot/protocol';
import { TTL_ATTRIBUTE } from './dynamo-schema.ts';
import { NotFoundError } from './errors.ts';
import {
  CONN_SK_PREFIX,
  GSI1,
  PLAYER_SK_PREFIX,
  QUIZ_SK_PREFIX,
  RESPONSE_SHARDS,
  RESULT_SK_PREFIX,
  connByIdKey,
  connBySessionKey,
  hostPk,
  metaKey,
  nickKey,
  parseResponseId,
  pinKey,
  playerCountKey,
  playerKey,
  quizKey,
  rateLimitKey,
  responseKey,
  responsePk,
  responsePlayerPrefix,
  responseShard,
  resultKey,
  scoresKey,
  sessionGsiSk,
  sessionPk,
  snapshotKey,
  type ItemKey,
} from './keys.ts';
import {
  ConflictError,
  type AddPlayerResult,
  type PutResponseResult,
  type Store,
} from './store.ts';

export interface DynamoStoreOptions {
  tableName: string;
  /**
   * A document client to use. It must be configured with
   * `marshallOptions: { removeUndefinedValues: true }`. Built from `endpoint` and `region` when
   * omitted.
   */
  client?: DynamoDBDocumentClient;
  /** Custom endpoint, e.g. DynamoDB Local. Ignored when `client` is given. */
  endpoint?: string;
  /** Ignored when `client` is given. */
  region?: string;
  /** Epoch-millisecond clock used to decide whether an item has expired. Default `Date.now`. */
  now?: () => number;
  /** `Limit` of every Query. Unset means DynamoDB's own 1 MB page. Tests set it to force paging. */
  pageSize?: number;
}

type Item = Record<string, unknown>;
type TransactItems = NonNullable<TransactWriteCommandInput['TransactItems']>;
type CancellationReason = { Code?: string };

const KEY_ATTRIBUTES = ['pk', 'sk', 'gsi1pk', 'gsi1sk', TTL_ATTRIBUTE];
const RETRYABLE_CANCELLATIONS = new Set([
  'TransactionConflict',
  'ThrottlingError',
  'ProvisionedThroughputExceeded',
]);
const TRANSACTION_ATTEMPTS = 8;
const CONNECTION_ATTEMPTS = 3;
/**
 * Errors of a request DynamoDB refused before it ran anything (throttling, once the SDK's own
 * retries are used up, and a malformed request), so nothing was written. A timeout, a network
 * error or a 5xx is not among them: the write may have committed before the reply was lost.
 */
const REFUSED_BEFORE_EXECUTION = new Set([
  'ThrottlingException',
  'ProvisionedThroughputExceededException',
  'RequestLimitExceeded',
  'ValidationException',
]);

/**
 * Conditions on TTL'd items. DynamoDB deletes expired items lazily (ADR-0003), so a bare
 * `attribute_not_exists` or `attribute_exists` would treat an expired item as still there.
 */
const ABSENT_OR_EXPIRED = 'attribute_not_exists(pk) OR #ttl <= :nowSec';
const LIVE = 'attribute_exists(pk) AND #ttl > :nowSec';

const toSeconds = (ms: number): number => Math.ceil(ms / 1000);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const errorName = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null ? (error as { name?: string }).name : undefined;
const isConditionFailed = (error: unknown): boolean =>
  errorName(error) === 'ConditionalCheckFailedException';
const cancellationReasons = (error: unknown): CancellationReason[] | undefined =>
  errorName(error) === 'TransactionCanceledException'
    ? ((error as { CancellationReasons?: CancellationReason[] }).CancellationReasons ?? [])
    : undefined;
const failedCondition = (reason: CancellationReason | undefined): boolean =>
  reason?.Code === 'ConditionalCheckFailed';
/** Whether a failed `TransactWriteItems` is known not to have written anything. */
const wroteNothing = (error: unknown): boolean =>
  error instanceof ConflictError ||
  cancellationReasons(error) !== undefined ||
  REFUSED_BEFORE_EXECUTION.has(errorName(error) ?? '');

/** Builds the stored item: record body, extra attributes, keys, and the TTL in epoch seconds. */
function toItem(key: ItemKey, body: object, expiresAtMs?: number, extra: Item = {}): Item {
  const item: Item = { ...body, ...extra, ...key };
  if (expiresAtMs !== undefined) item[TTL_ATTRIBUTE] = toSeconds(expiresAtMs);
  return item;
}

/** Inverse of `toItem` for records without a domain `expiresAt`. */
function toRecord<T>(item: Item, extraAttributes: string[] = []): T {
  const record = { ...item };
  for (const attribute of [...KEY_ATTRIBUTES, ...extraAttributes]) delete record[attribute];
  return record as T;
}

/**
 * Records whose domain `expiresAt` is in milliseconds (SessionMeta, ConnectionRecord) would
 * collide with the TTL attribute, so the millisecond value is kept as `expiresAtMs`.
 */
function toRecordWithExpiry<T>(item: Item): T {
  const record = toRecord<Item>(item, ['expiresAtMs']);
  record.expiresAt = item.expiresAtMs;
  return record as T;
}

export function createDocumentClient(opts: { endpoint?: string; region?: string } = {}) {
  return DynamoDBDocumentClient.from(
    new DynamoDBClient({
      ...(opts.endpoint !== undefined && { endpoint: opts.endpoint }),
      ...(opts.region !== undefined && { region: opts.region }),
    }),
    { marshallOptions: { removeUndefinedValues: true } },
  );
}

/**
 * `Store` on a single DynamoDB table (ADR-0003). See the package README for the key layout.
 * Reads that the contract requires to be consistent use `ConsistentRead`; the only eventually
 * consistent read is `listSessionsByHost`, which queries the GSI.
 */
export class DynamoStore implements Store {
  readonly #doc: DynamoDBDocumentClient;
  readonly #table: string;
  readonly #now: () => number;
  readonly #pageSize: number | undefined;

  constructor(opts: DynamoStoreOptions) {
    if (opts.pageSize !== undefined && !(Number.isInteger(opts.pageSize) && opts.pageSize > 0)) {
      throw new RangeError('pageSize must be a positive integer');
    }
    this.#table = opts.tableName;
    this.#doc = opts.client ?? createDocumentClient(opts);
    this.#now = opts.now ?? Date.now;
    this.#pageSize = opts.pageSize;
  }

  // --- Quizzes ---------------------------------------------------------------------

  async listQuizzes(ownerId: string): Promise<QuizSummary[]> {
    const items = await this.#query({
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
      ExpressionAttributeNames: {
        '#pk': 'pk',
        '#sk': 'sk',
        '#id': 'id',
        '#title': 'title',
        '#count': 'questionCount',
        '#updated': 'updatedAt',
        '#version': 'version',
      },
      ExpressionAttributeValues: { ':pk': hostPk(ownerId), ':prefix': QUIZ_SK_PREFIX },
      // The question list is the bulk of a quiz; the summary attributes avoid reading it.
      ProjectionExpression: '#id, #title, #count, #updated, #version',
      ConsistentRead: true,
    });
    return items
      .map((i) => ({
        id: i.id as string,
        title: i.title as string,
        questionCount: i.questionCount as number,
        updatedAt: i.updatedAt as number,
        version: i.version as number,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async getQuiz(ownerId: string, quizId: string): Promise<Quiz | null> {
    const item = await this.#get(quizKey(ownerId, quizId));
    return item ? toRecord<Quiz>(item, ['questionCount']) : null;
  }

  async putQuiz(quiz: Quiz, expectedVersion?: number): Promise<void> {
    const item = toItem(quizKey(quiz.ownerId, quiz.id), quiz, undefined, {
      questionCount: quiz.questions.length,
    });
    try {
      await this.#doc.send(
        new PutCommand({
          TableName: this.#table,
          Item: item,
          ...this.#versionCondition(expectedVersion, false),
        }),
      );
    } catch (error) {
      if (isConditionFailed(error)) throw new ConflictError();
      throw error;
    }
  }

  async deleteQuiz(ownerId: string, quizId: string): Promise<void> {
    await this.#doc.send(
      new DeleteCommand({ TableName: this.#table, Key: quizKey(ownerId, quizId) }),
    );
  }

  // --- Sessions --------------------------------------------------------------------

  async reservePin(pin: string, sessionId: string, expiresAt: number): Promise<boolean> {
    try {
      await this.#doc.send(
        new PutCommand({
          TableName: this.#table,
          Item: toItem(pinKey(pin), { sessionId }, expiresAt),
          // The owning session may claim again (store.ts: false only if *another* live session
          // holds the PIN), which also renews the claim.
          ConditionExpression: `${ABSENT_OR_EXPIRED} OR #sid = :sid`,
          ExpressionAttributeNames: { '#ttl': TTL_ATTRIBUTE, '#sid': 'sessionId' },
          ExpressionAttributeValues: { ':nowSec': this.#nowSeconds(), ':sid': sessionId },
        }),
      );
      return true;
    } catch (error) {
      if (isConditionFailed(error)) return false;
      throw error;
    }
  }

  async releasePin(pin: string, sessionId: string): Promise<void> {
    try {
      await this.#doc.send(
        new DeleteCommand({
          TableName: this.#table,
          Key: pinKey(pin),
          ConditionExpression: '#sid = :sid',
          ExpressionAttributeNames: { '#sid': 'sessionId' },
          ExpressionAttributeValues: { ':sid': sessionId },
        }),
      );
    } catch (error) {
      if (!isConditionFailed(error)) throw error;
    }
  }

  async getSessionIdByPin(pin: string): Promise<string | null> {
    const item = await this.#get(pinKey(pin));
    return item ? (item.sessionId as string) : null;
  }

  async createSession(meta: SessionMeta, snapshot: QuizSnapshot): Promise<void> {
    const create = this.#createCondition();
    try {
      await this.#transact([
        { Put: { TableName: this.#table, Item: this.#metaItem(meta), ...create } },
        {
          Put: {
            TableName: this.#table,
            Item: toItem(snapshotKey(meta.sessionId), snapshot, meta.expiresAt),
            ...create,
          },
        },
      ]);
    } catch (error) {
      if (cancellationReasons(error)?.some(failedCondition)) {
        throw new ConflictError('session exists');
      }
      throw error;
    }
  }

  async getSession(sessionId: string): Promise<SessionMeta | null> {
    const item = await this.#get(metaKey(sessionId));
    return item ? toRecordWithExpiry<SessionMeta>(item) : null;
  }

  async updateSession(meta: SessionMeta, expectedVersion: number): Promise<void> {
    try {
      await this.#doc.send(
        new PutCommand({
          TableName: this.#table,
          Item: this.#metaItem(meta),
          ...this.#versionCondition(expectedVersion, true),
        }),
      );
    } catch (error) {
      if (isConditionFailed(error)) throw new ConflictError();
      throw error;
    }
  }

  async getSnapshot(sessionId: string): Promise<QuizSnapshot | null> {
    const item = await this.#get(snapshotKey(sessionId));
    return item ? toRecord<QuizSnapshot>(item) : null;
  }

  /**
   * Queries the GSI, which is eventually consistent: a session created a moment ago may not be
   * listed yet.
   */
  async listSessionsByHost(hostId: string, limit: number): Promise<SessionSummary[]> {
    const wanted = Math.floor(limit);
    const out: SessionSummary[] = [];
    let startKey: Record<string, unknown> | undefined;
    while (out.length < wanted) {
      const pageLimit = Math.min(wanted - out.length, this.#pageSize ?? Infinity);
      const page = await this.#doc.send(
        new QueryCommand({
          TableName: this.#table,
          IndexName: GSI1,
          KeyConditionExpression: '#pk = :pk',
          ExpressionAttributeNames: { '#pk': 'gsi1pk' },
          ExpressionAttributeValues: { ':pk': hostPk(hostId) },
          ScanIndexForward: false,
          // DynamoDB rejects an infinite Limit; leaving it out means "everything", like MemoryStore.
          Limit: Number.isFinite(pageLimit) ? pageLimit : undefined,
          ExclusiveStartKey: startKey,
        }),
      );
      for (const item of page.Items ?? []) {
        if (!this.#isLive(item) || out.length >= wanted) continue;
        const meta = toRecordWithExpiry<SessionMeta>(item);
        out.push({
          sessionId: meta.sessionId,
          pin: meta.pin,
          quizId: meta.quizId,
          quizTitle: meta.quizTitle,
          phase: meta.phase,
          createdAt: meta.createdAt,
          expiresAt: meta.expiresAt,
        });
      }
      startKey = page.LastEvaluatedKey;
      if (!startKey) break;
    }
    return out;
  }

  // --- Players ---------------------------------------------------------------------

  async addPlayer(
    player: PlayerRecord,
    expiresAt: number,
    maxPlayers?: number,
  ): Promise<AddPlayerResult> {
    if (maxPlayers === undefined) return this.#insertPlayer(player, expiresAt);

    // The seat is taken with a conditional update of one counter item, outside the insert
    // transaction. Inside it, every join of a session would conflict with every other on that
    // one item and be retried, which a class joining at once cannot afford; the update alone is
    // serialised by DynamoDB without cancelling anyone. The price is a seat that stays taken if
    // the invocation dies between the two writes, which costs one seat of a session's cap.
    if (!(await this.#takeSeat(player.sessionId, expiresAt, maxPlayers))) return 'session-full';
    try {
      const result = await this.#insertPlayer(player, expiresAt);
      if (result !== 'ok') await this.#releaseSeat(player.sessionId);
      return result;
    } catch (error) {
      // Only an error that proves the player was not written gives the seat back: a cancelled
      // transaction, or a request refused before it ran (throttled, invalid). A timeout, a
      // network error or a 5xx can come after the transaction committed, and giving the seat
      // back then would let one player too many in later, where keeping it costs one seat: the
      // safer of the two failures.
      if (wroteNothing(error)) await this.#releaseSeat(player.sessionId);
      throw error;
    }
  }

  async #takeSeat(sessionId: string, expiresAt: number, maxPlayers: number): Promise<boolean> {
    if (!(maxPlayers > 0)) return false;
    try {
      await this.#doc.send(
        new UpdateCommand({
          TableName: this.#table,
          Key: playerCountKey(sessionId),
          UpdateExpression: 'SET #seats = if_not_exists(#seats, :none) + :one, #ttl = :ttl',
          ConditionExpression: 'attribute_not_exists(#seats) OR #seats < :max',
          ExpressionAttributeNames: { '#seats': 'seats', '#ttl': TTL_ATTRIBUTE },
          ExpressionAttributeValues: {
            ':none': 0,
            ':one': 1,
            ':max': maxPlayers,
            ':ttl': toSeconds(expiresAt),
          },
        }),
      );
      return true;
    } catch (error) {
      if (isConditionFailed(error)) return false;
      throw error;
    }
  }

  /** Best effort: failing to give a seat back must not replace the outcome the caller gets. */
  #releaseSeat(sessionId: string): Promise<void> {
    return this.#returnSeat(sessionId).catch(() => undefined);
  }

  async #returnSeat(sessionId: string): Promise<void> {
    try {
      await this.#doc.send(
        new UpdateCommand({
          TableName: this.#table,
          Key: playerCountKey(sessionId),
          UpdateExpression: 'SET #seats = #seats - :one',
          // Never below zero, and never a counter created by a give-back.
          ConditionExpression: 'attribute_exists(#seats) AND #seats > :none',
          ExpressionAttributeNames: { '#seats': 'seats' },
          ExpressionAttributeValues: { ':one': 1, ':none': 0 },
        }),
      );
    } catch (error) {
      if (!isConditionFailed(error)) throw error;
    }
  }

  async #insertPlayer(player: PlayerRecord, expiresAt: number): Promise<AddPlayerResult> {
    const create = this.#createCondition();
    try {
      await this.#transact([
        {
          Put: {
            TableName: this.#table,
            Item: toItem(playerKey(player.sessionId, player.playerId), player, expiresAt),
            ...create,
          },
        },
        {
          Put: {
            TableName: this.#table,
            Item: toItem(
              nickKey(player.sessionId, player.nicknameKey),
              { playerId: player.playerId },
              expiresAt,
            ),
            ...create,
          },
        },
      ]);
      return 'ok';
    } catch (error) {
      const reasons = cancellationReasons(error);
      if (failedCondition(reasons?.[1])) return 'nickname-taken';
      if (failedCondition(reasons?.[0])) throw new ConflictError('player exists');
      throw error;
    }
  }

  async getPlayer(sessionId: string, playerId: string): Promise<PlayerRecord | null> {
    const item = await this.#get(playerKey(sessionId, playerId));
    return item ? toRecord<PlayerRecord>(item) : null;
  }

  async updatePlayer(
    sessionId: string,
    playerId: string,
    patch: Partial<Pick<PlayerRecord, 'kicked' | 'lastSeenAt'>>,
  ): Promise<void> {
    const expiry = this.#expiryParams();
    const assignments: string[] = [];
    const names: Record<string, string> = { ...expiry.ExpressionAttributeNames };
    const values: Record<string, unknown> = { ...expiry.ExpressionAttributeValues };
    for (const field of ['kicked', 'lastSeenAt'] as const) {
      if (patch[field] === undefined) continue;
      assignments.push(`#${field} = :${field}`);
      names[`#${field}`] = field;
      values[`:${field}`] = patch[field];
    }
    if (assignments.length === 0) {
      if (!(await this.getPlayer(sessionId, playerId))) throw this.#playerMissing(playerId);
      return;
    }
    try {
      await this.#doc.send(
        new UpdateCommand({
          TableName: this.#table,
          Key: playerKey(sessionId, playerId),
          UpdateExpression: `SET ${assignments.join(', ')}`,
          ConditionExpression: LIVE,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        }),
      );
    } catch (error) {
      if (isConditionFailed(error)) throw this.#playerMissing(playerId);
      throw error;
    }
  }

  async listPlayers(sessionId: string): Promise<PlayerRecord[]> {
    const items = await this.#queryPrefix(sessionPk(sessionId), PLAYER_SK_PREFIX);
    return items.filter((i) => this.#isLive(i)).map((i) => toRecord<PlayerRecord>(i));
  }

  async countPlayers(sessionId: string): Promise<number> {
    let count = 0;
    let startKey: Record<string, unknown> | undefined;
    do {
      const page = await this.#doc.send(
        new QueryCommand({
          TableName: this.#table,
          KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
          // The filter runs before COUNT, so lingering expired items are not counted.
          FilterExpression: '#ttl > :now',
          ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk', '#ttl': TTL_ATTRIBUTE },
          ExpressionAttributeValues: {
            ':pk': sessionPk(sessionId),
            ':prefix': PLAYER_SK_PREFIX,
            ':now': this.#nowSeconds(),
          },
          Select: 'COUNT',
          ConsistentRead: true,
          Limit: this.#pageSize,
          ExclusiveStartKey: startKey,
        }),
      );
      count += page.Count ?? 0;
      startKey = page.LastEvaluatedKey;
    } while (startKey);
    return count;
  }

  // --- Connections -----------------------------------------------------------------

  async putConnection(conn: ConnectionRecord): Promise<void> {
    const extra = { expiresAtMs: conn.expiresAt };
    for (let attempt = 1; ; attempt++) {
      // A connection put again under another session must not stay listed under the old one.
      const previous = await this.#getRaw(connByIdKey(conn.connectionId));
      const previousSession = previous ? (previous.sessionId as string) : undefined;
      const items: TransactItems = [
        {
          Put: {
            TableName: this.#table,
            Item: toItem(connByIdKey(conn.connectionId), conn, conn.expiresAt, extra),
            // Fails when a concurrent put moved the connection since the read above.
            ...(previousSession === undefined
              ? { ConditionExpression: 'attribute_not_exists(pk)' }
              : {
                  ConditionExpression: '#sid = :previous',
                  ExpressionAttributeNames: { '#sid': 'sessionId' },
                  ExpressionAttributeValues: { ':previous': previousSession },
                }),
          },
        },
        {
          Put: {
            TableName: this.#table,
            Item: toItem(
              connBySessionKey(conn.sessionId, conn.connectionId),
              conn,
              conn.expiresAt,
              extra,
            ),
          },
        },
      ];
      if (previousSession !== undefined && previousSession !== conn.sessionId) {
        items.push({
          Delete: {
            TableName: this.#table,
            Key: connBySessionKey(previousSession, conn.connectionId),
          },
        });
      }
      try {
        await this.#transact(items);
        return;
      } catch (error) {
        if (!failedCondition(cancellationReasons(error)?.[0])) throw error;
        if (attempt >= CONNECTION_ATTEMPTS)
          throw new ConflictError('connection moved concurrently');
      }
    }
  }

  async getConnection(connectionId: string): Promise<ConnectionRecord | null> {
    const item = await this.#get(connByIdKey(connectionId));
    return item ? toRecordWithExpiry<ConnectionRecord>(item) : null;
  }

  async deleteConnection(connectionId: string): Promise<void> {
    // The by-session key is only known from the by-id item, so read it first (even if expired).
    const item = await this.#getRaw(connByIdKey(connectionId));
    if (!item) return;
    await this.#transact([
      { Delete: { TableName: this.#table, Key: connByIdKey(connectionId) } },
      {
        Delete: {
          TableName: this.#table,
          Key: connBySessionKey(item.sessionId as string, connectionId),
        },
      },
    ]);
  }

  async listConnections(sessionId: string): Promise<ConnectionRecord[]> {
    const items = await this.#queryPrefix(sessionPk(sessionId), CONN_SK_PREFIX);
    return items.filter((i) => this.#isLive(i)).map((i) => toRecordWithExpiry<ConnectionRecord>(i));
  }

  // --- Responses -------------------------------------------------------------------

  async putResponse(response: ResponseRecord, expiresAt: number): Promise<PutResponseResult> {
    const key = responseKey(
      response.sessionId,
      response.questionIndex,
      response.playerId,
      response.slot,
    );
    const item = toItem(key, response, expiresAt);
    // The existing item can vanish between our failed put and the fallback read (TTL delete).
    // Expired items do not fail the condition, so `existing` is always a live record.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.#doc.send(
          new PutCommand({
            TableName: this.#table,
            Item: item,
            ...this.#createCondition(),
            ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
          }),
        );
        return { created: true };
      } catch (error) {
        if (!isConditionFailed(error)) throw error;
        // lib-dynamodb only unmarshalls successful outputs; the item on the exception is raw.
        const raw = (error as { Item?: Parameters<typeof unmarshall>[0] }).Item;
        const existing = raw ? unmarshall(raw) : await this.#getRaw(key);
        if (existing) {
          return { created: false, existing: toRecord<ResponseRecord>(existing) };
        }
      }
    }
    throw new Error('response item disappeared while resolving a duplicate write');
  }

  async listResponses(sessionId: string, questionIndex: number): Promise<ResponseRecord[]> {
    const shards = await Promise.all(
      Array.from({ length: RESPONSE_SHARDS }, (_, shard) =>
        this.#query({
          KeyConditionExpression: '#pk = :pk',
          ExpressionAttributeNames: { '#pk': 'pk' },
          ExpressionAttributeValues: { ':pk': responsePk(sessionId, questionIndex, shard) },
          ConsistentRead: true,
        }),
      ),
    );
    return shards
      .flat()
      .filter((i) => this.#isLive(i))
      .map((i) => toRecord<ResponseRecord>(i))
      .sort(
        (a, b) =>
          a.receivedAt - b.receivedAt ||
          (a.responseId < b.responseId ? -1 : a.responseId > b.responseId ? 1 : 0),
      );
  }

  async listPlayerResponses(
    sessionId: string,
    questionIndex: number,
    playerId: string,
  ): Promise<ResponseRecord[]> {
    const items = await this.#queryPrefix(
      responsePk(sessionId, questionIndex, responseShard(playerId)),
      responsePlayerPrefix(playerId),
    );
    return items.filter((i) => this.#isLive(i)).map((i) => toRecord<ResponseRecord>(i));
  }

  async setResponseStatus(
    sessionId: string,
    questionIndex: number,
    responseId: string,
    status: ModerationStatus,
  ): Promise<void> {
    const parsed = parseResponseId(responseId);
    if (!parsed) throw new NotFoundError(`response ${responseId} not found`);
    const expiry = this.#expiryParams();
    try {
      await this.#doc.send(
        new UpdateCommand({
          TableName: this.#table,
          Key: responseKey(sessionId, questionIndex, parsed.playerId, parsed.slot),
          UpdateExpression: 'SET #status = :status',
          ConditionExpression: LIVE,
          ExpressionAttributeNames: { ...expiry.ExpressionAttributeNames, '#status': 'status' },
          ExpressionAttributeValues: { ...expiry.ExpressionAttributeValues, ':status': status },
        }),
      );
    } catch (error) {
      if (isConditionFailed(error)) throw new NotFoundError(`response ${responseId} not found`);
      throw error;
    }
  }

  // --- Results ---------------------------------------------------------------------

  async putQuestionResult(result: StoredQuestionResult, expiresAt: number): Promise<void> {
    await this.#doc.send(
      new PutCommand({
        TableName: this.#table,
        Item: toItem(resultKey(result.sessionId, result.questionIndex), result, expiresAt),
      }),
    );
  }

  async getQuestionResult(
    sessionId: string,
    questionIndex: number,
  ): Promise<StoredQuestionResult | null> {
    const item = await this.#get(resultKey(sessionId, questionIndex));
    return item ? toRecord<StoredQuestionResult>(item) : null;
  }

  async listQuestionResults(sessionId: string): Promise<StoredQuestionResult[]> {
    const items = await this.#queryPrefix(sessionPk(sessionId), RESULT_SK_PREFIX);
    return items.filter((i) => this.#isLive(i)).map((i) => toRecord<StoredQuestionResult>(i));
  }

  async getScoreboard(sessionId: string): Promise<Scoreboard | null> {
    const item = await this.#get(scoresKey(sessionId));
    return item ? toRecord<Scoreboard>(item) : null;
  }

  async putScoreboard(
    scoreboard: Scoreboard,
    expectedVersion: number | undefined,
    expiresAt: number,
  ): Promise<void> {
    try {
      await this.#doc.send(
        new PutCommand({
          TableName: this.#table,
          Item: toItem(scoresKey(scoreboard.sessionId), scoreboard, expiresAt),
          ...this.#versionCondition(expectedVersion, true),
        }),
      );
    } catch (error) {
      if (isConditionFailed(error)) throw new ConflictError();
      throw error;
    }
  }

  // --- Rate limiting ---------------------------------------------------------------

  async hitRateLimit(key: string, limit: number, windowMs: number, now: number): Promise<boolean> {
    if (!(windowMs > 0)) throw new RangeError('windowMs must be positive');
    const windowStart = now - (now % windowMs);
    const out = await this.#doc.send(
      new UpdateCommand({
        TableName: this.#table,
        Key: rateLimitKey(key, windowStart),
        UpdateExpression: 'ADD #count :one SET #ttl = :ttl',
        ExpressionAttributeNames: { '#count': 'count', '#ttl': TTL_ATTRIBUTE },
        ExpressionAttributeValues: {
          ':one': 1,
          ':ttl': toSeconds(windowStart + windowMs + 60_000),
        },
        ReturnValues: 'UPDATED_NEW',
      }),
    );
    const count = out.Attributes?.count;
    if (typeof count !== 'number') throw new Error('rate-limit update returned no count');
    return count <= limit;
  }

  async peekRateLimit(key: string, limit: number, windowMs: number, now: number): Promise<boolean> {
    if (!(windowMs > 0)) throw new RangeError('windowMs must be positive');
    const windowStart = now - (now % windowMs);
    const item = await this.#get(rateLimitKey(key, windowStart));
    const count = item?.count;
    return (typeof count === 'number' ? count : 0) <= limit;
  }

  // --- Internals -------------------------------------------------------------------

  #nowSeconds(): number {
    return Math.floor(this.#now() / 1000);
  }

  /** An item is expired once `expiresAt` (epoch seconds) is at or before now. */
  #isLive(item: Item): boolean {
    const ttl = item[TTL_ATTRIBUTE];
    return typeof ttl !== 'number' || ttl * 1000 > this.#now();
  }

  #metaItem(meta: SessionMeta): Item {
    return toItem(metaKey(meta.sessionId), meta, meta.expiresAt, {
      expiresAtMs: meta.expiresAt,
      gsi1pk: hostPk(meta.hostId),
      gsi1sk: sessionGsiSk(meta.createdAt, meta.sessionId),
    });
  }

  /**
   * Create-only when `expected` is undefined; otherwise optimistic on the `version` attribute.
   * With `expires` (items that carry a TTL) an expired item counts as absent: it can be created
   * again and cannot be replaced.
   */
  #versionCondition(expected: number | undefined, expires: boolean) {
    if (expected === undefined) {
      return expires
        ? this.#createCondition()
        : { ConditionExpression: 'attribute_not_exists(pk)' };
    }
    const expiry = expires ? this.#expiryParams() : undefined;
    return {
      ConditionExpression: expires
        ? '#version = :expected AND #ttl > :nowSec'
        : '#version = :expected',
      ExpressionAttributeNames: { ...expiry?.ExpressionAttributeNames, '#version': 'version' },
      ExpressionAttributeValues: { ...expiry?.ExpressionAttributeValues, ':expected': expected },
    };
  }

  /** The names and values that `ABSENT_OR_EXPIRED` and `LIVE` refer to. */
  #expiryParams() {
    return {
      ExpressionAttributeNames: { '#ttl': TTL_ATTRIBUTE },
      ExpressionAttributeValues: { ':nowSec': this.#nowSeconds() },
    };
  }

  #createCondition() {
    return { ConditionExpression: ABSENT_OR_EXPIRED, ...this.#expiryParams() };
  }

  #playerMissing(playerId: string): NotFoundError {
    return new NotFoundError(`player ${playerId} not found`);
  }

  async #getRaw(key: ItemKey): Promise<Item | null> {
    const out = await this.#doc.send(
      new GetCommand({ TableName: this.#table, Key: key, ConsistentRead: true }),
    );
    return out.Item ?? null;
  }

  async #get(key: ItemKey): Promise<Item | null> {
    const item = await this.#getRaw(key);
    return item && this.#isLive(item) ? item : null;
  }

  async #query(input: Omit<QueryCommandInput, 'TableName' | 'Limit' | 'ExclusiveStartKey'>) {
    const items: Item[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const page = await this.#doc.send(
        new QueryCommand({
          ...input,
          TableName: this.#table,
          Limit: this.#pageSize,
          ExclusiveStartKey: startKey,
        }),
      );
      items.push(...(page.Items ?? []));
      startKey = page.LastEvaluatedKey;
    } while (startKey);
    return items;
  }

  #queryPrefix(pk: string, prefix: string): Promise<Item[]> {
    return this.#query({
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
      ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
      ExpressionAttributeValues: { ':pk': pk, ':prefix': prefix },
      ConsistentRead: true,
    });
  }

  /**
   * Runs a transaction, retrying while DynamoDB cancels it only because of a concurrent
   * transaction on the same items. Real condition failures are thrown for the caller to read.
   */
  async #transact(items: TransactItems): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.#doc.send(new TransactWriteCommand({ TransactItems: items }));
        return;
      } catch (error) {
        const reasons = cancellationReasons(error);
        const transient =
          reasons !== undefined &&
          reasons.some((r) => RETRYABLE_CANCELLATIONS.has(r.Code ?? '')) &&
          reasons.every((r) => r.Code === 'None' || RETRYABLE_CANCELLATIONS.has(r.Code ?? ''));
        if (!transient || attempt >= TRANSACTION_ATTEMPTS) throw error;
        await sleep(Math.random() * 10 * 2 ** attempt);
      }
    }
  }
}
