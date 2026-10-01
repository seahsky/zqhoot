import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  UpdateTimeToLiveCommand,
  waitUntilTableExists,
  type CreateTableCommandInput,
} from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/** Name of the TTL attribute. Items store it as epoch seconds (DynamoDB's TTL format). */
export const TTL_ATTRIBUTE = 'expiresAt';

/**
 * The table every environment must provide (ADR-0003). The Terraform `data` module
 * (`infra/terraform/modules/data`) must match:
 *
 * - billing mode PAY_PER_REQUEST
 * - hash key `pk` (S), range key `sk` (S)
 * - global secondary index `gsi1` on `gsi1pk` (S) / `gsi1sk` (S), projection ALL
 * - TTL enabled on attribute `expiresAt`
 *
 * Only `pk`, `sk`, `gsi1pk` and `gsi1sk` are declared; every other attribute is schemaless.
 */
export function tableDefinition(tableName: string): CreateTableCommandInput {
  return {
    TableName: tableName,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'sk', AttributeType: 'S' },
      { AttributeName: 'gsi1pk', AttributeType: 'S' },
      { AttributeName: 'gsi1sk', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'gsi1',
        KeySchema: [
          { AttributeName: 'gsi1pk', KeyType: 'HASH' },
          { AttributeName: 'gsi1sk', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
  };
}

const hasName = (error: unknown, name: string): boolean =>
  typeof error === 'object' && error !== null && (error as { name?: unknown }).name === name;

/**
 * Creates the table if it is missing, waits until it is active and enables TTL. For tests and
 * local development; production tables come from Terraform. Safe to call concurrently.
 */
export async function ensureTable(
  client: DynamoDBClient | DynamoDBDocumentClient,
  tableName: string,
): Promise<void> {
  // A document client forwards plain client commands unchanged.
  const raw = client as DynamoDBClient;
  try {
    await raw.send(new DescribeTableCommand({ TableName: tableName }));
  } catch (error) {
    if (!hasName(error, 'ResourceNotFoundException')) throw error;
    try {
      await raw.send(new CreateTableCommand(tableDefinition(tableName)));
    } catch (createError) {
      // Another process created it between our check and our create.
      if (!hasName(createError, 'ResourceInUseException')) throw createError;
    }
  }
  await waitUntilTableExists({ client: raw, maxWaitTime: 60 }, { TableName: tableName });
  try {
    await raw.send(
      new UpdateTimeToLiveCommand({
        TableName: tableName,
        TimeToLiveSpecification: { Enabled: true, AttributeName: TTL_ATTRIBUTE },
      }),
    );
  } catch {
    // Some backends lack TTL support, and "already enabled" is reported as an error.
  }
}
