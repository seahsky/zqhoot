import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Clock } from '@zqhoot/service';
import { parseConfig } from '../../src/config.ts';
import type { ServerConfig } from '../../src/config.ts';
import { createServer } from '../../src/server.ts';
import type { ServerHandle } from '../../src/server.ts';

export const ADMIN_USER = 'admin';
export const ADMIN_PASSWORD = 'correct horse battery staple';
export const JWT_SECRET = 'test-secret-that-is-longer-than-thirty-two-bytes';
/** Not the address the sockets connect to: the server is behind an imaginary proxy at this origin. */
export const PUBLIC_URL = 'http://quiz.test';

export const INDEX_HTML =
  '<!doctype html><html><head><title>stub</title></head><body>app shell</body></html>';

export interface Workspace {
  root: string;
  dataDir: string;
  webDist: string;
  /** A file next to `webDist`, which no request may ever return. */
  secretPath: string;
  cleanup(): Promise<void>;
}

/** A temp data dir and a stub web dist, so tests never depend on `apps/web/dist`. */
export async function createWorkspace(): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), 'zqhoot-node-'));
  const webDist = join(root, 'web');
  const dataDir = join(root, 'data');
  await mkdir(join(webDist, 'assets'), { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(webDist, 'index.html'), INDEX_HTML);
  await writeFile(join(webDist, 'assets', 'app-abc123.js'), 'console.log("app");');
  await writeFile(join(webDist, 'assets', 'app-abc123.css'), 'body{margin:0}');
  await writeFile(join(webDist, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await mkdir(join(webDist, '.well-known'), { recursive: true });
  await writeFile(join(webDist, '.well-known', 'security.txt'), 'Contact: mailto:ops@quiz.test');
  await mkdir(join(webDist, '.git'), { recursive: true });
  await writeFile(join(webDist, '.git', 'config'), 'REPO-SECRET');
  await writeFile(join(webDist, '.env'), 'ENV-SECRET');
  const secretPath = join(root, 'secret.txt');
  await writeFile(secretPath, 'TOP-SECRET');
  return {
    root,
    dataDir,
    webDist,
    secretPath,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export function testConfig(ws: Workspace, env: Record<string, string> = {}): ServerConfig {
  const parsed = parseConfig({
    ZQ_PORT: '0',
    ZQ_HOST: '127.0.0.1',
    ZQ_PUBLIC_URL: PUBLIC_URL,
    ZQ_DATA_DIR: ws.dataDir,
    ZQ_WEB_DIST: ws.webDist,
    ZQ_ADMIN_USER: ADMIN_USER,
    ZQ_ADMIN_PASSWORD: ADMIN_PASSWORD,
    ZQ_JWT_SECRET: JWT_SECRET,
    ZQ_LOG_LEVEL: 'silent',
    ...env,
  });
  if (!parsed.ok) throw new Error(`test config is invalid: ${parsed.errors.join('; ')}`);
  return parsed.config;
}

export interface TestServer {
  handle: ServerHandle;
  config: ServerConfig;
  port: number;
  http: string;
  ws: string;
  /** `Origin` header a browser on the public URL sends. */
  origin: string;
  close(): Promise<void>;
}

export async function startServer(
  ws: Workspace,
  opts: {
    env?: Record<string, string>;
    clock?: Clock;
    sweepIntervalMs?: number;
    pingIntervalMs?: number;
  } = {},
): Promise<TestServer> {
  const config = testConfig(ws, opts.env);
  const handle = await createServer(config, {
    // A cheap scrypt keeps every login in these tests to a few milliseconds.
    scryptCost: { N: 1024, r: 8, p: 1 },
    ...(opts.clock !== undefined && { clock: opts.clock }),
    ...(opts.sweepIntervalMs !== undefined && { sweepIntervalMs: opts.sweepIntervalMs }),
    ...(opts.pingIntervalMs !== undefined && { pingIntervalMs: opts.pingIntervalMs }),
  });
  const address = await handle.start();
  return {
    handle,
    config,
    port: address.port,
    http: `http://127.0.0.1:${address.port}`,
    ws: `ws://127.0.0.1:${address.port}/ws`,
    origin: config.publicUrl.origin,
    close: () => handle.close(),
  };
}
