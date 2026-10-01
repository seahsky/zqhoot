import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MediaKey } from '@zqhoot/protocol';
import type { UploadGrant } from '@zqhoot/protocol';
import { MediaError } from '@zqhoot/service';
import { UPLOAD_TTL_MS, LocalMedia } from '../src/ports/local-media.ts';
import { createIds } from '../src/ports/ids.ts';

const SECRET = 'media-secret-that-is-longer-than-thirty-two-bytes';
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 1),
]);
const HOST = { hostId: 'local:admin', displayName: 'admin' };

let dir: string;
let now: number;
let media: LocalMedia;

const stream = (bytes: Buffer): ReadableStream<Uint8Array> =>
  Readable.toWeb(Readable.from([bytes])) as unknown as ReadableStream<Uint8Array>;

/** Bodies that all end together, so the uploads overlap and race for the same target. */
function overlappingStreams(bodies: Buffer[]): Array<ReadableStream<Uint8Array>> {
  const release = new Promise((resolve) => setTimeout(resolve, 50));
  return bodies.map(
    (bytes) =>
      Readable.toWeb(
        Readable.from(
          (async function* () {
            yield bytes;
            await release;
          })(),
        ),
      ) as unknown as ReadableStream<Uint8Array>,
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zqhoot-media-'));
  now = 1_800_000_000_000;
  media = new LocalMedia({
    dataDir: dir,
    secret: SECRET,
    clock: { now: () => now },
    ids: createIds(),
  });
});

afterEach(() => rm(dir, { recursive: true, force: true }));

async function grant(): Promise<{ g: UploadGrant; key: string; token: string }> {
  const g = await media.createUpload(HOST, { contentType: 'image/png', size: PNG.length }, now);
  if (g.upload.method !== 'PUT') throw new Error('expected a PUT grant');
  return { g, key: g.key, token: decodeURIComponent(g.upload.url.split('?t=')[1] ?? '') };
}

async function refusal(work: Promise<unknown>): Promise<MediaError> {
  try {
    await work;
  } catch (err) {
    if (err instanceof MediaError) return err;
    throw err;
  }
  throw new Error('expected a MediaError');
}

describe('createUpload', () => {
  it('returns a key that matches the protocol MediaKey and does not expose the host id', async () => {
    const { key } = await grant();
    expect(MediaKey.safeParse(key).success).toBe(true);
    expect(key).not.toContain('admin');
    const other = await media.createUpload(
      { hostId: 'local:other', displayName: 'o' },
      { contentType: 'image/png', size: 1 },
      now,
    );
    expect(other.key.split('/')[1]).not.toBe(key.split('/')[1]);
    const again = await media.createUpload(HOST, { contentType: 'image/webp', size: 1 }, now);
    expect(again.key.split('/')[1]).toBe(key.split('/')[1]);
    expect(again.key.endsWith('.webp')).toBe(true);
  });

  it('expires the grant after five minutes', async () => {
    const { g } = await grant();
    expect(g.expiresAt).toBe(now + UPLOAD_TTL_MS);
    expect(UPLOAD_TTL_MS).toBe(300_000);
  });
});

describe('put', () => {
  it('stores the bytes at {dataDir}/{key}', async () => {
    const { key, token } = await grant();
    await media.put(key, token, 'image/png', stream(PNG));
    const [slug] = await readdir(join(dir, 'media'));
    expect(await readdir(join(dir, 'media', slug ?? ''))).toEqual([key.split('/')[2]]);
  });

  it('accepts a token up to and including its expiry, then refuses it', async () => {
    const { g, key, token } = await grant();
    now = g.expiresAt;
    await media.put(key, token, 'image/png', stream(PNG));

    const second = await grant();
    now = second.g.expiresAt + 1;
    expect(
      (await refusal(media.put(second.key, second.token, 'image/png', stream(PNG)))).kind,
    ).toBe('token');
  });

  it('ignores content type parameters and case in the header', async () => {
    const { key, token } = await grant();
    await media.put(key, token, 'Image/PNG; charset=binary', stream(PNG));
  });

  it('reports the kind of each refusal', async () => {
    const { key, token } = await grant();
    expect((await refusal(media.put('media/../x.png', token, 'image/png', stream(PNG)))).kind).toBe(
      'key',
    );
    expect((await refusal(media.put('etc/passwd', token, 'image/png', stream(PNG)))).kind).toBe(
      'key',
    );
    expect((await refusal(media.put(key, 'nope', 'image/png', stream(PNG)))).kind).toBe('token');
    expect((await refusal(media.put(key, token, 'image/jpeg', stream(PNG)))).kind).toBe('token');
    expect(
      (
        await refusal(
          media.put(key, token, 'image/png', stream(Buffer.from('not an image at all'))),
        )
      ).kind,
    ).toBe('type');
    expect(
      (
        await refusal(
          media.put(
            key,
            token,
            'image/png',
            stream(Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)])),
          ),
        )
      ).kind,
    ).toBe('size');
  });

  it('lets exactly one of several concurrent uploads with one grant win', async () => {
    const { key, token } = await grant();
    const bodies = Array.from({ length: 8 }, (_, i) => Buffer.concat([PNG, Buffer.alloc(16, i)]));
    const results = await Promise.allSettled(
      overlappingStreams(bodies).map((body) => media.put(key, token, 'image/png', body)),
    );
    const winners = results.flatMap((r, i) => (r.status === 'fulfilled' ? [i] : []));
    expect(winners).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected') {
        expect(r.reason).toBeInstanceOf(MediaError);
        expect((r.reason as MediaError).kind).toBe('token');
      }
    }
    expect(await readFile(join(dir, key))).toEqual(bodies[winners[0] ?? 0]);
    expect(await readdir(join(dir, 'media', key.split('/')[1] ?? ''))).toEqual([key.split('/')[2]]);
  });

  it('rejects a token signed with another secret', async () => {
    const { key, token } = await grant();
    const other = new LocalMedia({
      dataDir: dir,
      secret: `${SECRET}x`,
      clock: { now: () => now },
      ids: createIds(),
    });
    expect((await refusal(other.put(key, token, 'image/png', stream(PNG)))).kind).toBe('token');
  });

  it('leaves nothing behind after a refusal', async () => {
    const { key, token } = await grant();
    await refusal(media.put(key, token, 'image/png', stream(Buffer.from('nope, not an image'))));
    const files: string[] = [];
    for (const slug of await readdir(join(dir, 'media')).catch(() => [])) {
      files.push(...(await readdir(join(dir, 'media', slug))));
    }
    expect(files).toEqual([]);
  });
});
