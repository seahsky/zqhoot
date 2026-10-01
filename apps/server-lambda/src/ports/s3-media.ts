import { createHash } from 'node:crypto';
import type { S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import type { ImageContentType, UploadGrant, UploadRequest } from '@zqhoot/protocol';
import { LIMITS } from '@zqhoot/protocol';
import type { HostIdentity, Ids, MediaStorage } from '@zqhoot/service';

export const UPLOAD_EXPIRY_SECONDS = 300;

/** Extensions must match the protocol's `MediaKey` pattern, which says `jpg`. */
const EXTENSIONS: Record<ImageContentType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** Keys carry a hash instead of the Cognito `sub` (ADR-0011). */
export const hostSlug = (hostId: string): string =>
  createHash('sha256').update(hostId).digest('base64url').slice(0, 16);

/** ADR-0011: S3 enforces size and type, so bytes never pass through Lambda and there is no `put`. */
export class S3Media implements MediaStorage {
  readonly #client: S3Client;
  readonly #bucket: string;
  readonly #ids: Ids;

  constructor(opts: { client: S3Client; bucket: string; ids: Ids }) {
    this.#client = opts.client;
    this.#bucket = opts.bucket;
    this.#ids = opts.ids;
  }

  async createUpload(host: HostIdentity, req: UploadRequest, now: number): Promise<UploadGrant> {
    const key = `media/${hostSlug(host.hostId)}/${this.#ids.mediaId()}.${EXTENSIONS[req.contentType]}`;
    const { url, fields } = await createPresignedPost(this.#client, {
      Bucket: this.#bucket,
      Key: key,
      Conditions: [
        ['content-length-range', 1, LIMITS.imageMaxBytes],
        { 'Content-Type': req.contentType },
        { key },
      ],
      Fields: { 'Content-Type': req.contentType },
      Expires: UPLOAD_EXPIRY_SECONDS,
    });
    return {
      key: key as UploadGrant['key'],
      upload: { method: 'POST', url, fields },
      expiresAt: now + UPLOAD_EXPIRY_SECONDS * 1000,
    };
  }
}
