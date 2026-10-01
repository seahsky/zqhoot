# W1-infra: Terraform modules, environments, deploy scripts

Owner: Sonnet implementation agent. Reviewer: independent Opus agent.

## Goal

All AWS infrastructure as Terraform: reusable modules plus two root configurations, `infra/terraform/envs/aws-serverless` and `infra/terraform/envs/aws-vm`, and the operator scripts to deploy, preflight-check and tear down. Nothing is applied in this environment: `terraform plan`/`apply` against a real account is the owner's call. Your verification is `terraform fmt`, `terraform validate` and `tflint`.

Read first: `docs/ARCHITECTURE.md`, and ADRs 0002, 0003, 0009, 0010, 0011, 0012, 0013 and 0015 in `docs/adr/`.

## Files you own

- `infra/terraform/**`
- `scripts/aws-preflight.sh`, `scripts/deploy-aws.sh`, `scripts/destroy-aws.sh`, `scripts/vm-put-secrets.sh`
- `.gitignore`: you may append Terraform-specific lines.

## Tooling in this environment (important)

- Terraform 1.16.4 and tflint 0.64.0 are on `PATH`. The AWS ruleset plugin (0.49.0) is installed at `~/.tflint.d/plugins/tflint-ruleset-aws`.
- `registry.terraform.io` is **blocked**. `/root/.terraformrc` points `terraform init` at a local provider mirror containing `hashicorp/aws 6.66.0`, `hashicorp/archive 2.8.1` and `hashicorp/random 3.9.1` (linux_amd64). Use only these providers, with version constraints that include those versions (e.g. `~> 6.66`, `~> 2.8`, `~> 3.9`).
- Run `terraform init -backend=false` for validation.
- **Do not commit** `.terraform/` or `.terraform.lock.hcl`: a lock file generated from a single-platform mirror would break `init` on other platforms. Gitignore both and document in the README that operators run `terraform init` (which creates the lock) on first use.
- `infra/terraform/.tflint.hcl`: enable `plugin "aws" { enabled = true }` without `source`/`version`, so the local plugin is used. Add a commented-out block showing `source`/`version` for normal environments. Also enable `terraform_recommended` rules.
- No AWS credentials exist here. Nothing may require them for `validate`/`tflint`.

## Modules (`infra/terraform/modules/*`), each with `variables.tf`, `main.tf`, `outputs.tf`, `versions.tf`, `README.md`

1. **`data`**
   - DynamoDB table:
     - PAY_PER_REQUEST; `pk` (S) / `sk` (S); GSI `gsi1` on `gsi1pk`/`gsi1sk` (S), projection ALL. Must match `packages/store/src/dynamo-schema.ts` (see the W1-store task: `tableDefinition`).
     - TTL on `expiresAt`; point-in-time recovery a variable, default false; deletion protection a variable, default false.
     - SSE: AWS-owned key (the default). No customer-managed KMS keys anywhere: fixed monthly fee (ADR-0012).
   - Media bucket:
     - private, Block Public Access all on, SSE-S3, `BucketOwnerEnforced`.
     - CORS: `POST` from `var.site_origins` only.
     - lifecycle: abort incomplete multipart uploads after 1 day.
   - Outputs: table name/ARN, GSI ARN, media bucket name/ARN/regional domain name.
2. **`auth`**
   - Cognito user pool:
     - `user_pool_tier = "ESSENTIALS"` (variable); email as username; self sign-up disabled by default (variable `allow_self_signup`).
     - Password policy min 12 characters; MFA optional (variable); deletion protection variable.
   - Hosted domain with a prefix (`var.domain_prefix`, generated with `random_string` in the env if unset).
   - Public app client (no secret):
     - Authorization code grant only, PKCE, scopes `openid email profile`.
     - Callback and logout URLs from variables; `supported_identity_providers = ["COGNITO"]`.
     - Token validity: ID/access 1 h, refresh 30 d; `prevent_user_existence_errors = "ENABLED"`.
   - Optional initial admin user (`var.initial_admin_email`, nullable). Cognito sends the temporary password by email, so no password ever lands in Terraform state.
   - Outputs: pool ID/ARN, client ID, hosted domain URL (`https://{prefix}.auth.{region}.amazoncognito.com`), issuer URL.
