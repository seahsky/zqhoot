# http-api

The `http` Lambda function behind an API Gateway HTTP API. CloudFront serves it same-origin under
`/api/*` ([ADR-0002](../../../../docs/adr/0002-realtime-transport.md)).

## Resources

- **Lambda `{name}-http`**: `nodejs24.x`, `arm64`, handler `index.handler`, 512 MB, 10 s, code from
  `var.lambda_zip`. `source_code_hash` is `null` while the zip does not exist, so `validate` works on
  a clean checkout; `plan` then stops on a `precondition` that says how to build the package.
- **Log group** `/aws/lambda/{name}-http`, created explicitly with `log_retention_days` (default 14).
- **IAM role**, least privilege ([ADR-0013](../../../../docs/adr/0013-security.md)):
  DynamoDB item actions on the table and on the `gsi1` index; `s3:PutObject` on
  `{media bucket}/media/*`; `lambda:InvokeFunction` on the ws function only (warm-up, ADR-0010); log
  streams of its own log group. No wildcard actions.
- **HTTP API** with a Lambda proxy integration (payload format 2.0), routes `ANY /api/{proxy+}` and
  `GET /api/health`, stage `$default` with auto-deploy and default route throttling (burst 400,
  rate 200). No CORS (same origin through CloudFront) and no authorizer (the function verifies
  Cognito ID tokens itself, ADR-0009). A Lambda permission admits this API only.

## Environment

The function receives `var.environment` merged with what the module wires itself. Wired values win;
`ZQ_LOG_LEVEL` and `NODE_OPTIONS` are defaults that `var.environment` may override.

| Variable                                                                           | Source                          |
| ---------------------------------------------------------------------------------- | ------------------------------- |
| `ZQ_TARGET` = `aws`                                                                | module                          |
| `ZQ_TABLE_NAME`, `ZQ_MEDIA_BUCKET`, `ZQ_WS_FUNCTION_NAME`, `ZQ_WARM_CONCURRENCY`   | module inputs                   |
| `ZQ_LOG_LEVEL` = `info`, `NODE_OPTIONS` = `--enable-source-maps`                   | module defaults                 |
| `ZQ_SITE_ORIGIN`, `ZQ_COGNITO_USER_POOL_ID`, `ZQ_COGNITO_CLIENT_ID`, `ZQ_SESSION_TTL_DAYS` | `var.environment` (the env)  |

## Inputs

| Name                                         | Type        | Default  | Description                                       |
| -------------------------------------------- | ----------- | -------- | ------------------------------------------------- |
| `name`                                       | string      | required | Function and API are named `{name}-http`.         |
| `lambda_zip`                                 | string      | required | Path to the deployment package.                   |
| `table_name`, `table_arn`, `gsi_arn`         | string      | required | The DynamoDB table and its `gsi1` index.          |
| `media_bucket_name`, `media_bucket_arn`      | string      | required | The media bucket.                                 |
| `ws_function_name`, `ws_function_arn`        | string      | required | The ws function, invoked for warm-up.             |
| `environment`                                | map(string) | `{}`     | Extra environment variables.                      |
| `memory_size`, `timeout`                     | number      | 512, 10  | Function memory (MB) and timeout (s).             |
| `log_retention_days`                         | number      | 14       | Log group retention.                              |
| `warm_concurrency`                           | number      | 4        | Warm-up fan-out.                                  |
| `throttle_burst_limit`, `throttle_rate_limit` | number     | 400, 200 | Stage default route throttling.                   |

## Outputs

`api_endpoint` (`https://...`), `api_domain` (host without scheme, for the CloudFront origin),
`function_name`, `function_arn`, `environment` (the complete Lambda environment, so the calling
environment's tests can check its wiring).

## Notes

The Lambda environment needs the CloudFront domain, and CloudFront needs `api_domain`. The API
resource depends on nothing in this module, so the loop is broken there: the integration, routes
and permission are what point at the function.
