# realtime-ws

The `ws` Lambda function behind an API Gateway WebSocket API
([ADR-0002](../../../../docs/adr/0002-realtime-transport.md)). Browsers connect to it directly, not
through CloudFront.

## Resources

- **Lambda `{name}-ws`**: `nodejs24.x`, `arm64`, handler `index.handler`, 512 MB, 30 s, code from
  `var.lambda_zip`, with the same missing-zip `precondition` as the http function.
- **Log group** `/aws/lambda/{name}-ws` with explicit retention.
- **IAM role**, least privilege ([ADR-0013](../../../../docs/adr/0013-security.md)): DynamoDB item
  actions on the table; `execute-api:ManageConnections` on
  `{api arn}/{stage}/POST/@connections/*` and `.../DELETE/@connections/*` (the connection ID is
  only known at runtime); log streams of its own log group.
- **WebSocket API** `{name}-ws` with `route_selection_expression = "$request.body.type"`, routes
  `$connect`, `$disconnect` and `$default`, all `AWS_PROXY` to the function.
- **Stage** `var.stage_name` (default `live`) with auto-deploy and default route throttling (burst
  1000, rate 2000). Access logging is off by default. With `enable_access_logs` it writes JSON
  lines without the client IP or query string (ADR-0009); API Gateway then also needs the
  account-level CloudWatch Logs role, which this module does not manage.

## Environment

| Variable                                                              | Source                         |
| --------------------------------------------------------------------- | ------------------------------ |
| `ZQ_TARGET` = `aws`, `ZQ_TABLE_NAME`                                   | module                         |
| `ZQ_WS_CALLBACK_URL` = `https://{api id}.execute-api.{region}.amazonaws.com/{stage}` | module          |
| `ZQ_LOG_LEVEL` = `info`, `NODE_OPTIONS` = `--enable-source-maps`      | module defaults (overridable)  |
| `ZQ_SITE_ORIGIN`, `ZQ_COGNITO_USER_POOL_ID`, `ZQ_COGNITO_CLIENT_ID`, `ZQ_SESSION_TTL_DAYS` | `var.environment` |

## Inputs

| Name                                          | Type        | Default    | Description                                      |
| --------------------------------------------- | ----------- | ---------- | ------------------------------------------------ |
| `name`                                        | string      | required   | Function and API are named `{name}-ws`.          |
| `lambda_zip`                                  | string      | required   | Path to the deployment package.                  |
| `table_name`, `table_arn`                     | string      | required   | The DynamoDB table.                              |
| `environment`                                 | map(string) | `{}`       | Extra environment variables.                     |
| `stage_name`                                  | string      | `"live"`   | Stage; first path segment of the `wss://` URL.   |
| `memory_size`, `timeout`                      | number      | 512, 30    | Function memory (MB) and timeout (s).            |
| `log_retention_days`                          | number      | 14         | Log group retention.                             |
| `throttle_burst_limit`, `throttle_rate_limit` | number      | 1000, 2000 | Stage default route throttling.                  |
| `enable_access_logs`                          | bool        | `false`    | API Gateway access logs.                         |

## Outputs

`wss_url`, `callback_url`, `api_id`, `stage_name`, `function_name`, `function_arn`, `environment`
(the complete Lambda environment, so the calling environment's tests can check its wiring).

## Notes

`callback_url` and the IAM resources are built from the API ID and the stage variable, not from the
stage resource, so the function (which the routes point at) never depends on the stage. The stage
is created after the routes so its first automatic deployment contains them. WebSocket
`auto_deploy` is unverified against a real account.