3. **`http-api`**
   - Lambda `http`:
     - arm64, `nodejs24.x`, memory/timeout variables (512 MB / 10 s), handler `index.handler`, zip from `var.lambda_zip`.
     - Log group `/aws/lambda/{name}` created explicitly with retention (variable, default 14).
     - Environment from `var.environment` (map) merged with module-provided values.
   - IAM role, least privilege (ADR-0013):
     - DynamoDB item actions on the table + `/index/*`
     - `s3:PutObject` on `{media}/media/*`
     - `lambda:InvokeFunction` on `var.ws_function_arn` (warm-up)
     - logs on its own group
   - API Gateway HTTP API (`apigatewayv2`):
     - routes `ANY /api/{proxy+}` and `GET /api/health` → Lambda proxy integration, payload format 2.0.
     - stage `$default`, auto-deploy, `default_route_settings` throttling (burst 400, rate 200; variables).
     - No CORS, since it's served same-origin via CloudFront; no API Gateway authorizer, since JWTs are verified in the app (ADR-0009). Lambda permission for API Gateway.
   - Outputs: API endpoint (`https://…`), API domain (no scheme) for CloudFront, function name/ARN.
4. **`realtime-ws`**
   - Lambda `ws`: same shape as `http`, memory 512 MB, timeout 30 s.
   - IAM:
     - DynamoDB item actions on the table
     - `execute-api:ManageConnections` on `arn:aws:execute-api:{region}:{account}:{api_id}/{stage}/POST/@connections/*` and `.../DELETE/@connections/*`
     - logs
   - API Gateway WebSocket API:
     - `route_selection_expression = "$request.body.type"`
     - routes `$connect`, `$disconnect`, `$default` → AWS_PROXY integration to `ws`
     - stage `var.stage_name` (default `live`), auto-deploy, `default_route_settings` throttling (burst 1000, rate 2000; variables); access logging off by default
     - Lambda permission.
   - Output `callback_url` (`https://{api_id}.execute-api.{region}.amazonaws.com/{stage}`). The ws Lambda can also derive it from the event, but pass it as an env var for clarity.
   - Outputs: `wss://` URL, API ID, stage, function name/ARN.
5. **`static-site`**
   - Site bucket: private, Block Public Access, SSE-S3.
   - CloudFront distribution:
     - Origins:
       - site bucket (OAC, sigv4)
       - media bucket (OAC)
       - HTTP API (custom origin, `https-only`, TLSv1.2)
     - Behaviours:
       - default → site: managed `CachingOptimized`, viewer-request CloudFront Function (JS 2.0) rewriting extension-less paths to `/index.html` for SPA routes
       - `/api/*` → HTTP API: managed `CachingDisabled` + managed `AllViewerExceptHostHeader`, all methods
       - `/media/*` → media bucket: `CachingOptimized`
     - Response headers policy per ADR-0013: CSP built from variables (`ws_url`, `cognito_domain`), HSTS, nosniff, referrer-policy, frame-options DENY, and `Permissions-Policy` as a custom header.
     - `price_class` variable (default `PriceClass_100`); IPv6 on.
     - Optional custom domain: `aliases` + `acm_certificate_arn` variables, default none (CloudFront certificate).
   - Bucket policies allow `cloudfront.amazonaws.com` with `AWS:SourceArn` equal to the distribution only.
   - Outputs: distribution ID/domain, site URL, site bucket name.
