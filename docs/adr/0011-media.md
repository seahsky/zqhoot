# ADR-0011: Quiz media

Status: accepted (2026-09-29)

## Decision

Port:

```ts
interface MediaStorage {
  createUpload(hostId: string, req: UploadRequest): Promise<UploadGrant>;
  /** VM only: store bytes for a key previously granted to this host. */
  put?(
    hostId: string,
    key: string,
    contentType: string,
    body: ReadableStream | Buffer,
  ): Promise<void>;
}
```

- Keys: `media/{hostSlug}/{nanoid}.{ext}`. `hostSlug` is a URL-safe hash of `hostId`, so keys don't expose Cognito subs. The extension is derived from the declared content type.
- Allowed types: PNG, JPEG, WebP, GIF. At most 5 MB. **SVG is never accepted**, because it can carry script.

### AWS

- `POST /api/media/uploads` → S3 presigned POST (`@aws-sdk/s3-presigned-post`) valid 5 minutes. Conditions: exact `key`, `Content-Type` equal to the declared type, and `content-length-range` 1..5 MB. S3 enforces the size and the browser uploads directly, so bytes never pass through Lambda.
- Media bucket: private, Block Public Access on, SSE-S3 (not KMS: no key fee), CORS allowing `POST` from the site origin only. It is served through CloudFront at `/media/*` via Origin Access Control, with long cache TTLs; keys are immutable.
- Deleting a quiz does not delete its images in v1. A lifecycle rule can expire orphans; that is a follow-up.

### VM

- `POST /api/media/uploads` → `{method:'PUT', url:'/api/media/{key}', headers:{'Content-Type':…}}` with a short-lived signed token in the query string.
- `PUT` streams to `${ZQ_DATA_DIR}/media/…` (temp file then rename). It enforces the byte limit while streaming and checks magic bytes match the declared type.
- `GET /media/*` is served by Node with `Cache-Control: public, max-age=31536000, immutable` and `X-Content-Type-Options: nosniff`.
- An S3-compatible backend (e.g. self-hosted MinIO) can reuse the AWS implementation with `ZQ_S3_ENDPOINT` + `forcePathStyle`. It is optional and not exercised in CI.

## Consequences

- Image EXIF metadata is not stripped in v1. Hosts should not upload photos with sensitive location data; this is documented.
