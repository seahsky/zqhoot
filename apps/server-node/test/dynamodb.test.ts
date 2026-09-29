import { stat } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@zqhoot/protocol';
import { ensureTable } from '@zqhoot/store';
// The AWS SDK is not a dependency of this package; the store package's test helpers already build a
// client for DynamoDB Local (`ZQ_DDB_ENDPOINT`, default http://localhost:8000).
import {
  DDB_ENDPOINT,
  SKIP_DYNAMO,
  assertDynamoReachable,
  createTestClient,
  dropTable,
  uniqueTableName,
} from '../../../packages/store/test/dynamo-helpers.ts';
import {
  OPTION_A,
  TestSocket,
  apiFor,
  connectHost,
  createQuiz,
  createSession,
  joinPlayer,
  login,
} from './helpers/client.ts';
import { createWorkspace, startServer } from './helpers/server.ts';
import type { Workspace } from './helpers/server.ts';

const client = createTestClient();
const table = uniqueTableName('server-node');
let workspace: Workspace;
const savedEnv = { key: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY };

const dynamoEnv = {
  ZQ_STORE: 'dynamodb',
  ZQ_TABLE_NAME: table,
  ZQ_DDB_ENDPOINT: DDB_ENDPOINT,
  AWS_REGION: 'us-east-1',
};

beforeAll(async () => {
  if (SKIP_DYNAMO) return;
  await assertDynamoReachable();
  // DynamoDB Local accepts any credentials; the SDK's default chain needs some.
  process.env.AWS_ACCESS_KEY_ID = 'local';
  process.env.AWS_SECRET_ACCESS_KEY = 'local';
  await ensureTable(client, table);
  workspace = await createWorkspace();
});

afterAll(async () => {
  if (SKIP_DYNAMO) return;
  process.env.AWS_ACCESS_KEY_ID = savedEnv.key;
  process.env.AWS_SECRET_ACCESS_KEY = savedEnv.secret;
  if (savedEnv.key === undefined) delete process.env.AWS_ACCESS_KEY_ID;
  if (savedEnv.secret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
  await dropTable(client, table);
  await workspace.cleanup();
});

describe.skipIf(SKIP_DYNAMO)('ZQ_STORE=dynamodb', () => {
  it('runs a question round on DynamoStore and recovers the session after a restart', async () => {
    const first = await startServer(workspace, { env: dynamoEnv });
    const api = apiFor(first);
    const hostToken = await login(api);
    const quiz = await createQuiz(api, hostToken);
    const { sessionId, pin } = await createSession(api, hostToken, quiz.id);
    const host = await connectHost(first, sessionId, hostToken);
    const player = await joinPlayer(first, pin, 'Ada');
    host.send({ type: 'host.next', from: { phase: 'lobby', questionIndex: -1 } });
    const question = await player.socket.next('question');
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, question.openAt - Date.now()) + 30),
    );
    player.socket.send({
      type: 'answer',
      questionIndex: 0,
      payload: { kind: 'choice', optionId: OPTION_A },
    });
    expect((await player.socket.next('answer.ack')).status).toBe('accepted');

    // No file persistence in this mode: the table is the only state.
    await first.close();
    await expect(stat(`${workspace.dataDir}/state.json`)).rejects.toMatchObject({ code: 'ENOENT' });

    const second = await startServer(workspace, { env: dynamoEnv });
    try {
      expect(second.handle.scheduler.pending).toBe(1);
      const resumed = await TestSocket.connectTo(second);
      resumed.send({
        type: 'resume',
        v: PROTOCOL_VERSION,
        sessionId,
        playerId: player.playerId,
        token: player.token,
      });
      const welcome = await resumed.next('welcome');
      if (welcome.role !== 'player') throw new Error('expected a player welcome');
      expect(welcome.snapshot).toMatchObject({ phase: 'question', questionIndex: 0 });
      expect(welcome.snapshot.responses).toEqual([{ kind: 'choice', optionId: OPTION_A }]);
      resumed.close();
    } finally {
      await second.close();
    }
  });
});