6. **`vm`**
   - One EC2 instance: default `t4g.small`, arm64, Ubuntu 24.04 LTS AMI via `data "aws_ami"` (Canonical owner `099720109477`; name filter documented).
   - Encrypted gp3 root volume (variable size, default 20 GB); IMDSv2 required.
   - Security group: ingress 80/443 from `0.0.0.0/0` and `::/0`; SSH 22 only if `var.ssh_cidr` is set (default null).
   - Elastic IP.
   - Instance profile: `AmazonSSMManagedInstanceCore`, plus `ssm:GetParameter(s)ByPath`/`GetParameter` on `arn:aws:ssm:{region}:{account}:parameter/zqhoot/{name}/*`, plus `kms:Decrypt` scoped to the AWS-managed `alias/aws/ssm` key via the `kms:ViaService` condition.
   - `user_data` (templatefile):
     - install Docker Engine and the compose plugin from Ubuntu packages (`docker.io`, `docker-compose-v2`); verify the package names; if you can't, say so in the README
     - clone `var.repo_url` at `var.repo_ref` into `/opt/zqhoot`
     - wait for SSM parameters under `/zqhoot/{name}/` and write them to `/opt/zqhoot/deploy/vm/.env` (mode 600)
     - `docker compose -f deploy/vm/docker-compose.yml up -d --build`
     - install a systemd unit so it starts on boot
     - **No secrets in user_data.**
   - Outputs: public IP, instance ID, SSM parameter path.

## Environments

- **`envs/aws-serverless`**
  - Composes `data`, `auth`, `realtime-ws`, `http-api` and `static-site`.
  - Variables: `region` (default `us-east-1`), `name` (default `zqhoot`), `lambda_ws_zip` / `lambda_http_zip` (defaults `../../../../apps/server-lambda/dist/ws.zip` and `.../http.zip`), `warm_concurrency` (4), `session_ttl_days` (30), `log_retention_days` (14), custom domain variables (optional), `initial_admin_email` (optional).
  - Manages `config.json` in the site bucket as `aws_s3_object` with `Cache-Control: no-cache` and `content_type application/json`. Content is built with `jsonencode()` to match `RuntimeConfig` in `packages/protocol/src/config.ts`: `target "aws"`, `apiBaseUrl ""`, `wsUrl`, `mediaBaseUrl` = site URL + "/", `joinUrl` = site URL + "/join", `auth {mode "cognito", region, userPoolId, clientId, domain}`.
  - Outputs every value the deploy script needs: site bucket, distribution ID, site URL, ws URL, table name, Cognito IDs/domain.
  - `validate` must pass on a clean checkout where the zip files don't exist. Guard with `fileexists()`, so `source_code_hash` is null when the file is missing and `plan` fails with a clear precondition error instead (use a `lifecycle { precondition }` on the function).
  - `terraform.tfvars.example` and `backend.tf.example`: optional S3 remote state with `use_lockfile = true`, documented as optional.
- **`envs/aws-vm`**
  - Composes `vm`.
  - Variables: region, name, instance type, `repo_url`, `repo_ref`, `domain` (for Caddy), `ssh_cidr`.
  - Outputs: IP and next steps.
  - Same example files.

## Lambda environment contract (the wave 2 `server-lambda` build will read exactly these)

| Variable                  | ws  | http | Value                                                              |
| ------------------------- | --- | ---- | ------------------------------------------------------------------ |
| `ZQ_TARGET`               | ✓   | ✓    | `aws`                                                              |
| `ZQ_TABLE_NAME`           | ✓   | ✓    | table name                                                         |
| `ZQ_SITE_ORIGIN`          | ✓   | ✓    | `https://{cloudfront domain or custom domain}` (no trailing slash) |
| `ZQ_COGNITO_USER_POOL_ID` | ✓   | ✓    | pool ID                                                            |
| `ZQ_COGNITO_CLIENT_ID`    | ✓   | ✓    | client ID                                                          |
| `ZQ_SESSION_TTL_DAYS`     | ✓   | ✓    | number                                                             |
| `ZQ_WS_CALLBACK_URL`      | ✓   |      | `https://{api}.execute-api.{region}.amazonaws.com/{stage}`         |
| `ZQ_MEDIA_BUCKET`         |     | ✓    | media bucket name                                                  |
| `ZQ_WS_FUNCTION_NAME`     |     | ✓    | ws function name (warm-up)                                         |
| `ZQ_WARM_CONCURRENCY`     |     | ✓    | number                                                             |
| `ZQ_LOG_LEVEL`            | ✓   | ✓    | `info`                                                             |
| `NODE_OPTIONS`            | ✓   | ✓    | `--enable-source-maps`                                             |

