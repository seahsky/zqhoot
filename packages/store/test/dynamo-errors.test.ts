import { marshall } from '@aws-sdk/util-dynamodb';
import {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConflictError, DynamoStore, NotFoundError } from '../src/index.ts';
import {
  makeConnection,
  makeMeta,
  makePlayer,
  makeQuiz,
  makeResponse,
  makeScoreboard,
  makeSnapshot,
} from './fixtures.ts';

/** These tests script the SDK's responses, so they need no DynamoDB Local. */
type Handler = (command: unknown, attempt: number) => unknown;

function scriptedStore(handler: Handler) {
  const sent: unknown[] = [];
  const client = {
    send: async (command: unknown) => {
      sent.push(command);
      return handler(command, sent.length);
    },
  } as unknown as DynamoDBDocumentClient;
  return { store: new DynamoStore({ tableName: 't', client, now: () => 0 }), sent };
}

const named = (name: string, extra: object = {}) =>
  Object.assign(new Error(name), { name, ...extra });
const canceled = (...codes: string[]) =>
  named('TransactionCanceledException', { CancellationReasons: codes.map((Code) => ({ Code })) });
const conditionFailed = (extra: object = {}) => named('ConditionalCheckFailedException', extra);

afterEach(() => vi.restoreAllMocks());

describe('DynamoStore transactions', () => {
  it('retries a transaction cancelled only by concurrent transactions', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { store, sent } = scriptedStore((_, n) => {
      if (n <= 2) throw canceled('TransactionConflict', 'None');
      return {};
    });
    expect(await store.addPlayer(makePlayer('s'), 1000)).toBe('ok');
    expect(sent).toHaveLength(3);
    expect(sent.every((c) => c instanceof TransactWriteCommand)).toBe(true);
  });

  it('gives up after repeated conflicts and throws the SDK error', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const error = canceled('TransactionConflict', 'TransactionConflict');
    const { store, sent } = scriptedStore(() => {
      throw error;
    });
    await expect(store.addPlayer(makePlayer('s'), 1000)).rejects.toBe(error);
    expect(sent).toHaveLength(8);
  });

  it('does not retry a real condition failure, even beside a conflict', async () => {
    const { store, sent } = scriptedStore(() => {
      throw canceled('ConditionalCheckFailed', 'TransactionConflict');
    });
    await expect(store.addPlayer(makePlayer('s'), 1000)).rejects.toBeInstanceOf(ConflictError);
    expect(sent).toHaveLength(1);
  });

  it('maps a failed nickname claim to nickname-taken', async () => {
    const { store } = scriptedStore(() => {
      throw canceled('None', 'ConditionalCheckFailed');
    });
    expect(await store.addPlayer(makePlayer('s'), 1000)).toBe('nickname-taken');
  });

  it('prefers nickname-taken when both puts fail', async () => {
    const { store } = scriptedStore(() => {
      throw canceled('ConditionalCheckFailed', 'ConditionalCheckFailed');
    });
    expect(await store.addPlayer(makePlayer('s'), 1000)).toBe('nickname-taken');
  });

  it('maps a failed create condition to ConflictError', async () => {
    const { store } = scriptedStore(() => {
      throw canceled('ConditionalCheckFailed', 'None');
    });
    await expect(store.createSession(makeMeta(), makeSnapshot())).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('throws other cancellations unchanged', async () => {
    const error = canceled('ValidationError', 'None');
    const { store, sent } = scriptedStore(() => {
      throw error;
    });
    await expect(store.addPlayer(makePlayer('s'), 1000)).rejects.toBe(error);
    expect(sent).toHaveLength(1);
  });
});

