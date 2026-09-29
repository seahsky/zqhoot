# data

The state store and the media bucket ([ADR-0003](../../../../docs/adr/0003-state-model-and-dynamodb.md),
[ADR-0011](../../../../docs/adr/0011-media.md)).

## Resources

- **DynamoDB table** named `var.name`: on-demand (`PAY_PER_REQUEST`), keys `pk` and `sk` (both
  strings), global secondary index `gsi1` on `gsi1pk` and `gsi1sk` (strings, projection `ALL`), TTL on
  `expiresAt`. It must match `tableDefinition()` in `packages/store/src/dynamo-schema.ts`; the
  module test asserts each of those facts. Encryption is the AWS-owned key (no
  `server_side_encryption` block): a customer-managed KMS key would add a fixed monthly fee
  ([ADR-0012](../../../../docs/adr/0012-cost-model.md)).
- **Media bucket** `{name}-media-{suffix}`: Block Public Access fully on, SSE-S3 (`AES256`),
  `BucketOwnerEnforced`, CORS allowing `POST` from `var.site_origins` only, and a lifecycle rule
  that aborts incomplete multipart uploads after 1 day. The bucket policy that lets CloudFront read
  `media/*` is attached by the `static-site` module.

## Inputs

| Name                     | Type         | Default  | Description                                                                         |
| ------------------------ | ------------ | -------- | ----------------------------------------------------------------------------------- |
| `name`                   | string       | required | Table name and bucket-name prefix; 2-20 characters of `a-z`, `0-9`, `-`.            |
| `site_origins`           | list(string) | required | Origins (no path, no trailing slash) allowed to POST uploads.                       |
| `point_in_time_recovery` | bool         | `false`  | DynamoDB point-in-time recovery.                                                    |
| `deletion_protection`    | bool         | `false`  | DynamoDB deletion protection.                                                       |
| `force_destroy`          | bool         | `false`  | Let Terraform delete the media bucket while it still holds objects.                 |

## Outputs

`table_name`, `table_arn`, `gsi_arn`, `media_bucket_name`, `media_bucket_arn`,
`media_bucket_regional_domain_name`.

## Notes

- The CORS rule is its own resource so `site_origins` can be the CloudFront domain, which itself
  points at this bucket, without a dependency cycle.
- `media_bucket_name` waits for the public access block and ownership controls, because S3 aborts a
  bucket policy write that races with them.