Break dependency cycles (the Lambda environment needs the CloudFront domain, and CloudFront needs the API) at the resource level: `aws_apigatewayv2_api` has no dependency on the Lambda. Verify `terraform validate` has no cycle.

## Scripts (bash, `set -euo pipefail`, `--help` text, pass `bash -n`)

- **`scripts/aws-preflight.sh [region]`**
  - Checks `aws` CLI and credentials.
  - Reads `aws lambda get-account-settings` → `AccountLimit.ConcurrentExecutions`. If below 100, prints an error explaining the 400-player answer burst (research SUMMARY: new accounts may be limited to 10; 400 answers in 2 s needs ~20 at 50 ms, and a limit of 10 caps a function at ~100 req/s) and the exact Service Quotas command to request an increase: service code `lambda`, quota name "Concurrent executions". Look up the quota code with `aws service-quotas list-service-quotas --service-code lambda` rather than hard-coding it.
  - Also prints the API Gateway WebSocket connection-rate quota, found by name via `list-service-quotas --service-code apigateway`, if available.
  - Exit 1 if not 400-ready.
- **`scripts/deploy-aws.sh`**
  1. Runs preflight (skippable with `--skip-preflight`).
  2. `pnpm install --frozen-lockfile`, then `pnpm --filter @zqhoot/server-lambda build` (produces `apps/server-lambda/dist/ws.zip` and `dist/http.zip`: the wave 2 contract) and `pnpm --filter @zqhoot/web build` (produces `apps/web/dist`).
  3. `terraform -chdir=infra/terraform/envs/aws-serverless init && apply`.
  4. `aws s3 sync apps/web/dist s3://{bucket} --delete --exclude config.json`: `index.html` with `Cache-Control: no-cache`, hashed assets under `assets/` with `max-age=31536000, immutable`.
  5. CloudFront invalidation of `/index.html` and `/config.json`.
  6. Prints the site URL and next steps (create a host user).
- **`scripts/destroy-aws.sh`**: empties the site and media buckets (with a confirmation prompt, `--yes` to skip) then `terraform destroy`.
- **`scripts/vm-put-secrets.sh`**: reads a local `.env` file and writes each key to SSM Parameter Store as `SecureString` under `/zqhoot/{name}/{KEY}` (standard tier, AWS-managed key: no monthly fee).

## Documentation

- `infra/terraform/README.md` covers:
  - the layout and a module dependency diagram
  - prerequisites (Terraform ≥ 1.10 for S3 native locking; AWS CLI v2)
  - first-time `init` (and why no lock file is committed)
  - how to deploy and destroy each target
  - how to create a Cognito host user (`aws cognito-idp admin-create-user` example)
  - the cost notes from ADR-0012
  - optional remote state
  - what was verified here (`validate`/`tflint`) and what wasn't (`plan`/`apply`, the user_data package names on a real Ubuntu 24.04 image)

## Acceptance criteria

1. `terraform fmt -check -recursive infra/terraform` passes.
2. For every module and both envs: `terraform init -backend=false` and `terraform validate` pass. Provide `infra/terraform/validate.sh` that runs this across all directories plus tflint and exits non-zero on any failure.
3. `tflint --recursive --config "$(pwd)/infra/terraform/.tflint.hcl"`, run from `infra/terraform`, reports no errors or warnings. Any disabled rule must be justified in `.tflint.hcl` comments.
4. IAM policies match ADR-0013: no `"*"` actions; no `"*"` resources except where AWS requires them, each with a comment explaining why.
5. No always-on paid resources in `aws-serverless`: no NAT, VPC, provisioned concurrency, KMS CMK, Secrets Manager, WAF, API caching or Route 53 zone.
6. No secrets in Terraform variables, state or user_data for either env.
7. The scripts pass `bash -n`, `--help` works, and they do not run anything destructive without confirmation.
