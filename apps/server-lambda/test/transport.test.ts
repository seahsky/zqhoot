import {
  ApiGatewayManagementApiClient,
  DeleteConnectionCommand,
  GoneException,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { describe, expect, it } from 'vitest';
import type { OutboundMessage } from '@zqhoot/protocol';
import { ApiGatewayTransport, POST_CONCURRENCY } from '../src/ports/api-gateway-transport.ts';
import type { ManagementApiClient } from '../src/ports/api-gateway-transport.ts';

const pong = (t = 1): OutboundMessage => ({ type: 'pong', t });
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Command = PostToConnectionCommand | DeleteConnectionCommand;

/** A client whose `send` is replaced, as the real class would be stubbed. */
function stubbedClient(send: (command: Command) => Promise<unknown>): ManagementApiClient {
  const client = new ApiGatewayManagementApiClient({
    region: 'us-east-1',
    endpoint: 'https://example.invalid/stage',
    credentials: { accessKeyId: 'a', secretAccessKey: 'b' },
  });
  client.send = send as unknown as typeof client.send;
  return client;
}

const posted = (command: Command): { id: string; wire: { ts: number; type: string } } => {
  const input = (command as PostToConnectionCommand).input;
  return {
    id: input.ConnectionId as string,
    wire: JSON.parse(new TextDecoder().decode(input.Data as Uint8Array)) as {
      ts: number;
      type: string;
    },
  };
};

class Logs {
  readonly warnings: Array<{ o: Record<string, unknown>; m?: string | undefined }> = [];
  debug() {}
  info() {}
  warn(o: object, m?: string) {
    this.warnings.push({ o: o as Record<string, unknown>, m });
  }
  error() {}
}

const goneError = () => new GoneException({ message: 'Gone', $metadata: { httpStatusCode: 410 } });

describe('ApiGatewayTransport', () => {
  it('never runs more than 50 PostToConnection calls at once, and awaits all of them', async () => {
    let inFlight = 0;
    let peak = 0;
    let completed = 0;
    const transport = new ApiGatewayTransport({
      client: stubbedClient(async () => {
        peak = Math.max(peak, ++inFlight);
        await wait(2);
        inFlight--;
        completed++;
        return {};
      }),
      clock: { now: () => 1 },
    });

    const batch = Array.from({ length: 400 }, (_, i) => ({
      connectionId: `c${i}`,
      message: pong(i),
    }));
    const result = await transport.send(batch);

    expect(POST_CONCURRENCY).toBe(50);
    expect(peak).toBe(50);
    // Nothing may still be running when send resolves: Lambda would freeze it.
    expect(completed).toBe(400);
    expect(inFlight).toBe(0);
    expect(result.gone).toEqual([]);
  });

  it('starts fewer workers than the pool size for a small batch', async () => {
    let peak = 0;
    let inFlight = 0;
    const transport = new ApiGatewayTransport({
      client: stubbedClient(async () => {
        peak = Math.max(peak, ++inFlight);
        await wait(2);
        inFlight--;
        return {};
      }),
      clock: { now: () => 1 },
    });
    await transport.send([
      { connectionId: 'a', message: pong() },
      { connectionId: 'b', message: pong() },
      { connectionId: 'c', message: pong() },
    ]);
    expect(peak).toBe(3);
  });

  it('returns immediately for an empty batch', async () => {
    const transport = new ApiGatewayTransport({
      client: stubbedClient(async () => {
        throw new Error('must not be called');
      }),
      clock: { now: () => 1 },
    });
    await expect(transport.send([])).resolves.toEqual({ gone: [] });
  });

  it('reports a GoneException as gone and delivers the rest', async () => {
    const seen: string[] = [];
    const transport = new ApiGatewayTransport({
      client: stubbedClient(async (command) => {
        const { id } = posted(command);
        seen.push(id);
        if (id === 'dead') throw goneError();
        return {};
      }),
      clock: { now: () => 1 },
    });
    const result = await transport.send([
      { connectionId: 'a', message: pong() },
      { connectionId: 'dead', message: pong() },
      { connectionId: 'b', message: pong() },
    ]);
    expect(result.gone).toEqual(['dead']);
    expect(seen.sort()).toEqual(['a', 'b', 'dead']);
  });

  it('treats any HTTP 410 as gone, whatever the error is called', async () => {
    const transport = new ApiGatewayTransport({
      client: stubbedClient(async () => {
        throw Object.assign(new Error('nope'), { $metadata: { httpStatusCode: 410 } });
      }),
      clock: { now: () => 1 },
    });
    const result = await transport.send([{ connectionId: 'x', message: pong() }]);
    expect(result.gone).toEqual(['x']);
  });

  it('reports each gone connection once even if it appears twice in a batch', async () => {
    const transport = new ApiGatewayTransport({
      client: stubbedClient(async () => {
        throw goneError();
      }),
      clock: { now: () => 1 },
    });
    const result = await transport.send([
      { connectionId: 'x', message: pong(1) },
      { connectionId: 'x', message: pong(2) },
    ]);
    expect(result.gone).toEqual(['x']);
  });

  it('logs another error, does not throw, and still delivers the others', async () => {
    const delivered: string[] = [];
    const logs = new Logs();
    const transport = new ApiGatewayTransport({
      client: stubbedClient(async (command) => {
        const { id } = posted(command);
        if (id === 'flaky') throw Object.assign(new Error('boom'), { name: 'InternalFailure' });
        delivered.push(id);
        return {};
      }),
      clock: { now: () => 1 },
      logger: logs,
    });

    const result = await transport.send([
      { connectionId: 'a', message: pong() },
      { connectionId: 'flaky', message: pong() },
      { connectionId: 'b', message: pong() },
    ]);

    expect(delivered.sort()).toEqual(['a', 'b']);
    // Not gone: the connection may be fine, so the service must not delete its record.
    expect(result.gone).toEqual([]);
    expect(logs.warnings).toHaveLength(1);
    expect(logs.warnings[0]?.o).toMatchObject({ connectionId: 'flaky', type: 'pong' });
  });

  it('stamps ts immediately before each call, so it rises with the clock', async () => {
    let clock = 1_000;
    const stamped: Array<{ id: string; ts: number }> = [];
    const transport = new ApiGatewayTransport({
      client: stubbedClient(async (command) => {
        const { id, wire } = posted(command);
        stamped.push({ id, ts: wire.ts });
        await wait(3);
        return {};
      }),
      // Every read of the clock is later than the last, like real time.
      clock: { now: () => (clock += 7) },
    });

    await transport.send(
      Array.from({ length: 120 }, (_, i) => ({ connectionId: `c${i}`, message: pong(i) })),
    );

    expect(stamped).toHaveLength(120);
    const values = stamped.map((s) => s.ts);
    expect(new Set(values).size).toBe(120);
    // Stamps are taken as each call starts, so call order and stamp order agree.
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(Math.min(...values)).toBe(1_007);
    expect(Math.max(...values)).toBe(1_000 + 7 * 120);
  });

  it('puts ts first and keeps the message body intact', async () => {
    let body = '';
    const transport = new ApiGatewayTransport({
      client: stubbedClient(async (command) => {
        body = new TextDecoder().decode(
          (command as PostToConnectionCommand).input.Data as Uint8Array,
        );
        return {};
      }),
      clock: { now: () => 42 },
    });
    await transport.send([{ connectionId: 'a', message: { type: 'pong', t: 9 } }]);
    expect(body).toBe('{"ts":42,"type":"pong","t":9}');
  });

  it('closes with DeleteConnection and ignores a 410', async () => {
    const deleted: string[] = [];
    let gone = false;
    const transport = new ApiGatewayTransport({
      client: stubbedClient(async (command) => {
        expect(command).toBeInstanceOf(DeleteConnectionCommand);
        deleted.push((command as DeleteConnectionCommand).input.ConnectionId as string);
        if (gone) throw goneError();
        return {};
      }),
      clock: { now: () => 1 },
    });
    await transport.close('abc=');
    gone = true;
    await expect(transport.close('def=')).resolves.toBeUndefined();
    expect(deleted).toEqual(['abc=', 'def=']);
  });

  it('lets other close failures reach the service, which logs them', async () => {
    const transport = new ApiGatewayTransport({
      client: stubbedClient(async () => {
        throw new Error('throttled');
      }),
      clock: { now: () => 1 },
    });
    await expect(transport.close('abc=')).rejects.toThrow('throttled');
  });
});