describe('DynamoStore putConnection', () => {
  const items = (command: unknown) =>
    (command as TransactWriteCommand).input.TransactItems as Array<{
      Put?: { Item: { pk: string; sk: string }; ConditionExpression?: string };
      Delete?: { Key: { pk: string; sk: string } };
    }>;
  const existing = (sessionId: string) => ({ Item: { pk: 'CONN#c', sk: 'CONN', sessionId } });

  it('creates a connection that is new, guarded against a concurrent put', async () => {
    const { store, sent } = scriptedStore(() => ({}));
    await store.putConnection(makeConnection('s', { connectionId: 'c' }));
    expect(sent).toHaveLength(2);
    const [put] = items(sent[1]);
    expect(put?.Put?.ConditionExpression).toBe('attribute_not_exists(pk)');
    expect(items(sent[1])).toHaveLength(2);
  });

  it('removes the by-session item of the session the connection leaves', async () => {
    const { store, sent } = scriptedStore((command) =>
      command instanceof GetCommand ? existing('old') : {},
    );
    await store.putConnection(makeConnection('new', { connectionId: 'c' }));
    const transaction = items(sent[1]);
    expect(transaction).toHaveLength(3);
    expect(transaction[0]?.Put?.ConditionExpression).toBe('#sid = :previous');
    expect(transaction[2]?.Delete?.Key).toEqual({ pk: 'SESS#old', sk: 'CONN#c' });
  });

  it('deletes nothing extra when the session stays the same', async () => {
    const { store, sent } = scriptedStore((command) =>
      command instanceof GetCommand ? existing('s') : {},
    );
    await store.putConnection(makeConnection('s', { connectionId: 'c' }));
    expect(items(sent[1])).toHaveLength(2);
  });

  it('reads again and retries when a concurrent put moved the connection meanwhile', async () => {
    let reads = 0;
    const { store, sent } = scriptedStore((command) => {
      if (command instanceof GetCommand) return existing(++reads === 1 ? 'a' : 'b');
      if (sent.filter((c) => c instanceof TransactWriteCommand).length === 1) {
        throw canceled('ConditionalCheckFailed', 'None', 'None');
      }
      return {};
    });
    await store.putConnection(makeConnection('c-session', { connectionId: 'c' }));
    const transactions = sent.filter((c) => c instanceof TransactWriteCommand);
    expect(transactions).toHaveLength(2);
    expect(items(transactions[1]).at(-1)?.Delete?.Key.pk).toBe('SESS#b');
  });

  it('gives up with a ConflictError when the connection keeps moving', async () => {
    const { store, sent } = scriptedStore((command) => {
      if (command instanceof GetCommand) return existing('a');
      throw canceled('ConditionalCheckFailed', 'None', 'None');
    });
    await expect(
      store.putConnection(makeConnection('s', { connectionId: 'c' })),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(sent.filter((c) => c instanceof TransactWriteCommand)).toHaveLength(3);
  });
});

describe('DynamoStore error handling', () => {
  const boom = named('InternalServerError');
  const failing = () =>
    scriptedStore(() => {
      throw boom;
    }).store;

  it('propagates unexpected errors unchanged from every write', async () => {
    const store = failing();
    const meta = makeMeta();
    const calls: Array<() => Promise<unknown>> = [
      () => store.putQuiz(makeQuiz('o')),
      () => store.putQuiz(makeQuiz('o'), 1),
      () => store.deleteQuiz('o', 'q'),
      () => store.reservePin('p', 's', 1),
      () => store.releasePin('p', 's'),
      () => store.createSession(meta, makeSnapshot()),
      () => store.updateSession(meta, 1),
      () => store.updatePlayer('s', 'p', { kicked: true }),
      () => store.putResponse(makeResponse('s', 0, 'p'), 1),
      () => store.setResponseStatus('s', 0, 'p-0', 'hidden'),
      () => store.putScoreboard(makeScoreboard('s'), undefined, 1),
      () => store.putScoreboard(makeScoreboard('s'), 1, 1),
      () => store.hitRateLimit('k', 1, 1000, 5),
      () => store.getSession('s'),
      () => store.countPlayers('s'),
      () => store.listSessionsByHost('h', 5),
      () => store.deleteConnection('c'),
      () => store.putConnection(makeConnection('s')),
    ];
    for (const call of calls) await expect(call()).rejects.toBe(boom);
  });

  it('turns expected condition failures into the contract errors', async () => {
    const { store } = scriptedStore(() => {
      throw conditionFailed();
    });
    await expect(store.putQuiz(makeQuiz('o'))).rejects.toBeInstanceOf(ConflictError);
    await expect(store.updateSession(makeMeta(), 1)).rejects.toBeInstanceOf(ConflictError);
    await expect(store.putScoreboard(makeScoreboard('s'), 0, 1)).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(store.updatePlayer('s', 'p', { kicked: true })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(store.setResponseStatus('s', 0, 'p-0', 'hidden')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(await store.reservePin('p', 's', 1)).toBe(false);
    await expect(store.releasePin('p', 's')).resolves.toBeUndefined();
  });

  it('reads the existing response from the exception, unmarshalling it', async () => {
    const existing = makeResponse('s', 0, 'p', { normalizedText: 'x' });
    const item = { ...existing, pk: 'RESP#s#0#0', sk: 'P#p#00', expiresAt: 5 };
    const { store, sent } = scriptedStore(() => {
      throw conditionFailed({ Item: marshall(item) });
    });
    expect(await store.putResponse(makeResponse('s', 0, 'p'), 5000)).toEqual({
      created: false,
      existing,
    });
    expect(sent).toHaveLength(1);
  });

  it('falls back to a consistent read when the exception carries no item', async () => {
    const existing = makeResponse('s', 0, 'p');
    const { store, sent } = scriptedStore((command) => {
      if (command instanceof PutCommand) throw conditionFailed();
      return { Item: { ...existing, pk: 'k', sk: 'k', expiresAt: 5 } };
    });
    expect(await store.putResponse(makeResponse('s', 0, 'p'), 5000)).toEqual({
      created: false,
      existing,
    });
    const get = sent[1] as GetCommand;
    expect(get).toBeInstanceOf(GetCommand);
    expect(get.input.ConsistentRead).toBe(true);
  });

  it('retries the put when the item it collided with has already gone', async () => {
    const { store, sent } = scriptedStore((command, n) => {
      if (n === 1) throw conditionFailed();
      if (command instanceof GetCommand) return {};
      return {};
    });
    expect(await store.putResponse(makeResponse('s', 0, 'p'), 5000)).toEqual({ created: true });
    expect(sent).toHaveLength(3);
  });

  it('rejects an invalid page size', () => {
    const client = { send: async () => ({}) } as unknown as DynamoDBDocumentClient;
    expect(() => new DynamoStore({ tableName: 't', client, pageSize: 0 })).toThrow(RangeError);
  });
});
