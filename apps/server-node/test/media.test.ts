import { readdir, readFile, stat } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIMITS } from '@zqhoot/protocol';
import type { ImageContentType, UploadGrant } from '@zqhoot/protocol';
import { apiFor, login } from './helpers/client.ts';
import { rawRequest } from './helpers/http.ts';
import { createWorkspace, startServer } from './helpers/server.ts';
import type { TestServer, Workspace } from './helpers/server.ts';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(40, 1),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 2)]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(40, 3)]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.from([40, 0, 0, 0]),
  Buffer.from('WEBP', 'latin1'),
  Buffer.alloc(40, 4),
]);
const SAMPLES: Record<ImageContentType, Buffer> = {
  'image/png': PNG,
  'image/jpeg': JPEG,
  'image/gif': GIF,
  'image/webp': WEBP,
};

let workspace: Workspace;
let server: TestServer;
let token: string;

beforeAll(async () => {
  workspace = await createWorkspace();
  server = await startServer(workspace);
  token = await login(apiFor(server));
});

afterAll(async () => {
  await server.close();
  await workspace.cleanup();
});

async function grant(
  contentType: ImageContentType = 'image/png',
  size = 100,
): Promise<UploadGrant> {
  const res = await apiFor(server)('POST', '/api/media/uploads', {
    token,
    body: { contentType, size },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as UploadGrant;
}

const putUrl = (g: UploadGrant): string => (g.upload.method === 'PUT' ? g.upload.url : '');

async function put(url: string, body: Buffer, contentType: string): Promise<number> {
  const res = await rawRequest(server, 'PUT', url, {
    headers: { 'Content-Type': contentType },
    body,
  });
  return res.status;
}

/** Every file below the media folder, so a test can prove that a refusal left nothing behind. */
async function mediaFiles(): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else found.push(path);
    }
  };
  await walk(join(workspace.dataDir, 'media'));
  return found.sort();
}

describe('upload grant', () => {
  it('is a PUT to /api/media/{key} with a token that lives 5 minutes', async () => {
    const before = Date.now();
    const g = await grant('image/jpeg');
    expect(g.key).toMatch(/^media\/[A-Za-z0-9_-]{22}\/[A-Za-z0-9_-]{21}\.jpg$/);
    expect(g.upload.method).toBe('PUT');
    if (g.upload.method !== 'PUT') return;
    expect(g.upload.url).toMatch(
      new RegExp(`^/api/media/${g.key}\\?t=\\d{13}\\.[A-Za-z0-9_-]{22}$`),
    );
    expect(g.upload.headers).toEqual({ 'Content-Type': 'image/jpeg' });
    expect(g.expiresAt).toBeGreaterThanOrEqual(before + 5 * 60_000);
    expect(g.expiresAt).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
    expect(g.key).not.toContain('local');
  });

  it('needs a host token', async () => {
    const res = await apiFor(server)('POST', '/api/media/uploads', {
      body: { contentType: 'image/png', size: 10 },
    });
    expect(res.status).toBe(401);
  });
});

