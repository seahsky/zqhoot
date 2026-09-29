import { DeleteTableCommand, DynamoDBClient, ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export const DDB_ENDPOINT = process.env.ZQ_DDB_ENDPOINT ?? 'http://localhost:8000';
export const SKIP_DYNAMO = process.env.ZQ_SKIP_DYNAMO === '1';

const localOptions = {
  endpoint: DDB_ENDPOINT,
  region: 'us-east-1',
  // DynamoDB Local accepts any credentials; the default provider chain would fail without them.
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
};

export function createTestClient(): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(new DynamoDBClient(localOptions), {
    marshallOptions: { removeUndefinedValues: true },
  });
}

/** Other agents share DynamoDB Local, so every test file works in its own table. */
export const uniqueTableName = (label: string): string =>
  `zqhoot-test-${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Fails loudly (rather than skipping) when the backend is missing. */
export async function assertDynamoReachable(): Promise<void> {
  const probe = new DynamoDBClient({
    ...localOptions,
    maxAttempts: 1,
    requestHandler: { requestTimeout: 3000, connectionTimeout: 3000 },
  });
  try {
    await probe.send(new ListTablesCommand({ Limit: 1 }));
  } catch (error) {
    throw new Error(
      `DynamoDB Local is not reachable at ${DDB_ENDPOINT} (${String(error)}). Start it as ` +
        'described in packages/store/README.md, point ZQ_DDB_ENDPOINT at it, or set ' +
        'ZQ_SKIP_DYNAMO=1 to skip the DynamoDB tests.',
      { cause: error },
    );
  } finally {
    probe.destroy();
  }
}

export async function dropTable(client: DynamoDBDocumentClient, tableName: string): Promise<void> {
  try {
    await client.send(new DeleteTableCommand({ TableName: tableName }));
  } catch {
    // Cleanup only: the table may never have been created.
  }
}
