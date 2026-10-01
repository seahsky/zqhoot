import { DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ensureTable } from '@zqhoot/store';

export const DDB_ENDPOINT = process.env.ZQ_DDB_ENDPOINT ?? 'http://localhost:8000';

/** DynamoDB Local accepts any credentials; the shell's real ones must not be used. */
export const LOCAL_CREDENTIALS = { accessKeyId: 'local', secretAccessKey: 'local' };

export function createDocClient(): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(
    new DynamoDBClient({
      endpoint: DDB_ENDPOINT,
      region: 'us-east-1',
      credentials: LOCAL_CREDENTIALS,
    }),
    { marshallOptions: { removeUndefinedValues: true } },
  );
}

/**
 * DynamoDB Local keeps a separate database per access key and region (unless it runs with
 * `-sharedDb`), so tables the emulator creates are only visible with its own dummy key.
 */
export function createEmulatorDocClient(): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(
    new DynamoDBClient({
      endpoint: DDB_ENDPOINT,
      region: 'us-east-1',
      credentials: { accessKeyId: 'emulator', secretAccessKey: 'emulator' },
    }),
    { marshallOptions: { removeUndefinedValues: true } },
  );
}

/** DynamoDB Local is shared with other suites, so every file works in its own table. */
export const uniqueTableName = (label: string): string =>
  `zqhoot-test-lambda-${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export async function createTable(client: DynamoDBDocumentClient, name: string): Promise<void> {
  try {
    await ensureTable(client, name);
  } catch (error) {
    throw new Error(
      `DynamoDB Local is not reachable at ${DDB_ENDPOINT}: start it as described in ` +
        'packages/store/README.md, or point ZQ_DDB_ENDPOINT at it',
      { cause: error },
    );
  }
}

export async function dropTable(client: DynamoDBDocumentClient, name: string): Promise<void> {
  try {
    await client.send(new DeleteTableCommand({ TableName: name }));
  } catch {
    // Cleanup only: the table may never have been created.
  }
}
