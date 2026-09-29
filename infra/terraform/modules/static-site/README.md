# static-site

A private S3 bucket for the web app, and the CloudFront distribution that serves the site, the API
and the media ([ADR-0002](../../../../docs/adr/0002-realtime-transport.md),
[ADR-0011](../../../../docs/adr/0011-media.md), [ADR-0013](../../../../docs/adr/0013-security.md)).

## Resources

- **Site bucket** `{name}-site-{suffix}`: Block Public Access fully on, SSE-S3, `BucketOwnerEnforced`.
- **One origin access control** (SigV4, always) shared by both S3 origins.
- **CloudFront distribution** (IPv6 on, HTTP/2 and HTTP/3, `PriceClass_100` by default):

  | Path       | Origin                                   | Cache policy           | Other                                                          |
  | ---------- | ---------------------------------------- | ---------------------- | -------------------------------------------------------------- |
  | default    | site bucket                              | `Managed-CachingOptimized` | viewer-request function serving `/index.html` for extension-less paths (SPA routes) |
  | `/api/*`   | HTTP API, custom origin, https-only, TLSv1.2 | `Managed-CachingDisabled` | `Managed-AllViewerExceptHostHeader`, all seven methods        |
  | `/media/*` | media bucket                             | `Managed-CachingOptimized` | keys are immutable                                             |

  The managed policies are looked up by name. The WebSocket API is not behind CloudFront.

- **Response headers policy** on every behaviour: the CSP from ADR-0013 built from `ws_url`,
  `cognito_domain` and the media bucket's regional endpoint (`default-src 'self'; connect-src 'self'
  {ws_url} {cognito_domain} {media_upload_origin}; img-src 'self' data: blob:; style-src 'self'
  'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' {cognito_domain}
  {media_upload_origin}`), HSTS for one year, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, and
  `Permissions-Policy: camera=(), microphone=(), geolocation=()` as a custom header.
- **Media uploads bypass CloudFront.** ADR-0011 uploads by S3 presigned POST: the browser sends the
  file straight to the media bucket, at `https://{bucket}.s3.{region}.amazonaws.com/`
  (`media_upload_origin`, derived from `media_bucket_regional_domain_name`). That origin is therefore
  in the CSP `connect-src` (fetch/XHR) and `form-action` (a form submit); ADR-0013 lists neither, and
  without them the browser blocks every upload. The server that presigns must produce a URL on
  exactly this host: use the AWS SDK's default virtual-hosted-style URL for the bucket's Region and
  do not set a custom S3 endpoint, path-style addressing or a dual-stack/FIPS endpoint. The data
  module's S3 CORS rule already allows `POST` from the site origin.
- **Bucket policies** on the site and media buckets: `s3:GetObject` for `cloudfront.amazonaws.com`
  with `AWS:SourceArn` equal to this distribution. On the media bucket that is `media/*` only.
- **Optional custom domain**: `aliases` and `acm_certificate_arn` (a certificate in `us-east-1`).
  With neither, the `*.cloudfront.net` name and default certificate are used. DNS is yours to create
  (no Route 53 zone: it would add a fixed fee).

## Inputs

| Name                                                                  | Type         | Default            | Description                                           |
| --------------------------------------------------------------------- | ------------ | ------------------ | ----------------------------------------------------- |
| `name`                                                                | string       | required           | Prefix of the bucket and CloudFront helper resources. |
| `api_domain`                                                          | string       | required           | HTTP API host name without scheme.                    |
| `media_bucket_id`, `media_bucket_arn`, `media_bucket_regional_domain_name` | string  | required           | The media bucket, served under `/media/*`; its regional endpoint is also the upload origin in the CSP. |
| `ws_url`                                                              | string       | required           | `wss://` URL for the CSP.                             |
| `cognito_domain`                                                      | string       | required           | Managed login base URL for the CSP.                   |
| `price_class`                                                         | string       | `"PriceClass_100"` | CloudFront price class.                               |
| `aliases`                                                             | list(string) | `[]`               | Custom domain names.                                  |
| `acm_certificate_arn`                                                 | string       | `null`             | Required when `aliases` is set.                       |
| `force_destroy`                                                       | bool         | `false`            | Let Terraform delete a non-empty site bucket.         |

## Outputs

`distribution_id`, `distribution_arn`, `distribution_domain_name`, `site_url` (no trailing slash:
the first alias, else the CloudFront domain), `site_bucket_name`, `site_bucket_arn`,
`media_upload_origin` (`https://{media bucket regional domain name}`, where presigned POST uploads must go).

## Notes

The bucket policies live here, not next to the buckets, because they need the distribution ARN.
The site bucket has no `s3:ListBucket` grant, so a missing object answers 403 rather than 404;
the viewer-request function makes that irrelevant for SPA routes.
