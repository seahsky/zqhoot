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
- **CORS is answered by the function, not by API Gateway.** Every call is cross-origin, and the
  function (`packages/service` `http-app.ts`, configured by `apps/server-lambda`) allows exactly
  `ZQ_SITE_ORIGIN` plus the optional comma-separated `ZQ_CORS_EXTRA_ORIGINS`: methods `GET`, `POST`,
  `PUT`, `DELETE`, `OPTIONS`; request headers `authorization`, `content-type`; exposed headers
  `content-disposition`, `retry-after`, `x-request-id`; preflight cached for `86400` s; no
  credentials (bearer tokens in a header, no cookies). Any other origin gets no CORS header.

  The API therefore has **no `cors_configuration`**. With one, API Gateway would answer preflights
  itself without invoking the function and discard the CORS headers the function returns, so the two
  would disagree. Without one, `ANY /api/{proxy+}` sends `OPTIONS` requests to the function (every
  path the app serves has a segment after `/api/`, so the one route covers them all) and its
  headers reach the browser unchanged. A request that matches no route, such as `/other`, gets
  API Gateway's own 404 without CORS headers. The default `execute-api` endpoint stays enabled
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
| `ZQ_CORS_EXTRA_ORIGINS` (optional, comma-separated `https://host` origins) | `var.environment`, not set by the env |

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

`api_endpoint` (`https://{id}.execute-api.{region}.amazonaws.com`, no trailing slash: the web app's
`apiBaseUrl` and the exact origin in the site's CSP `connect-src`, since the stage is `$default` and
needs no path segment), `function_name`, `function_arn`, `environment` (the complete Lambda
environment, so the calling environment's tests can check its wiring).

## Notes

The Lambda environment needs the site URL (the CloudFront domain), but the API resource does not: it
has no CORS configuration, and the integration, routes and permission are what point at the
function. So the function never feeds back into the API, and the distribution can take
`api_endpoint` as an input and name the API's exact host in its CSP `connect-src`
([static-site](../static-site/README.md)). That is the reason CORS lives in the function.

Not verified without an AWS account: a preflight against a deployed API. That an API without
`cors_configuration` sends `OPTIONS` requests matching `ANY /api/{proxy+}` to the integration and
returns the function's CORS headers unchanged is from the API Gateway documentation. The function's
side is tested end to end through the Hono Lambda adapter with an API Gateway v2 `OPTIONS` event
(`apps/server-lambda/test/http-handler.test.ts`).
