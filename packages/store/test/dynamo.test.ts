import {
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DynamoStore, RESPONSE_SHARDS, ensureTable, responseShard } from '../src/index.ts';
import { runStoreContract } from './contract.ts';
import {
  DDB_ENDPOINT,
  SKIP_DYNAMO,
  assertDynamoReachable,
  createTestClient,
  dropTable,
  uniqueTableName,
} from './dynamo-helpers.ts';
import {
  CLOCK_START,
  DAY_MS,
  allQuestions,
  allResults,
  createClock,
  makeConnection,
  makeMeta,
  makePlayer,
  makeQuiz,
  makeResponse,
  makeScoreboard,
  makeSnapshot,
  uid,
} from './fixtures.ts';

const HOUR_MS = 3_600_000;
const seconds = (ms: number) => Math.ceil(ms / 1000);

/** Wraps `client.send` so a test can see which commands a store method issued. */
function recordCommands(client: DynamoDBDocumentClient) {
  const spy = vi.spyOn(client, 'send');
  return {
    commands: () => spy.mock.calls.map((call) => call[0] as { input: Record<string, unknown> }),
    reset: () => spy.mockClear(),
    restore: () => spy.mockRestore(),
  };
}

describe.skipIf(SKIP_DYNAMO)('DynamoStore', () => {
  const client = createTestClient();
  const tableName = uniqueTableName('contract');
  const layoutTable = uniqueTableName('layout');

  beforeAll(async () => {
    await assertDynamoReachable();
    await ensureTable(client, tableName);
    await ensureTable(client, layoutTable);
  });

  afterAll(async () => {
    await dropTable(client, tableName);
    await dropTable(client, layoutTable);
  });

  // Pages of 3 force every list through pagination; the second run uses DynamoDB's own paging.
  runStoreContract(
    'DynamoStore (pageSize 3)',
    async (clock) => new DynamoStore({ tableName, client, now: clock.now, pageSize: 3 }),
  );
  runStoreContract(
    'DynamoStore (default paging)',
    async (clock) => new DynamoStore({ tableName, client, now: clock.now }),
  );

  describe('table', () => {
    it('is created with the on-demand billing mode, gsi1 and a TTL on expiresAt', async () => {
      const table = await client.send(new DescribeTableCommand({ TableName: layoutTable }));
      expect(table.Table?.KeySchema).toEqual([
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ]);
      const gsi = table.Table?.GlobalSecondaryIndexes?.[0];
      expect(gsi?.IndexName).toBe('gsi1');
      expect(gsi?.KeySchema).toEqual([
        { AttributeName: 'gsi1pk', KeyType: 'HASH' },
        { AttributeName: 'gsi1sk', KeyType: 'RANGE' },
      ]);
      expect(gsi?.Projection?.ProjectionType).toBe('ALL');
      const ttl = await client.send(new DescribeTimeToLiveCommand({ TableName: layoutTable }));
      expect(ttl.TimeToLiveDescription?.AttributeName).toBe('expiresAt');
      expect(['ENABLED', 'ENABLING']).toContain(ttl.TimeToLiveDescription?.TimeToLiveStatus);
    });

    it('can be ensured again without error', async () => {
      await expect(ensureTable(client, layoutTable)).resolves.toBeUndefined();
      await expect(ensureTable(client, layoutTable)).resolves.toBeUndefined();
    });

    it('reports a missing table as ResourceNotFoundException', async () => {
      const store = new DynamoStore({ tableName: uniqueTableName('missing'), client });
      await expect(store.getQuiz('o', 'q')).rejects.toBeInstanceOf(ResourceNotFoundException);
    });
  });

  describe('client construction', () => {
    it('builds its own document client from endpoint and region', async () => {
      // The default credential provider chain needs something; DynamoDB Local accepts anything.
      vi.stubEnv('AWS_ACCESS_KEY_ID', 'local');
      vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'local');
      try {
        const store = new DynamoStore({
          tableName: layoutTable,
          endpoint: DDB_ENDPOINT,
          region: 'us-east-1',
        });
        const quiz = makeQuiz(uid('owner'), { questions: allQuestions() });
        await store.putQuiz(quiz);
        expect(await store.getQuiz(quiz.ownerId, quiz.id)).toEqual(quiz);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  describe('key layout (ADR-0003)', () => {
    const clock = createClock();
    const store = new DynamoStore({ tableName: layoutTable, client, now: clock.now });
    const rawItem = async (pk: string, sk: string) =>
      (
        await client.send(
          new GetCommand({ TableName: layoutTable, Key: { pk, sk }, ConsistentRead: true }),
        )
      ).Item;

    it('stores quizzes under the host with summary attributes at top level', async () => {
      const quiz = makeQuiz(uid('owner'));
      await store.putQuiz(quiz);
      const item = await rawItem(`HOST#${quiz.ownerId}`, `QUIZ#${quiz.id}`);
      expect(item).toMatchObject({
        id: quiz.id,
        title: quiz.title,
        questionCount: quiz.questions.length,
        updatedAt: quiz.updatedAt,
        version: quiz.version,
      });
      expect(item?.questions).toEqual(quiz.questions);
      expect(item).not.toHaveProperty('expiresAt');
    });

    it('stores PIN claims with the TTL in epoch seconds, rounded up', async () => {
      const pin = uid('pin');
      const sid = uid('sess');
      await store.reservePin(pin, sid, clock.now() + HOUR_MS + 1500);
      expect(await rawItem(`PIN#${pin}`, 'PIN')).toEqual({
        pk: `PIN#${pin}`,
        sk: 'PIN',
        sessionId: sid,
        expiresAt: clock.now() / 1000 + 3600 + 2,
      });
    });

    it('stores session meta with the host index keys and a snapshot beside it', async () => {
      const meta = makeMeta({ createdAt: CLOCK_START + 42 });
      const snapshot = makeSnapshot(meta.quizId);
      await store.createSession(meta, snapshot);
      const item = await rawItem(`SESS#${meta.sessionId}`, 'META');
      expect(item).toMatchObject({
        gsi1pk: `HOST#${meta.hostId}`,
        gsi1sk: `SESS#${CLOCK_START + 42}#${meta.sessionId}`,
        expiresAt: seconds(meta.expiresAt),
        expiresAtMs: meta.expiresAt,
        phase: meta.phase,
        version: meta.version,
      });
      expect(await rawItem(`SESS#${meta.sessionId}`, 'SNAP')).toMatchObject({
        quizId: snapshot.quizId,
        expiresAt: seconds(meta.expiresAt),
      });
    });

    it('pads createdAt to 13 digits in the index sort key', async () => {
      const meta = makeMeta({ createdAt: 1_234 });
      await store.createSession(meta, makeSnapshot(meta.quizId));
      const item = await rawItem(`SESS#${meta.sessionId}`, 'META');
      expect(item?.gsi1sk).toBe(`SESS#0000000001234#${meta.sessionId}`);
    });

    it('stores players and nickname claims in the session partition', async () => {
      const sid = uid('sess');
      const player = makePlayer(sid);
      await store.addPlayer(player, clock.now() + DAY_MS);
      expect(await rawItem(`SESS#${sid}`, `PLAYER#${player.playerId}`)).toMatchObject({
        ...player,
        expiresAt: seconds(clock.now() + DAY_MS),
      });
      expect(await rawItem(`SESS#${sid}`, `NICK#${player.nicknameKey}`)).toMatchObject({
        playerId: player.playerId,
        expiresAt: seconds(clock.now() + DAY_MS),
      });
    });

    it('counts the seats of a capped session in one item that no player query reads', async () => {
      const sid = uid('sess');
      const expiresAt = clock.now() + DAY_MS;
      const [a, b] = [makePlayer(sid), makePlayer(sid)];
      await store.addPlayer(a, expiresAt, 5);
      await store.addPlayer(b, expiresAt, 5);
      expect(await rawItem(`SESS#${sid}`, 'PCOUNT')).toEqual({
        pk: `SESS#${sid}`,
        sk: 'PCOUNT',
        seats: 2,
        expiresAt: seconds(expiresAt),
      });
      expect(await store.countPlayers(sid)).toBe(2);
      expect((await store.listPlayers(sid)).map((p) => p.playerId)).toEqual(
        [a.playerId, b.playerId].sort(),
      );
      // A refused nickname gives its seat back; an uncapped insert never touches the item.
      await store.addPlayer(makePlayer(sid, { nicknameKey: a.nicknameKey }), expiresAt, 5);
      expect((await rawItem(`SESS#${sid}`, 'PCOUNT'))?.seats).toBe(2);
      await store.addPlayer(makePlayer(sid), expiresAt);
      expect((await rawItem(`SESS#${sid}`, 'PCOUNT'))?.seats).toBe(2);
      // A session that never filled a seat has no counter, and a refused one does not create it.
      const empty = uid('sess');
      await store.addPlayer(makePlayer(empty), expiresAt, 0);
      expect(await rawItem(`SESS#${empty}`, 'PCOUNT')).toBeUndefined();
    });

    it('stores each connection twice, by id and by session', async () => {
      const sid = uid('sess');
      const conn = makeConnection(sid, { expiresAt: clock.now() + 3 * HOUR_MS + 1 });
      await store.putConnection(conn);
      for (const [pk, sk] of [
        [`CONN#${conn.connectionId}`, 'CONN'],
        [`SESS#${sid}`, `CONN#${conn.connectionId}`],
      ] as const) {
        expect(await rawItem(pk, sk)).toMatchObject({
          connectionId: conn.connectionId,
          expiresAt: seconds(conn.expiresAt),
          expiresAtMs: conn.expiresAt,
        });
      }
      await store.deleteConnection(conn.connectionId);
      expect(await rawItem(`CONN#${conn.connectionId}`, 'CONN')).toBeUndefined();
      expect(await rawItem(`SESS#${sid}`, `CONN#${conn.connectionId}`)).toBeUndefined();
    });

    it('shards responses by player and pads the slot to two digits', async () => {
      const sid = uid('sess');
      const pids = Array.from({ length: 12 }, () => uid('pl'));
      for (const pid of pids) {
        await store.putResponse(makeResponse(sid, 2, pid, { slot: 1 }), clock.now() + DAY_MS);
      }
      const shards = new Set<number>();
      for (const pid of pids) {
        const shard = responseShard(pid);
        shards.add(shard);
        expect(await rawItem(`RESP#${sid}#2#${shard}`, `P#${pid}#01`)).toMatchObject({
          responseId: `${pid}-1`,
          expiresAt: seconds(clock.now() + DAY_MS),
        });
      }
      expect(shards.size).toBeGreaterThan(1);
      expect([...shards].every((s) => s >= 0 && s < RESPONSE_SHARDS)).toBe(true);
    });

    it('stores results, the scoreboard and rate-limit windows', async () => {
      const sid = uid('sess');
      const [result] = allResults(sid);
      await store.putQuestionResult({ ...result!, questionIndex: 12 }, clock.now() + DAY_MS);
      expect(await rawItem(`SESS#${sid}`, 'RESULT#012')).toMatchObject({ questionIndex: 12 });
      await store.putScoreboard(makeScoreboard(sid), undefined, clock.now() + DAY_MS);
      expect(await rawItem(`SESS#${sid}`, 'SCORES')).toMatchObject({ appliedThrough: 2 });

      const key = uid('rl');
      const now = clock.now() + 12_345;
      await store.hitRateLimit(key, 5, 10_000, now);
      await store.hitRateLimit(key, 5, 10_000, now + 1);
      const windowStart = now - (now % 10_000);
      expect(await rawItem(`RL#${key}`, `W#${windowStart}`)).toEqual({
        pk: `RL#${key}`,
        sk: `W#${windowStart}`,
        count: 2,
        expiresAt: seconds(windowStart + 10_000 + 60_000),
      });
    });

    it('puts only session meta on the sparse index', async () => {
      const page = await client.send(
        new ScanCommand({
          TableName: layoutTable,
          FilterExpression: 'attribute_exists(gsi1pk)',
          ConsistentRead: true,
        }),
      );
      expect(page.Items?.length).toBeGreaterThan(0);
      expect(page.Items?.every((i) => i.sk === 'META')).toBe(true);
    });
  });

  describe('expiry', () => {
    it('has one-second granularity: an item lives until the rounded-up second', async () => {
      const clock = createClock();
      const store = new DynamoStore({ tableName: layoutTable, client, now: clock.now });
      const pin = uid('pin');
      await store.reservePin(pin, 'sess', CLOCK_START + 1500);
      clock.set(CLOCK_START + 1999);
      expect(await store.getSessionIdByPin(pin)).toBe('sess');
      clock.set(CLOCK_START + 2000);
      expect(await store.getSessionIdByPin(pin)).toBeNull();
    });

    it('reuses the PIN item of an expired claim in place', async () => {
      const clock = createClock();
      const store = new DynamoStore({ tableName: layoutTable, client, now: clock.now });
      const pin = uid('pin');
      await store.reservePin(pin, 'first', CLOCK_START + 1000);
      clock.set(CLOCK_START + 1000);
      expect(await store.reservePin(pin, 'second', CLOCK_START + HOUR_MS)).toBe(true);
      expect(await store.getSessionIdByPin(pin)).toBe('second');
    });
  });

  describe('requests', () => {
    const clock = createClock();
    const spyClient = createTestClient();
    const store = new DynamoStore({ tableName: layoutTable, client: spyClient, now: clock.now });
    const pagedStore = new DynamoStore({
      tableName: layoutTable,
      client: spyClient,
      now: clock.now,
      pageSize: 3,
    });
    const recorder = recordCommands(spyClient);
    afterAll(() => recorder.restore());

    const commandsOf = async (run: () => Promise<unknown>) => {
      recorder.reset();
      await run();
      return recorder.commands();
    };

    it('reads consistently everywhere the contract requires it', async () => {
      const meta = makeMeta();
      const sid = meta.sessionId;
      const player = makePlayer(sid);
      const conn = makeConnection(sid);
      const reads: Record<string, () => Promise<unknown>> = {
        getSession: () => store.getSession(sid),
        getSnapshot: () => store.getSnapshot(sid),
        getScoreboard: () => store.getScoreboard(sid),
        getPlayer: () => store.getPlayer(sid, player.playerId),
        listPlayers: () => store.listPlayers(sid),
        countPlayers: () => store.countPlayers(sid),
        listResponses: () => store.listResponses(sid, 0),
        listPlayerResponses: () => store.listPlayerResponses(sid, 0, player.playerId),
        getQuestionResult: () => store.getQuestionResult(sid, 0),
        listQuestionResults: () => store.listQuestionResults(sid),
        getSessionIdByPin: () => store.getSessionIdByPin(meta.pin),
        getConnection: () => store.getConnection(conn.connectionId),
        listConnections: () => store.listConnections(sid),
        deleteConnection: () => store.deleteConnection(conn.connectionId),
        getQuiz: () => store.getQuiz(meta.hostId, 'q'),
        listQuizzes: () => store.listQuizzes(meta.hostId),
      };
      for (const [name, run] of Object.entries(reads)) {
        const sent = await commandsOf(run);
        expect(sent.length, name).toBeGreaterThan(0);
        for (const command of sent) {
          expect(command.input.ConsistentRead, name).toBe(true);
        }
      }
    });

    it('lists a host newest first from gsi1, capped at the limit', async () => {
      const sent = await commandsOf(() => store.listSessionsByHost(uid('host'), 5));
      expect(sent).toHaveLength(1);
      expect(sent[0]?.input).toMatchObject({
        IndexName: 'gsi1',
        ScanIndexForward: false,
        Limit: 5,
      });
    });

    it('does not send an infinite limit to DynamoDB', async () => {
      const sent = await commandsOf(() => store.listSessionsByHost(uid('host'), Infinity));
      expect(sent).toHaveLength(1);
      expect(sent[0]?.input.Limit).toBeUndefined();
    });

    it('guards every conditional write on an item with a TTL against a lingering expired item', async () => {
      const meta = makeMeta();
      const sid = meta.sessionId;
      const player = makePlayer(sid);
      const response = makeResponse(sid, 0, player.playerId);
      await store.addPlayer(player, 1e15);
      await store.putResponse(response, 1e15);
      const writes: Record<string, () => Promise<unknown>> = {
        updatePlayer: () => store.updatePlayer(sid, player.playerId, { kicked: true }),
        setResponseStatus: () => store.setResponseStatus(sid, 0, response.responseId, 'hidden'),
        updateSession: () => store.updateSession(meta, 0).catch(() => undefined),
        putScoreboard: () => store.putScoreboard(makeScoreboard(sid), undefined, 1e15),
        putResponse: () => store.putResponse(response, 1e15),
      };
      for (const [name, run] of Object.entries(writes)) {
        const [command] = await commandsOf(run);
        expect(String(command?.input.ConditionExpression), name).toContain('#ttl');
      }
    });

    it('lists quizzes with a projection, so questions are not read', async () => {
      const sent = await commandsOf(() => store.listQuizzes(uid('owner')));
      const projection = String(sent[0]?.input.ProjectionExpression);
      expect(projection).toBeTruthy();
      const names = Object.values(
        sent[0]?.input.ExpressionAttributeNames as Record<string, string>,
      );
      expect(names).not.toContain('questions');
      expect(names).toEqual(
        expect.arrayContaining(['title', 'questionCount', 'updatedAt', 'version']),
      );
    });

    it('joins and creates sessions with one two-item transaction', async () => {
      const meta = makeMeta();
      const join = await commandsOf(() => store.addPlayer(makePlayer(meta.sessionId), 1e15));
      expect(join).toHaveLength(1);
      expect(join[0]).toBeInstanceOf(TransactWriteCommand);
      const items = join[0]?.input.TransactItems as Array<{ Put: { ConditionExpression: string } }>;
      // An expired item that TTL has not deleted yet counts as absent, as it does for PIN claims.
      expect(items.map((i) => i.Put.ConditionExpression)).toEqual([
        'attribute_not_exists(pk) OR #ttl <= :nowSec',
        'attribute_not_exists(pk) OR #ttl <= :nowSec',
      ]);

      const create = await commandsOf(() => store.createSession(meta, makeSnapshot(meta.quizId)));
      expect(create).toHaveLength(1);
      expect(create[0]?.input.TransactItems).toHaveLength(2);
    });

    it('resolves a duplicate response from the failed put, without another read', async () => {
      const sid = uid('sess');
      const pid = uid('pl');
      await store.putResponse(makeResponse(sid, 0, pid), 1e15);
      const sent = await commandsOf(() => store.putResponse(makeResponse(sid, 0, pid), 1e15));
      expect(sent).toHaveLength(1);
      expect(sent[0]?.input.ReturnValuesOnConditionCheckFailure).toBe('ALL_OLD');
    });

    it('pages every list with the configured page size', async () => {
      const sid = uid('sess');
      const owner = uid('owner');
      const host = uid('host');
      for (let i = 0; i < 11; i++) {
        await pagedStore.addPlayer(makePlayer(sid), 1e15);
        await pagedStore.putConnection(makeConnection(sid));
        await pagedStore.putResponse(makeResponse(sid, 0, uid('pl')), 1e15);
        await pagedStore.putQuestionResult({ ...allResults(sid)[0]!, questionIndex: i }, 1e15);
        await pagedStore.putQuiz(makeQuiz(owner));
        const meta = makeMeta({ hostId: host });
        await pagedStore.createSession(meta, makeSnapshot(meta.quizId));
      }
      const pages = async (run: () => Promise<unknown>) =>
        (await commandsOf(run)).filter((c) => c instanceof QueryCommand).length;
      expect(await pages(() => pagedStore.listPlayers(sid))).toBeGreaterThanOrEqual(4);
      expect(await pages(() => pagedStore.countPlayers(sid))).toBeGreaterThanOrEqual(4);
      expect(await pages(() => pagedStore.listConnections(sid))).toBeGreaterThanOrEqual(4);
      expect(await pages(() => pagedStore.listQuestionResults(sid))).toBeGreaterThanOrEqual(4);
      expect(await pages(() => pagedStore.listQuizzes(owner))).toBeGreaterThanOrEqual(4);
      expect(await pages(() => pagedStore.listResponses(sid, 0))).toBeGreaterThan(RESPONSE_SHARDS);
      expect(await pages(() => pagedStore.listSessionsByHost(host, 50))).toBeGreaterThanOrEqual(4);
      expect(await pagedStore.countPlayers(sid)).toBe(11);
    });
  });
});
