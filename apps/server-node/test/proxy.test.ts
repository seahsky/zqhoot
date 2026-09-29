import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_USER, createWorkspace, startServer } from './helpers/server.ts';
import type { TestServer, Workspace } from './helpers/server.ts';

let workspace: Workspace;
let proxyWorkspace: Workspace;
let direct: TestServer;
let proxied: TestServer;

beforeAll(async () => {
  workspace = await createWorkspace();
  direct = await startServer(workspace, { env: { ZQ_TRUST_PROXY: 'false' } });
  // A second data directory: two servers must not write one state file.
  proxyWorkspace = await createWorkspace();
  proxied = await startServer(proxyWorkspace, { env: { ZQ_TRUST_PROXY: 'true' } });
});

afterAll(async () => {
  await direct.close();
  await proxied.close();
  await workspace.cleanup();
  await proxyWorkspace.cleanup();
});

async function wrongLogin(server: TestServer, forwardedFor: string | undefined): Promise<number> {
  const res = await fetch(`${server.http}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(forwardedFor !== undefined && { 'X-Forwarded-For': forwardedFor }),
    },
    body: JSON.stringify({ username: ADMIN_USER, password: 'wrong' }),
  });
  return res.status;
}

describe('client address behind Caddy (ZQ_TRUST_PROXY)', () => {
  it('counts login attempts per first X-Forwarded-For hop when the proxy is trusted', async () => {
    for (let i = 0; i < 10; i++)
      expect(await wrongLogin(proxied, '203.0.113.10, 10.0.0.1')).toBe(401);
    // Eleventh attempt from the same client address: over the 10 per 15 minutes limit.
    expect(await wrongLogin(proxied, '203.0.113.10, 10.0.0.2')).toBe(429);
    // Another client behind the same proxy is unaffected.
    expect(await wrongLogin(proxied, '203.0.113.11')).toBe(401);
    expect(await wrongLogin(proxied, '2001:db8::7')).toBe(401);
  });

  it('ignores X-Forwarded-For when the proxy is not trusted', async () => {
    for (let i = 0; i < 10; i++) expect(await wrongLogin(direct, `198.51.100.${i}`)).toBe(401);
    // Ten different forged addresses were all one client, so the next attempt is refused however it is labelled.
    expect(await wrongLogin(direct, '198.51.100.200')).toBe(429);
    expect(await wrongLogin(direct, undefined)).toBe(429);
  });
});
