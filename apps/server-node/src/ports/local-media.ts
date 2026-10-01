import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { link, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import type { TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { IMAGE_CONTENT_TYPES, LIMITS, MediaKey } from '@zqhoot/protocol';
import type { ImageContentType, UploadGrant, UploadRequest } from '@zqhoot/protocol';
import { MediaError } from '@zqhoot/service';
import type { Clock, HostIdentity, Ids, MediaStorage } from '@zqhoot/service';

/** How long an upload grant is valid (ADR-0011). */
export const UPLOAD_TTL_MS = 5 * 60_000;

const EXTENSIONS: Record<ImageContentType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** Longest signature checked: RIFF + size + WEBP. */
const MAGIC_BYTES = 12;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const MAGIC: Record<ImageContentType, (head: Buffer) => boolean> = {
  'image/png': (b) => b.length >= 8 && b.subarray(0, 8).equals(PNG_SIGNATURE),
  'image/jpeg': (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) =>
    b.length >= 12 &&
    b.toString('latin1', 0, 4) === 'RIFF' &&
    b.toString('latin1', 8, 12) === 'WEBP',
  'image/gif': (b) => {
    const signature = b.toString('latin1', 0, 6);
    return b.length >= 6 && (signature === 'GIF87a' || signature === 'GIF89a');
  },
};

export const mediaExtension = (type: ImageContentType): string => EXTENSIONS[type];

const isImageType = (value: string): value is ImageContentType =>
  (IMAGE_CONTENT_TYPES as readonly string[]).includes(value);

/** `image/png; charset=x` -> `image/png`. */
const mediaType = (header: string): string => (header.split(';')[0] ?? '').trim().toLowerCase();

export interface LocalMediaOptions {
  dataDir: string;
  /** `ZQ_JWT_SECRET`, the HMAC key of the upload tokens. */
  secret: string;
  clock: Clock;
  ids: Ids;
}

/**
 * Media on local disk (ADR-0011): `createUpload` signs a short-lived PUT grant, `put` receives the
 * bytes. Files live at `{dataDir}/{key}`, so the `/media/*` URL and the disk path share one shape.
 */
export class LocalMedia implements MediaStorage {
  readonly #secret: string;
  readonly #clock: Clock;
  readonly #ids: Ids;
  readonly #mediaRoot: string;
  readonly #dataDir: string;

  constructor(opts: LocalMediaOptions) {
    this.#secret = opts.secret;
    this.#clock = opts.clock;
    this.#ids = opts.ids;
    this.#dataDir = resolve(opts.dataDir);
    this.#mediaRoot = join(this.#dataDir, 'media');
  }

  async createUpload(host: HostIdentity, req: UploadRequest, now: number): Promise<UploadGrant> {
    // A hash, so the key does not expose the host id; stable, so one host's files share a folder.
    const slug = createHash('sha256').update(host.hostId).digest('base64url').slice(0, 22);
    const key = `media/${slug}/${this.#ids.mediaId()}.${EXTENSIONS[req.contentType]}`;
    const expiresAt = now + UPLOAD_TTL_MS;
    const token = this.#sign(key, req.contentType, expiresAt);
    return {
      key,
      upload: {
        method: 'PUT',
        // The key already starts with `media/`, so the route is `/api/media/media/...`.
        url: `/api/media/${key}?t=${encodeURIComponent(token)}`,
        headers: { 'Content-Type': req.contentType },
      },
      expiresAt,
    };
  }

  async put(
    key: string,
    token: string,
    contentType: string,
    body: ReadableStream<Uint8Array>,
  ): Promise<void> {
    if (!MediaKey.safeParse(key).success) throw new MediaError('key', 'invalid media key');
    const type = mediaType(contentType);
    // Token first: an unauthorised caller learns nothing about which types or keys are acceptable.
    this.#verify(key, type, token);
    if (!isImageType(type) || !key.endsWith(`.${EXTENSIONS[type]}`)) {
      throw new MediaError('type', 'unsupported content type for this upload');
    }

    const target = this.#resolveInside(key);
    if (await exists(target)) throw new MediaError('token', 'this upload grant was already used');
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await pipeline(
        Readable.fromWeb(body as unknown as NodeReadableStream<Uint8Array>),
        new ImageInspector(type, LIMITS.imageMaxBytes),
        createWriteStream(temp, { flags: 'wx', mode: 0o644, flush: true }),
      );
      await publish(temp, target);
    } finally {
      // After a successful `publish` this only drops the second name of the finished file.
      await rm(temp, { force: true });
    }
  }

  /** Absolute path of `key`, guaranteed to be inside `{dataDir}/media`. */
  #resolveInside(key: string): string {
    const path = resolve(this.#dataDir, key);
    const rel = relative(this.#mediaRoot, path);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new MediaError('key', 'invalid media key');
    }
    return path;
  }

  #mac(key: string, type: string, expiresAt: number): string {
    return createHmac('sha256', this.#secret)
      .update(`zqhoot-media-upload\n${key}\n${type}\n${expiresAt}`)
      .digest()
      .subarray(0, 16)
      .toString('base64url');
  }

  #sign(key: string, type: string, expiresAt: number): string {
    return `${expiresAt}.${this.#mac(key, type, expiresAt)}`;
  }

  #verify(key: string, type: string, token: string): void {
    const match = /^(\d{1,15})\.([A-Za-z0-9_-]{22})$/.exec(token);
    if (match === null) throw new MediaError('token', 'invalid upload token');
    const expiresAt = Number(match[1]);
    const expected = Buffer.from(this.#mac(key, type, expiresAt));
    const given = Buffer.from(match[2] ?? '');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new MediaError('token', 'invalid upload token');
    }
    if (this.#clock.now() > expiresAt) throw new MediaError('token', 'upload token expired');
  }
}

/**
 * Objects are immutable (`/media/*` is served as such), so a key is never replaced. `rename` would
 * overwrite silently when two PUTs with one grant race; `link` fails with EEXIST for the loser and
 * still publishes the finished file atomically, which an exclusive copy would not.
 */
async function publish(temp: string, target: string): Promise<void> {
  try {
    await link(temp, target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new MediaError('token', 'this upload grant was already used');
    }
    throw err;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** Passes bytes through while counting them and checking the file signature before the first write. */
class ImageInspector extends Transform {
  readonly #type: ImageContentType;
  readonly #maxBytes: number;
  #total = 0;
  #head: Buffer[] = [];
  #headLength = 0;
  #verified = false;

  constructor(type: ImageContentType, maxBytes: number) {
    super();
    this.#type = type;
    this.#maxBytes = maxBytes;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.#total += chunk.length;
    if (this.#total > this.#maxBytes) {
      done(new MediaError('size', 'upload is too large'));
      return;
    }
    if (this.#verified) {
      done(null, chunk);
      return;
    }
    this.#head.push(chunk);
    this.#headLength += chunk.length;
    if (this.#headLength < MAGIC_BYTES) {
      done();
      return;
    }
    this.#release(done);
  }

  override _flush(done: TransformCallback): void {
    // A short upload never reached MAGIC_BYTES; the signature checks fail it unless it is complete.
    if (this.#verified) done();
    else this.#release(done);
  }

  #release(done: TransformCallback): void {
    const head = Buffer.concat(this.#head);
    this.#head = [];
    if (!MAGIC[this.#type](head)) {
      done(new MediaError('type', 'file content does not match its declared type'));
      return;
    }
    this.#verified = true;
    done(null, head);
  }
}
