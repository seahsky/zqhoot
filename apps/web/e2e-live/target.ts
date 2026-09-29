/**
 * Which server the live suite runs against, chosen with `ZQ_E2E_TARGET`. Both the Playwright
 * config and the specs import this, so the ports and the login can never disagree.
 */

export type TargetName = 'node' | 'lambda-emulator';

function readTarget(): TargetName {
  const raw = process.env.ZQ_E2E_TARGET ?? 'node';
  if (raw === 'node' || raw === 'lambda-emulator') return raw;
  throw new Error(`ZQ_E2E_TARGET must be "node" or "lambda-emulator", got "${raw}"`);
}

export const TARGET: TargetName = readTarget();

/** The single host account both servers are started with. */
export const HOST_LOGIN = { username: 'e2e', password: 'e2e-password' } as const;

/** Exactly 48 characters; the servers want at least 32. */
export const JWT_SECRET = 'zqhoot-e2e-jwt-secret-0123456789-abcdefghijklmno';

const NODE_PORT = 8181;
/**
 * The emulator's three listeners. They stay clear of its defaults (3000-3002), which a load run
 * on the same machine may be using.
 */
export const EMULATOR_PORTS = { http: 8281, ws: 8282, mgmt: 8283 } as const;

/**
 * The page origin. It must be `localhost`, not `127.0.0.1`: both servers accept a WebSocket
 * only from the exact origin they were told about.
 */
export const BASE_URL =
  TARGET === 'node' ? `http://localhost:${NODE_PORT}` : `http://localhost:${EMULATOR_PORTS.http}`;

export const NODE_SERVER_PORT = NODE_PORT;

/** DynamoDB Local, for the emulator target. */
export const DDB_ENDPOINT = process.env.ZQ_DDB_ENDPOINT ?? 'http://localhost:8000';

/** Screenshots of one run land here, one directory per target (gitignored). */
export const SHOT_DIR = `e2e-live/screenshots/${TARGET}`;
