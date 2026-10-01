import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { ServerMessage } from '@zqhoot/protocol';
import type { OutboundMessage } from '@zqhoot/protocol';
import { noopLogger, stampAndSerialize } from '@zqhoot/service';
import { SKIP_STATE_ABOVE_BYTES, TERMINATE_ABOVE_BYTES, WsTransport } from '../src/ws-transport.ts';
import type { TransportSocket } from '../src/ws-transport.ts';

interface FakeSocket extends TransportSocket {
  sent: Array<{ data: string; options: unknown }>;
  terminated: boolean;
  closedWith: Array<{ code: number | undefined; reason: string | undefined }>;
}

function fakeSocket(opts: { bufferedAmount?: number; readyState?: number } = {}): FakeSocket {
  const socket = {
    readyState: opts.readyState ?? WebSocket.OPEN,
    bufferedAmount: opts.bufferedAmount ?? 0,
    sent: [] as FakeSocket['sent'],
    terminated: false,
    closedWith: [] as FakeSocket['closedWith'],
    send(data: string, options: unknown) {
      socket.sent.push({ data, options });
    },
    close(code?: number, reason?: string) {
      socket.closedWith.push({ code, reason });
    },
    terminate() {
      socket.terminated = true;
    },
  };
  return socket as unknown as FakeSocket;
}

const KICKED: OutboundMessage = { type: 'kicked' };
const ROSTER: OutboundMessage = { type: 'roster', upsert: [], removed: [] };
const LEADERBOARD: OutboundMessage = {
  type: 'leaderboard',
  sv: 1,
  index: 0,
  entries: [],
  you: { score: 0, rank: null },
};
const ERROR: OutboundMessage = { type: 'error', code: 'internal', message: 'x' };
const PONG: OutboundMessage = { type: 'pong', t: 1 };

function setup() {
  let now = 1_700_000_000_000;
  const transport = new WsTransport({ now: () => now++ }, noopLogger);
  return { transport };
}

describe('WsTransport.send', () => {
  it('sends a text frame stamped with ts, identical to stampAndSerialize', async () => {
    const { transport } = setup();
    const socket = fakeSocket();
    transport.register('c1', socket);
    expect(await transport.send([{ connectionId: 'c1', message: ROSTER }])).toEqual({ gone: [] });
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]?.options).toEqual({ binary: false });
    const frame = socket.sent[0]?.data ?? '';
    expect(frame).toBe(stampAndSerialize(ROSTER, 1_700_000_000_000));
    expect(ServerMessage.parse(JSON.parse(frame))).toMatchObject({ type: 'roster' });
  });

  it('stamps each recipient of one broadcast separately, at send time', async () => {
    const { transport } = setup();
    const sockets = [fakeSocket(), fakeSocket(), fakeSocket()];
    sockets.forEach((s, i) => transport.register(`c${i}`, s));
    await transport.send(sockets.map((_, i) => ({ connectionId: `c${i}`, message: ROSTER })));
    const stamps = sockets.map((s) => (JSON.parse(s.sent[0]?.data ?? '{}') as { ts: number }).ts);
    expect(stamps).toEqual([1_700_000_000_000, 1_700_000_000_001, 1_700_000_000_002]);
    // The rest of each frame is the same shared serialisation.
    const bodies = new Set(sockets.map((s) => (s.sent[0]?.data ?? '').replace(/^\{"ts":\d+,/, '')));
    expect(bodies.size).toBe(1);
  });

  it('reports missing and closed sockets as gone and still delivers to the others', async () => {
    const { transport } = setup();
    const open = fakeSocket();
    const closing = fakeSocket({ readyState: WebSocket.CLOSING });
    const closed = fakeSocket({ readyState: WebSocket.CLOSED });
    transport.register('open', open);
    transport.register('closing', closing);
    transport.register('closed', closed);
    const result = await transport.send(
      ['missing', 'closing', 'open', 'closed'].map((connectionId) => ({
        connectionId,
        message: PONG,
      })),
    );
    expect(result.gone.sort()).toEqual(['closed', 'closing', 'missing']);
    expect(open.sent).toHaveLength(1);
    expect(closing.sent).toHaveLength(0);
  });

  it('reports a socket whose send throws as gone', async () => {
    const { transport } = setup();
    const socket = fakeSocket();
    socket.send = () => {
      throw new Error('not open');
    };
    transport.register('c1', socket);
    expect((await transport.send([{ connectionId: 'c1', message: PONG }])).gone).toEqual(['c1']);
  });

  it('skips state messages above 256 KiB of buffered data but never direct replies or roster deltas', async () => {
    const { transport } = setup();
    const slow = fakeSocket({ bufferedAmount: SKIP_STATE_ABOVE_BYTES + 1 });
    transport.register('slow', slow);
    const result = await transport.send([
      { connectionId: 'slow', message: LEADERBOARD },
      { connectionId: 'slow', message: ROSTER },
      { connectionId: 'slow', message: PONG },
      { connectionId: 'slow', message: ERROR },
      { connectionId: 'slow', message: KICKED },
    ]);
    expect(result.gone).toEqual([]);
    expect(slow.terminated).toBe(false);
    expect(slow.sent.map((s) => (JSON.parse(s.data) as { type: string }).type)).toEqual([
      'roster',
      'pong',
      'error',
      'kicked',
    ]);
  });

  it('sends normally at exactly 256 KiB', async () => {
    const { transport } = setup();
    const socket = fakeSocket({ bufferedAmount: SKIP_STATE_ABOVE_BYTES });
    transport.register('c1', socket);
    await transport.send([{ connectionId: 'c1', message: LEADERBOARD }]);
    expect(socket.sent).toHaveLength(1);
  });

  it('terminates a socket above 1 MiB and reports it gone', async () => {
    const { transport } = setup();
    const stuck = fakeSocket({ bufferedAmount: TERMINATE_ABOVE_BYTES + 1 });
    const atLimit = fakeSocket({ bufferedAmount: TERMINATE_ABOVE_BYTES });
    transport.register('stuck', stuck);
    transport.register('limit', atLimit);
    const result = await transport.send([
      { connectionId: 'stuck', message: PONG },
      { connectionId: 'limit', message: LEADERBOARD },
    ]);
    expect(result.gone).toEqual(['stuck']);
    expect(stuck.terminated).toBe(true);
    expect(stuck.sent).toHaveLength(0);
    expect(atLimit.terminated).toBe(false);
    expect(atLimit.sent).toHaveLength(0);
  });

  it('stops delivering to a connection once it is unregistered', async () => {
    const { transport } = setup();
    transport.register('c1', fakeSocket());
    transport.unregister('c1');
    expect((await transport.send([{ connectionId: 'c1', message: PONG }])).gone).toEqual(['c1']);
  });
});

describe('WsTransport.close', () => {
  it('closes with the given code and reason, defaulting to 1000', async () => {
    const { transport } = setup();
    const socket = fakeSocket();
    transport.register('c1', socket);
    await transport.close('c1', 1008, 'rate-limited');
    await transport.close('c1');
    expect(socket.closedWith).toEqual([
      { code: 1008, reason: 'rate-limited' },
      { code: 1000, reason: undefined },
    ]);
  });

  it('terminates a socket that refuses to close and ignores unknown ids', async () => {
    const { transport } = setup();
    const socket = fakeSocket();
    socket.close = () => {
      throw new RangeError('bad code');
    };
    transport.register('c1', socket);
    await transport.close('c1', 1005);
    expect(socket.terminated).toBe(true);
    await expect(transport.close('nobody', 1000)).resolves.toBeUndefined();
  });
});
