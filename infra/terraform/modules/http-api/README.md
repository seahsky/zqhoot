# http-api

The `http` Lambda function behind an API Gateway HTTP API. The browser calls the API **directly** at
its `execute-api` endpoint, cross-origin, not through CloudFront
([ADR-0002](../../../../docs/adr/0002-realtime-transport.md)): API Gateway then reports the player's
own address as `requestContext.http.sourceIp`, which the per-IP rate limits need
([ADR-0013](../../../../docs/adr/0013-security.md)). CloudFront only serves the static site and
`/media/*`.

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
  rate 200). No authorizer (the function verifies Cognito ID tokens itself, ADR-0009). A Lambda
  permission admits this API only.
- **CORS** (`cors_configuration` on the API), because every call is cross-origin:

  | Setting             | Value                                                    |
  | ------------------- | -------------------------------------------------------- |
  | `allow_origins`     | `var.allowed_origins`: exact site origins, never `*`     |
  | `allow_methods`     | `GET`, `POST`, `PUT`, `DELETE`, `OPTIONS`                |
  | `allow_headers`     | `authorization`, `content-type`                          |
  | `expose_headers`    | `content-disposition` (file name of the results CSV)     |
  | `max_age`           | `86400`, the most API Gateway accepts                    |
  | `allow_credentials` | `false`: bearer tokens in a header, no cookies           |

  With CORS configured, API Gateway answers preflight `OPTIONS` requests itself, so the module
  declares no `OPTIONS` route. API Gateway also discards CORS headers that the function returns, so
  the function must not set its own. The default `execute-api` endpoint stays enabled
  (`disable_execute_api_endpoint = false`): it is the only way in.

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
| `allowed_origins`                            | list(string) | required | CORS `allow_origins`: exact origins (`https://host`), no wildcard, no trailing slash. |
| `environment`                                | map(string) | `{}`     | Extra environment variables.                      |
| `memory_size`, `timeout`                     | number      | 512, 10  | Function memory (MB) and timeout (s).             |
| `log_retention_days`                         | number      | 14       | Log group retention.                              |
| `warm_concurrency`                           | number      | 4        | Warm-up fan-out.                                  |
| `throttle_burst_limit`, `throttle_rate_limit` | number     | 400, 200 | Stage default route throttling.                   |

## Outputs

`api_endpoint` (`https://{id}.execute-api.{region}.amazonaws.com`, no trailing slash: the web app's
`apiBaseUrl`, since the stage is `$default` and needs no path segment), `allowed_origins` (read back
from the API's CORS configuration), `function_name`, `function_arn`, `environment` (the complete
Lambda environment, so the calling environment's tests can check its wiring).

## Notes

The Lambda environment and the CORS allow-list both need the site URL (the CloudFront domain). The
API resource depends on nothing else in this module, so the function never feeds back into it: the
integration, routes and permission are what point at the function. Because the API's CORS list
depends on the distribution, the distribution cannot take the API's host as an input (its CSP
`connect-src` uses a Region-wide `execute-api` wildcard instead, see
[static-site](../static-site/README.md)).

Not verified without an AWS account: a preflight against a deployed API. The argument names were
read from the provider schema (`terraform providers schema -json`), and the claim that API Gateway
answers preflight itself (including for an `ANY` route) is from the API Gateway documentation.