describe('upload and serving', () => {
  it.each(Object.entries(SAMPLES))(
    'stores %s and serves it back immutable',
    async (type, bytes) => {
      const g = await grant(type as ImageContentType, bytes.length);
      expect(await put(putUrl(g), bytes, type)).toBe(204);

      const served = await rawRequest(server, 'GET', `/${g.key}`);
      expect(served.status).toBe(200);
      expect(served.body.equals(bytes)).toBe(true);
      expect(served.headers['content-type']).toBe(type);
      expect(served.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(served.headers['x-content-type-options']).toBe('nosniff');
      expect(served.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
      expect(Number(served.headers['content-length'])).toBe(bytes.length);
      expect((await stat(join(workspace.dataDir, g.key))).size).toBe(bytes.length);
    },
  );

  it('answers HEAD for a stored file', async () => {
    const g = await grant();
    await put(putUrl(g), PNG, 'image/png');
    const res = await rawRequest(server, 'HEAD', `/${g.key}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });

  it('does not let a grant be used twice', async () => {
    const g = await grant();
    expect(await put(putUrl(g), PNG, 'image/png')).toBe(204);
    expect(await put(putUrl(g), Buffer.concat([PNG, Buffer.from('changed')]), 'image/png')).toBe(
      403,
    );
    expect((await readFile(join(workspace.dataDir, g.key))).equals(PNG)).toBe(true);
  });

  it('answers 204 to exactly one of several concurrent uploads with one grant', async () => {
    const g = await grant();
    const bodies = Array.from({ length: 6 }, (_, i) => Buffer.concat([PNG, Buffer.alloc(8, i)]));
    // The bodies end together, so every request passes the "already stored?" pre-check and the
    // race is settled when the file is published.
    const release = new Promise((resolve) => setTimeout(resolve, 100));
    const slowBody = async function* (bytes: Buffer): AsyncGenerator<Buffer> {
      yield bytes;
      await release;
    };
    const statuses = await Promise.all(
      bodies.map((bytes) =>
        rawRequest(server, 'PUT', putUrl(g), {
          headers: { 'Content-Type': 'image/png' },
          body: slowBody(bytes),
        }).then((res) => res.status),
      ),
    );
    expect(statuses.filter((s) => s === 204)).toHaveLength(1);
    expect(statuses.filter((s) => s === 403)).toHaveLength(bodies.length - 1);

    const stored = await readFile(join(workspace.dataDir, g.key));
    expect(bodies.some((b) => b.equals(stored))).toBe(true);
    expect((await mediaFiles()).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('answers 404 for keys that were never stored or are not media keys', async () => {
    const g = await grant();
    for (const path of [
      `/${g.key}`,
      '/media/x/y.png',
      `/${g.key.replace('.png', '.svg')}`,
      `/${g.key}.tmp`,
      '/media/',
      '/media/a',
    ]) {
      expect((await rawRequest(server, 'GET', path)).status).toBe(404);
    }
  });
});

describe('refused uploads', () => {
  it('rejects a missing, malformed or forged token with 403', async () => {
    const before = await mediaFiles();
    const g = await grant();
    const [path, query] = putUrl(g).split('?t=') as [string, string];
    const forged = `${query.slice(0, -1)}${query.endsWith('A') ? 'B' : 'A'}`;
    for (const bad of [
      path,
      `${path}?t=`,
      `${path}?t=garbage`,
      `${path}?t=${forged}`,
      `${path}?t=1.${'A'.repeat(22)}`,
    ]) {
      expect(await put(bad, PNG, 'image/png'), bad).toBe(403);
    }
    expect(await mediaFiles()).toEqual(before);
  });

  it('rejects a token issued for another key or another content type', async () => {
    const before = await mediaFiles();
    const one = await grant();
    const two = await grant();
    const token1 = putUrl(one).split('?t=')[1];
    expect(await put(`/api/media/${two.key}?t=${token1}`, PNG, 'image/png')).toBe(403);
    expect(await put(putUrl(one), PNG, 'image/jpeg')).toBe(403);
    expect(await put(putUrl(one), PNG, 'application/octet-stream')).toBe(403);
    expect(await mediaFiles()).toEqual(before);
  });

  it('rejects bytes that do not match the declared type with 415 and leaves no file', async () => {
    const before = await mediaFiles();
    for (const [declared, body] of [
      ['image/png', JPEG],
      ['image/jpeg', PNG],
      ['image/gif', WEBP],
      ['image/webp', GIF],
      [
        'image/png',
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      ],
      ['image/png', Buffer.from('#!/bin/sh\necho hi\n')],
      ['image/png', Buffer.alloc(0)],
      ['image/png', PNG.subarray(0, 5)],
    ] as Array<[ImageContentType, Buffer]>) {
      const g = await grant(declared);
      expect(
        await put(putUrl(g), body, declared),
        `${declared} <- ${body.subarray(0, 6).toString('latin1')}`,
      ).toBe(415);
    }
    expect(await mediaFiles()).toEqual(before);
  });

  it('rejects a declared length over 5 MB with 413', async () => {
    const before = await mediaFiles();
    const g = await grant();
    const big = Buffer.concat([PNG, Buffer.alloc(LIMITS.imageMaxBytes)]);
    expect(await put(putUrl(g), big, 'image/png')).toBe(413);
    expect(await mediaFiles()).toEqual(before);
  });

  it('aborts a streamed upload past 5 MB with 413 and removes the temp file', async () => {
    const before = await mediaFiles();
    const g = await grant();
    const chunk = Buffer.alloc(256 * 1024, 7);
    async function* body(): AsyncGenerator<Buffer> {
      yield Buffer.concat([PNG, chunk]);
      // No Content-Length: the limit has to be enforced while the bytes arrive.
      for (let sent = 0; sent < LIMITS.imageMaxBytes + 2 * chunk.length; sent += chunk.length) {
        yield chunk;
      }
    }
    const res = await rawRequest(server, 'PUT', putUrl(g), {
      headers: { 'Content-Type': 'image/png' },
      body: body(),
    });
    expect(res.status).toBe(413);
    expect(await mediaFiles()).toEqual(before);
  });

  it('accepts a file of exactly 5 MB', async () => {
    const g = await grant('image/png', LIMITS.imageMaxBytes);
    const exact = Buffer.concat([PNG, Buffer.alloc(LIMITS.imageMaxBytes - PNG.length, 9)]);
    expect(exact.length).toBe(LIMITS.imageMaxBytes);
    expect(await put(putUrl(g), exact, 'image/png')).toBe(204);
  });

  it('rejects path traversal in the key', async () => {
    const before = await mediaFiles();
    const g = await grant();
    const t = putUrl(g).split('?t=')[1];
    for (const path of [
      `/api/media/media/../../secret.png?t=${t}`,
      `/api/media/media/%2e%2e/%2e%2e/secret.png?t=${t}`,
      `/api/media/media/..%2f..%2fsecret.png?t=${t}`,
      `/api/media/media/a/b/../../../secret.png?t=${t}`,
      `/api/media/../../secret.png?t=${t}`,
      `/api/media/media/${'a'.repeat(30)}/../x.png?t=${t}`,
      `/api/media/media//x.png?t=${t}`,
      `/api/media/?t=${t}`,
    ]) {
      const status = await put(path, PNG, 'image/png');
      expect(status, path).toBeGreaterThanOrEqual(400);
      expect(status, path).toBeLessThan(500);
    }
    expect(await readFile(workspace.secretPath, 'utf8')).toBe('TOP-SECRET');
    expect(await mediaFiles()).toEqual(before);
    expect((await readdir(workspace.root)).sort()).toEqual(['data', 'secret.txt', 'web']);
  });

  it('leaves no temp file after a client that hangs up mid-upload', async () => {
    const before = await mediaFiles();
    const g = await grant();
    const url = new URL(putUrl(g), server.http);
    await new Promise<void>((resolve) => {
      const req = request({
        host: '127.0.0.1',
        port: server.port,
        path: url.pathname + url.search,
        method: 'PUT',
        headers: { 'Content-Type': 'image/png', 'Transfer-Encoding': 'chunked' },
        agent: false,
      });
      req.on('error', () => undefined);
      req.write(Buffer.concat([PNG, Buffer.alloc(1000)]));
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 100);
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await mediaFiles()).toEqual(before);
  });
});
