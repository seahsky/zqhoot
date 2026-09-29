# zqhoot infrastructure (Terraform)

All AWS infrastructure for zqhoot as reusable modules plus two root configurations. The design
decisions are in [ARCHITECTURE.md](../../docs/ARCHITECTURE.md) and the ADRs, mainly
[0002](../../docs/adr/0002-realtime-transport.md), [0003](../../docs/adr/0003-state-model-and-dynamodb.md),
[0009](../../docs/adr/0009-auth-and-identity.md), [0010](../../docs/adr/0010-cold-starts.md),
[0011](../../docs/adr/0011-media.md), [0012](../../docs/adr/0012-cost-model.md),
[0013](../../docs/adr/0013-security.md) and [0015](../../docs/adr/0015-vm-deployment.md).

Nothing here has been applied to a real AWS account. See [What was verified](#what-was-verified).

## Layout

```
infra/terraform/
  .tflint.hcl             tflint config (terraform "recommended" preset + AWS ruleset)
  validate.sh             fmt + init/validate + offline tests + guard + tflint, no credentials needed
  modules/
    data/                 DynamoDB single table, private media bucket
    auth/                 Cognito user pool, hosted domain, public app client, optional first host
    http-api/             Lambda "http" + API Gateway HTTP API (serves /api/*)
    realtime-ws/          Lambda "ws" + API Gateway WebSocket API
    static-site/          Private site bucket + CloudFront (site, /api/*, /media/*)
    vm/                   One Ubuntu 24.04 EC2 instance running the Docker Compose stack
  envs/
    aws-serverless/       data + auth + realtime-ws + http-api + static-site, and config.json
    aws-vm/               vm
scripts/                  (repository root) aws-preflight.sh, deploy-aws.sh, destroy-aws.sh, vm-put-secrets.sh
```

Each module has `variables.tf`, `main.tf`, `outputs.tf`, `versions.tf` and its own README. Each
module and environment also has a `tests/` folder of offline `terraform test` files.

### How the serverless modules connect

```
                          ┌──────────────┐  table, gsi1 ARN        ┌────────────┐
                          │     data     │────────────────────────►│  http-api  │
                          │ table, media │  media bucket (put)     │ Lambda+API │
                          │   bucket     │──┐                      └─────┬──────┘
                          └──────▲───────┘  │ media bucket (origin,      │ api domain
                                 │          │ bucket policy)             │ (CloudFront origin)
        site origin (CORS)       │          ▼                            ▼
   ┌─────────────────────────────┴───────────────────────────────────────────────┐
   │                            static-site (CloudFront)                          │
   │   /* → site bucket   /api/* → http-api   /media/* → media bucket             │
   └───▲──────────────────────▲──────────────────────────┬──────────────────────┘
       │ wss URL (CSP)        │ Cognito domain (CSP)      │ site URL
┌──────┴───────┐       ┌──────┴───────┐                   ├──► auth: callback and logout URLs
│ realtime-ws  │       │     auth     │                   ├──► http-api, realtime-ws: ZQ_SITE_ORIGIN
│  Lambda+API  │◄──────│ pool, client │                   └──► env: config.json in the site bucket
└──────▲───────┘ pool  └──────────────┘
       │ ws function ARN/name (warm-up invoke, lambda:InvokeFunction)
       └──────────── http-api
```

The site URL feeds back into the Lambda environments and the Cognito client, while CloudFront
needs the API domain, the WebSocket URL and the Cognito domain. That is only acyclic because those
three values come from resources that do not depend on the site URL: `aws_apigatewayv2_api` does
not depend on its Lambda (the integration, routes and permission do), the WebSocket URL is built
from the API and the stage name, and the Cognito domain does not depend on the app client. The
media bucket's CORS rule and both bucket policies are separate resources for the same reason.
`terraform validate` fails on a cycle, and the environment test applies the whole composition
against a mock provider.

## Prerequisites

- Terraform 1.10 or later (1.10 introduced S3-native state locking, `use_lockfile`).
- AWS CLI v2 with credentials for the target account.
- For the serverless deploy: Node 22 and pnpm 10, to build the Lambda packages and the web app.
- Optional: [tflint](https://github.com/terraform-linters/tflint) for `validate.sh`.
- Providers: `hashicorp/aws ~> 6.66` and, for the serverless environment, `hashicorp/random ~> 3.9`.

## First-time init and the lock file

Run `terraform init` in the environment directory before anything else:

```bash
terraform -chdir=infra/terraform/envs/aws-serverless init
```

`init` writes `.terraform.lock.hcl` next to the configuration. It is git-ignored on purpose: a lock
file records provider checksums for the platforms it was generated on, and one created from a
single-platform provider mirror (as in the environment this was built in) would make `init` fail on
every other platform. If you want a lock file in version control for your own fork, generate it for
the platforms your team uses:

```bash
terraform -chdir=infra/terraform/envs/aws-serverless providers lock \
  -platform=linux_amd64 -platform=linux_arm64 -platform=darwin_arm64
```

## Deploy the serverless target

```bash
scripts/deploy-aws.sh                      # asks before terraform apply
scripts/deploy-aws.sh --auto-approve       # for automation
scripts/deploy-aws.sh --region eu-west-1   # also passes -var region=eu-west-1
```

The script:

1. runs `scripts/aws-preflight.sh` for the Region Terraform will use;
2. `pnpm install --frozen-lockfile`, then builds `apps/server-lambda` (which must produce
   `apps/server-lambda/dist/ws.zip` and `dist/http.zip`) and `apps/web` (`apps/web/dist`);
3. `terraform init` and `apply` in `envs/aws-serverless`;
4. syncs the web build to the site bucket, in an order that is safe during a live session: first
   the new hashed files under `assets/` (`Cache-Control: public, max-age=31536000, immutable`, and
   **without** `--delete`), then everything else (notably `index.html`, with `no-cache`, and with
   `--delete` for root files that left the build); `config.json` is excluded because Terraform
   owns it;
5. invalidates `/index.html` and `/config.json` on CloudFront;
6. prints the site URL and the next steps.

Old hashed assets are deliberately kept. A tab still running the previous build lazy-loads its old
route chunks, and a viewer served the previous `index.html` from an edge cache asks for the old
file names; if those were deleted the request fails with 403 (the site bucket has no
`s3:ListBucket`). Hashed names never collide, and they cost a few hundred KB per deploy, so nothing
prunes them automatically. To prune by hand, do it when no session is live (open tabs on an old
build lose their chunks) and well after a deploy:

```bash
aws s3 sync apps/web/dist/assets "s3://$(terraform -chdir=infra/terraform/envs/aws-serverless output -raw site_bucket_name)/assets" --delete
```

That removes everything under `assets/` that the current local build does not contain, so run it
from a checkout of the version that is deployed.

Optional inputs go in `envs/aws-serverless/terraform.tfvars` (see `terraform.tfvars.example`). The
useful ones: `initial_admin_email`, `custom_domain` with `acm_certificate_arn`,
`warm_concurrency`, `session_ttl_days`, `deletion_protection`.

The Lambda package variables default to where `pnpm --filter @zqhoot/server-lambda build` writes
them. If a package is missing, `terraform plan` stops with "Lambda package not found at ...
Build it first" (a `precondition` on the function); `terraform validate` works without them.

### Lambda concurrency: the preflight

New AWS accounts can have a Lambda "Concurrent executions" quota as low as 10. When the host opens
a question, up to 400 phones answer within about 2 seconds; at about 50 ms per answer that needs
roughly 20 concurrent executions, and a limit of 10 caps a function at about 100 requests per
second. `scripts/aws-preflight.sh` reads the quota, exits 1 below 100 and prints the Service
Quotas command to request an increase (it looks the quota code up by name, in the applied quotas
and, for a quota still at its AWS default, in `list-aws-default-service-quotas`). Run it on its own with
`scripts/aws-preflight.sh us-east-1`. It also prints the API Gateway WebSocket connection-rate
quota when Service Quotas lists one.

### Create a host user

Sign-up is off by default. Either set `initial_admin_email` (Cognito emails a temporary password on
the first apply) or create hosts with the AWS CLI:

```bash
aws cognito-idp admin-create-user \
  --region us-east-1 \
  --user-pool-id "$(terraform -chdir=infra/terraform/envs/aws-serverless output -raw cognito_user_pool_id)" \
  --username host@example.com \
  --user-attributes Name=email,Value=host@example.com Name=email_verified,Value=true \
  --desired-delivery-mediums EMAIL
```

Cognito emails a temporary password, which the host replaces at first sign-in at
`{site_url}/host`. No password is passed to Terraform or written to state. Players open
`{site_url}/join`.

### Destroy

```bash
scripts/destroy-aws.sh          # lists what will go, asks you to type "destroy"
scripts/destroy-aws.sh --yes    # for automation
```

It empties the site and media buckets (uploaded quiz images are not recoverable), then runs
`terraform destroy`. If you set `deletion_protection = true`, set it to `false` and apply first.

## Deploy the VM target

The VM runs the same app as one Node process behind Caddy, from
`deploy/vm/docker-compose.yml` (built in wave 2).

```bash
cp infra/terraform/envs/aws-vm/terraform.tfvars.example infra/terraform/envs/aws-vm/terraform.tfvars
# edit repo_url, repo_ref, domain
terraform -chdir=infra/terraform/envs/aws-vm init
terraform -chdir=infra/terraform/envs/aws-vm apply

# then publish the app's environment (ZQ_JWT_SECRET, ZQ_ADMIN_USER, ZQ_ADMIN_PASSWORD_HASH, ...):
scripts/vm-put-secrets.sh --name zqhoot --region us-east-1 --env-file deploy/vm/.env
```

What happens on the instance:

- `user_data` (no secrets in it) installs `docker.io`, `docker-compose-v2`, `git`, `jq` and the AWS
  CLI v2, clones `repo_url` at `repo_ref` into `/opt/zqhoot`, and installs `zqhoot.service`.
- `zqhoot.service` runs at every boot. Before starting the stack it runs `zqhoot-fetch-env`,
  which waits for the `/zqhoot/{name}/_READY` marker in SSM Parameter Store, reads every parameter
  under `/zqhoot/{name}/` with the instance role and writes `/opt/zqhoot/deploy/vm/.env` (mode 600),
  then runs `docker compose -f deploy/vm/docker-compose.yml up -d --build`.
- `scripts/vm-put-secrets.sh` writes each `KEY=value` of a local `.env` as a `SecureString`
  (standard tier, AWS-managed `alias/aws/ssm` key: no monthly fee) and writes `_READY` last, so the
  VM never starts from a half-written environment. Values reach the AWS CLI through a private
  temp file, not the command line. Wrap values that contain `$` in single quotes (the scrypt hash
  does); values must not contain a single quote or a newline.
- Point the `domain` A record at the `public_ip` output. Caddy requests its certificate on first
  start, which needs ports 80 and 443 reachable.

Operate it with SSM Session Manager (SSH is closed unless you set `ssh_cidr`):

```bash
aws ssm start-session --region us-east-1 --target "$(terraform -chdir=infra/terraform/envs/aws-vm output -raw instance_id)"
sudo tail -f /var/log/zqhoot-bootstrap.log     # first boot
sudo journalctl -u zqhoot -f                   # waiting for the environment, then compose
cd /opt/zqhoot && sudo git fetch && sudo git checkout --detach <ref> && sudo systemctl restart zqhoot   # upgrade
```

Changing `repo_ref` or the bootstrap script in Terraform does not touch a running instance
(`ignore_changes` on `ami` and `user_data`): the disk holds live game state. Upgrade with the
commands above, or replace the instance on purpose with
`terraform apply -replace=module.vm.aws_instance.this` (this discards its disk). The repository
must be readable without credentials, because none are put in `user_data`.

Destroy with `scripts/destroy-aws.sh --env aws-vm`: it deletes the SSM parameters, then runs
`terraform destroy`.

## Cost (from ADR-0012)

Everything in the serverless stack is pay-per-use, so an idle deployment costs about $0.02 a month
(S3 storage). One 400-player, 20-question session is about $0.11 (about $0.08 of API Gateway,
Lambda, DynamoDB and logs, plus about $0.03 of CloudFront transfer). These are AWS list prices
from ADR-0012, not measurements.

Excluded on purpose because they carry a fixed fee: NAT gateways and VPCs, provisioned
concurrency, customer-managed KMS keys, Secrets Manager secrets, WAF, API Gateway caching, and a
Route 53 hosted zone (about $0.50 a month if you add one for `custom_domain`). `validate.sh`
greps the serverless stack for these resource types and fails if one appears.

The VM target is always on: an instance, its EBS volume and an Elastic IP, billed by the hour
whether or not a quiz is running. The instance role uses the AWS-managed SSM key and there is no
customer-managed key.

Unmanaged, but worth knowing: if you enable `enable_access_logs` on the WebSocket module or leave
Lambda log retention long, CloudWatch Logs ingestion ($0.50 per GB) is the only cost that grows
with verbosity. Retention defaults to 14 days.

## Optional remote state

State is local by default. To keep it in S3 (Terraform 1.10 or later, native locking, no DynamoDB
lock table), copy `backend.tf.example` to `backend.tf` in the environment directory, fill in a
bucket you created yourself (private, versioned), and run `terraform init -migrate-state`.
`backend.tf` is git-ignored. Nothing in this stack puts a secret in state: the serverless stack has
no application secrets, Cognito sends temporary passwords by email, and the VM's secrets live only
in SSM. State does contain public identifiers and, for the serverless target, a random Cognito
domain suffix.

## Checks

```bash
infra/terraform/validate.sh              # everything below
infra/terraform/validate.sh --skip-tests # skip the mock-provider tests
```

It runs `terraform fmt -check -recursive`, `terraform init -backend=false` and `validate` in every
module and environment, `terraform test` in every directory with a `tests/` folder, a grep guard
for always-on resource types in the serverless stack, and
`tflint --recursive --config .tflint.hcl`. None of it needs credentials.

`.tflint.hcl` enables the bundled `terraform` plugin with the `recommended` preset (plus documented
variables and outputs and the naming convention) and the AWS ruleset. The AWS plugin block has no
`source` or `version`, so tflint uses the plugin already installed under `~/.tflint.d/plugins`
(the build environment has no route to GitHub). On a normal workstation, use the commented-out
block in the file and run `tflint --init`. No rule is disabled.

The `tests/` files use `mock_provider "aws"`, so they run offline. They assert, among other things:
the DynamoDB table matches `tableDefinition()` in `packages/store` (keys, `gsi1`, TTL, on-demand),
the IAM policies contain no wildcard actions and no bare `*` resource, the Lambda environment is
exactly the variable set the wave 2 build reads (module by module, and as wired by the serverless
environment), the CSP matches ADR-0013 plus the media bucket's upload origin, the bucket policies admit
only the distribution, `config.json` has the shape of `RuntimeConfig`, and the VM's `user_data`
contains no secret names.

## What was verified

In the environment this was written in (Terraform 1.16.4, tflint 0.64.0 with the AWS ruleset
0.49.0, providers `aws` 6.66.0, `random` 3.9.1 from a local mirror, no AWS credentials, no
network route to `registry.terraform.io`):

- `terraform fmt -check -recursive`, `terraform init -backend=false` and `terraform validate` pass
  for all six modules and both environments; there is no dependency cycle.
- `terraform test` (mock provider) passes for every module and both environments. The `config.json`
  it renders parses with the real `RuntimeConfig` zod schema from `packages/protocol`.
- `tflint --recursive` reports nothing with the config in this folder.
- The four scripts pass `bash -n`, `--help` works, and their flows were exercised against stub
  `aws` and `terraform` commands (preflight below/above the threshold, no credentials, no `aws`;
  deploy step order; destroy refusing without confirmation; the SSM writes of
  `vm-put-secrets.sh`). The instance-side `zqhoot-fetch-env` was run against a stub `aws` with the
  real `jq`, including the `$` and single-quote cases, and `docker compose config` (Docker
  Compose v2 from Docker CE, not Ubuntu's `docker-compose-v2` package) reads the rendered
  single-quoted `.env` with the `$` of a scrypt hash intact, both through `env_file` and through
  `${VAR}` interpolation.
- The `user_data` template renders to valid bash (`bash -n`), and `systemd-analyze verify` (systemd
  255.4, the version in Ubuntu 24.04) accepts the unit apart from the binary that only exists on
  the instance.
- The Ubuntu packages `docker.io`, `docker-compose-v2` (both in `universe`), `git`, `jq`, `unzip`,
  `curl` and `ca-certificates` exist for arm64 in the `noble` and `noble-updates` indexes on
  ports.ubuntu.com, and resolve in `apt-cache policy` on an Ubuntu 24.04 host. `awscli` does
  **not** exist in noble, which is why `user_data` installs AWS CLI v2 from
  `awscli.amazonaws.com` (the URL answered HTTP 200). No package was actually installed on an
  arm64 EC2 image.

**Not verified** (needs a real account):

- `terraform plan` and `apply` against AWS: provider-side validation and API behaviour are
  untested. Points most likely to need a tweak: WebSocket stage `auto_deploy` (documented as
  supported by API Gateway v2 for both protocols, not confirmed against WebSocket in practice),
  Cognito managed login (`managed_login_version = 2`, with a Cognito-provided default branding
  style) and the app client's `explicit_auth_flows`, and the `nodejs24.x` runtime being accepted in
  your Region.
- The `user_data` on a real Ubuntu 24.04 arm64 EC2 image: the package installation, the AWS CLI
  installer, cloud-init running it, and the first `docker compose up --build` on a `t4g.small`. The AMI name filter
  (`ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*`) follows Canonical's published
  pattern and was not looked up.
- `aws s3 sync` filter semantics with `--delete` and `--exclude` (as documented, excluded
  destination files are kept), CloudFront invalidations, and the Service Quotas queries against
  real output (the WebSocket quota is found by a case-insensitive match on "websocket" and
  "connect" in the quota name).
- That `deploy/vm/docker-compose.yml`, `apps/server-lambda` (`dist/ws.zip`, `dist/http.zip`,
  handler `index.handler` in `index.mjs`) and `apps/web` exist and behave as assumed: they are
  wave 2 deliverables.

## Decisions worth knowing

- **Ubuntu 24.04 on the VM, not Amazon Linux 2023.** ADR-0015 mentions Amazon Linux 2023; the task
  spec picked Ubuntu 24.04 (Canonical AMI, `docker.io` and `docker-compose-v2` from the archive).
- **IAM policies use `jsonencode`, not `aws_iam_policy_document`,** so the offline tests can read
  them back. The http Lambda gets the exact `gsi1` index ARN (ADR-0013) rather than `/index/*`.
  `dynamodb:TransactWriteItems` is listed because ADR-0013 lists it; DynamoDB authorises
  transactions through the item actions.
- **The VM's `kms:Decrypt` resource is `key/*` in the account and Region,** narrowed by
  `kms:ViaService = ssm.{region}.amazonaws.com`. The key ID behind `alias/aws/ssm` does not exist
  until the first SecureString is written, so it cannot be named in advance.
- **The VM waits for a `_READY` marker** that `vm-put-secrets.sh` writes last. It is an addition to
  the spec, to avoid starting from a half-written environment.
- **Site and media bucket names** are `{name}-site-` and `{name}-media-` plus a Terraform-generated
  suffix (`bucket_prefix`), so they are globally unique without looking up the account ID.
- **`aws_s3_object.config` owns `config.json`;** the deploy script never uploads it.
- **The CSP goes one step beyond ADR-0013.** ADR-0013 lists `connect-src 'self' {wsUrl}
  {cognitoDomain}` and `form-action 'self' {cognitoDomain}`. ADR-0011 uploads media by S3
  presigned POST straight from the browser to the media bucket, which those directives do not
  allow, so the CloudFront policy also allows `https://{media bucket}.s3.{region}.amazonaws.com` in
  `connect-src` and `form-action`. The ADRs are frozen for this task: ADR-0013's CSP line needs the
  same addition. The VM target needs none, because it uploads with a same-origin
  `PUT /api/media/...` (ADR-0011). Wave 2's presigner must produce a URL on exactly that host (default
  virtual-hosted-style S3 client for the bucket's Region; no custom endpoint, path-style,
  dual-stack or FIPS endpoint). `terraform output media_upload_origin` shows it.
- **Cognito user names are case-insensitive** (`username_configuration.case_sensitive = false`),
  fixed rather than a variable: Cognito cannot change it once the pool exists.
- **Old hashed web assets are never deleted by the deploy script,** so a deploy cannot break
  clients that are mid-session (see Deploy).
