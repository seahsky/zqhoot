// Runs the server under test with a fresh data directory, and cleans up after it.
//
// Playwright's `webServer` stops the process group with SIGTERM (see playwright.live.config.ts),
// so this wrapper outlives the request to stop long enough to remove what the run left behind:
// the temporary data directory and, for the emulator, the DynamoDB Local table.
//
//   node e2e-live/run-server.mjs <command> [args...]
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';

const [command, ...args] = process.argv.slice(2);
if (!command) {
  process.stderr.write('usage: run-server.mjs <command> [args...]\n');
  process.exit(2);
}

const dataDir = mkdtempSync(join(tmpdir(), 'zqhoot-e2e-'));
const child = spawn(command, args, {
  stdio: 'inherit',
  env: { ...process.env, ZQ_DATA_DIR: dataDir },
});

// Set when this wrapper was asked to stop, so that a stop is told apart from a crash.
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    child.kill(signal);
  });
}

/** DynamoDB Local reads the access key from the header and never checks the signature. */
async function dropTable(endpoint, table) {
  try {
    await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-amz-json-1.0',
        'x-amz-target': 'DynamoDB_20120810.DeleteTable',
        authorization:
          'AWS4-HMAC-SHA256 Credential=emulator/20260101/us-east-1/dynamodb/aws4_request, SignedHeaders=host;x-amz-date, Signature=0',
      },
      body: JSON.stringify({ TableName: table }),
    });
  } catch {
    // Best effort: the table has a unique name, so a leftover harms nobody.
  }
}

child.on('exit', async (code, signal) => {
  rmSync(dataDir, { recursive: true, force: true });
  const table = process.env.ZQ_E2E_DROP_TABLE;
  const endpoint = process.env.ZQ_DDB_ENDPOINT;
  if (table && endpoint) await dropTable(endpoint, table);
  // Stopped on request is a success. A server that died from a signal nobody sent through this
  // wrapper (the OOM killer's SIGKILL, an abort) fails like a shell reports it: 128 + signal.
  if (signal) process.exit(stopping ? 0 : 128 + (constants.signals[signal] ?? 1));
  process.exit(code ?? 1);
});
