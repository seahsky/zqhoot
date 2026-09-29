import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { ServerMessage } from '@zqhoot/protocol';
import { DDB_ENDPOINT } from './dynamo.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

export interface EmulatorInfo {
  http: string;
  ws: string;
  mgmt: string;
  callback: string;
  origin: string;
  table: string;
}

export interface EmulatorProcess {
  info: EmulatorInfo;
  output: string[];
  /** Sends SIGTERM and resolves with the exit code (null if it had to be killed). */
  stop(): Promise<number | null>;
}

/** Runs the built emulator (`dist/emulator/main.mjs`) as a child process on free ports. */
export async function startEmulatorProcess(opts: {
  table: string;
  webDist: string;
  env?: Record<string, string>;
}): Promise<EmulatorProcess> {
  const child: ChildProcess = spawn(
    process.execPath,
    ['--enable-source-maps', 'dist/emulator/main.mjs'],
    {
      cwd: root,
      env: {
        ...process.env,
        ZQ_EMU_HTTP_PORT: '0',
        ZQ_EMU_WS_PORT: '0',
        ZQ_EMU_MGMT_PORT: '0',
        ZQ_TABLE_NAME: opts.table,
        ZQ_DDB_ENDPOINT: DDB_ENDPOINT,
        ZQ_EMU_WEB_DIST: opts.webDist,
        ZQ_LOG_LEVEL: 'warn',
        ZQ_WARM_CONCURRENCY: '2',
        ...opts.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const output: string[] = [];

  const info = await new Promise<EmulatorInfo>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`emulator not ready after 30 s:\n${output.join('')}`)),
      30_000,
    );
    let buffered = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output.push(chunk.toString());
      buffered += chunk.toString();
      const line = buffered.split('\n').find((l) => l.startsWith('ZQ_EMULATOR_READY '));
      if (line !== undefined) {
        clearTimeout(timer);
        resolve(JSON.parse(line.slice('ZQ_EMULATOR_READY '.length)) as EmulatorInfo);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`emulator exited with ${code} before it was ready:\n${output.join('')}`));
    });
  });

  return {
    info,
    output,
    stop: () =>
      new Promise<number | null>((resolve) => {
        if (child.exitCode !== null) return resolve(child.exitCode);
        child.once('exit', (code) => resolve(code));
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      }),
  };
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function until(
  check: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
}

type Msg = ServerMessage;

/** A WebSocket test client that validates every frame against the protocol's `ServerMessage`. */
export class Client {
  readonly name: string;
  readonly seen: Msg[] = [];
  readonly invalid: string[] = [];
  readonly frames: string[] = [];
  closeCode: number | undefined;
  readonly #ws: WebSocket;
  #floor = 0;

  private constructor(name: string, ws: WebSocket) {
    this.name = name;
    this.#ws = ws;
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        this.invalid.push('binary frame');
        return;
      }
      const text = data.toString();
      this.frames.push(text);
      const parsed = ServerMessage.safeParse(JSON.parse(text));
      if (parsed.success) this.seen.push(JSON.parse(text) as Msg);
      else this.invalid.push(`${text}: ${parsed.error.message}`);
    });
    ws.on('close', (code) => {
      this.closeCode = code;
    });
    ws.on('error', () => {});
  }

  static open(name: string, url: string, origin: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { origin });
      ws.once('open', () => resolve(new Client(name, ws)));
      ws.once('unexpected-response', (_req, res) =>
        reject(new Error(`upgrade refused: ${res.statusCode}`)),
      );
      ws.once('error', reject);
    });
  }

  send(message: object): void {
    this.#ws.send(JSON.stringify(message));
  }

  /** Later `waitFor` calls only consider messages that arrive after this. */
  reset(): void {
    this.#floor = this.seen.length;
  }

  async waitFor<T extends Msg['type']>(
    type: T,
    where: (m: Extract<Msg, { type: T }>) => boolean = () => true,
    timeoutMs = 10_000,
  ): Promise<Extract<Msg, { type: T }>> {
    let found: Extract<Msg, { type: T }> | undefined;
    await until(
      () => {
        found = this.seen
          .slice(this.#floor)
          .find((m): m is Extract<Msg, { type: T }> => m.type === type && where(m as never));
        return found !== undefined;
      },
      `${this.name} to receive '${type}' (has: ${this.seen.map((m) => m.type).join(', ')})`,
      timeoutMs,
    );
    return found as Extract<Msg, { type: T }>;
  }

  get isOpen(): boolean {
    return this.#ws.readyState === WebSocket.OPEN;
  }

  waitClosed(timeoutMs = 10_000): Promise<number> {
    return until(() => this.closeCode !== undefined, `${this.name} to close`, timeoutMs).then(
      () => this.closeCode as number,
    );
  }

  close(): void {
    this.#ws.close(1000);
  }
}
