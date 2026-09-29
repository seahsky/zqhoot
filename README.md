# zqhoot

zqhoot is a self-hosted live quiz and audience-response app. A host runs a session from a laptop connected to a projector. Up to about 400 players join from their phones with a 6-digit PIN and a nickname, answer in real time, and see their results.

- **Question types:**
  - single choice (2-4 options) and true/false, both timed and scored
  - poll with a live bar chart
  - word cloud
  - open-ended text with host moderation
  - rating scale
- **Host:** sign-in, a quiz editor with image uploads, and live control (PIN and QR code, lobby, next/skip/end, lock joining, kick, moderation), plus CSV export.
- **Presenter** (`/present`): a 16:9 stage that reads from the back of a hall and stays legible from 1366x768 to 4K. It has keyboard and clicker control, a leaderboard after scored questions and a podium at the end.
- **Players** (`/join`, `/play`): phone-first, one-handed, from 320 px wide. Answers are told apart by letter and shape, never by colour alone. Players survive screen locks and reconnects without losing their score.
- **Server-authoritative:** correct answers never reach phones before the reveal, and scoring uses server time only.

## Deployment targets

There are two targets, built from one codebase:

| Target         | What runs                                                                                              | Idle cost                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| AWS serverless | S3 + CloudFront, API Gateway (WebSocket + HTTP) + Lambda (Node 24, arm64), DynamoDB on-demand, Cognito | about $0.02/month, scales to zero ([ADR-0012](docs/adr/0012-cost-model.md)) |
| Any Linux VM   | One Node process and Caddy for TLS, in Docker Compose                                                  | whatever the VM costs                                                       |

A 400-player, 20-question session on AWS costs about $0.11 at list price ([arithmetic](docs/adr/0012-cost-model.md)).

## Local development

You need Node 22 or later and pnpm 10 (`corepack enable`).

```sh
pnpm install
pnpm --filter @zqhoot/web build
pnpm --filter @zqhoot/server-node dev
```

Open http://localhost:8080/host and sign in as `admin` with the password `dev-password` (throwaway values from `apps/server-node/dev.env`). Create a quiz and start a session. Then open `/join` on a phone or in a second browser window.

For hot reload of the web app, run `pnpm --filter @zqhoot/web dev` as well: Vite on port 5173 proxies to the server. Start the server with `ZQ_PUBLIC_URL=http://localhost:5173` in that case; see [apps/server-node/README.md](apps/server-node/README.md).

## Deploy to AWS (serverless)

You need the AWS CLI v2 with credentials, Terraform 1.10 or later, Node 22 or later, and pnpm.

```sh
scripts/deploy-aws.sh      # preflight check, build, terraform apply, upload the site, print the URL
```

Then create a host account (self-sign-up is off by default):

```sh
aws cognito-idp admin-create-user \
  --user-pool-id "$(terraform -chdir=infra/terraform/envs/aws-serverless output -raw cognito_user_pool_id)" \
  --username host@example.com \
  --user-attributes Name=email,Value=host@example.com Name=email_verified,Value=true
```

The deploy script first runs `scripts/aws-preflight.sh`, which matters on a **new AWS account**. New accounts can start with a Lambda concurrency limit as low as 10, which throttles a 400-answer burst. The script prints the exact quota-increase request. Details, variables, custom domains and optional remote state are in [infra/terraform/README.md](infra/terraform/README.md).

## Deploy to a VM

You need Docker Engine with Compose v2, ports 80/443 open, and a DNS name for automatic HTTPS.

```sh
git clone https://github.com/seahsky/zqhoot.git && cd zqhoot/deploy/vm
cp .env.example .env && chmod 600 .env          # set ZQ_DOMAIN, ZQ_JWT_SECRET, ZQ_ADMIN_PASSWORD_HASH
docker compose run --rm app node hash-password.mjs
docker compose up -d --build
```

TLS modes (ACME, your own certificate, Caddy's internal CA), backups, upgrades and troubleshooting are in [deploy/vm/README.md](deploy/vm/README.md). To run the VM target on EC2, use the Terraform environment [infra/terraform/envs/aws-vm](infra/terraform/envs/aws-vm) with `scripts/vm-put-secrets.sh`.

## Tear down

| Target         | Command                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| AWS serverless | `scripts/destroy-aws.sh`: empties the buckets, then `terraform destroy` (asks you to type "destroy") |
| AWS VM (EC2)   | `scripts/destroy-aws.sh --env aws-vm`                                                                |
| Any VM         | `cd deploy/vm && docker compose down` (add `-v` to delete the data volume)                           |

## Repository layout

```
packages/protocol    zod schemas for every client<->server message, HTTP bodies, limits
packages/engine      pure game logic: state machine, scoring, reveal, snapshots, nickname rules
packages/store       Store interface, DynamoDB and in-memory implementations, contract tests
packages/service     GameService + HTTP API shared by both servers (ports for transport, auth, media)
apps/web             React + Vite: /join, /play, /host, /present, /edit
apps/server-node     single-process server for the VM target
apps/server-lambda   API Gateway + Lambda handlers, build, and a local API Gateway emulator
infra/terraform      modules and the aws-serverless / aws-vm environments
deploy/vm            Dockerfile-based Compose stack with Caddy
load                 k6 load test for 400 players
docs                 research, architecture, ADRs, task specs, review records
```

## Testing

```sh
pnpm typecheck && pnpm test                       # every package (store/service/lambda tests need DynamoDB Local on :8000)
pnpm --filter @zqhoot/web test:e2e                # gallery matrix: every screen x 6 viewports, axe, overflow, screenshots
pnpm --filter @zqhoot/web test:e2e:live           # full game in real browsers against the Node server
bash infra/terraform/validate.sh                  # fmt, validate, mock-provider tests, tflint
deploy/vm/smoke-test.sh                           # Docker image + Caddy + API/WebSocket end to end
load/run-local.sh node                            # 400-player k6 load test against the Node server
```

Load-test results are in [load/RESULTS.md](load/RESULTS.md).

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): system overview, flows, and the choices in effect.
- [docs/adr/](docs/adr/): 16 architecture decision records (protocol, fairness and scoring, DynamoDB design, broadcast, reconnect, auth, cost, security, and more).
- [docs/research/](docs/research/): the research behind those decisions, with sources and how each was verified.
- [docs/PLAN.md](docs/PLAN.md): the build plan, task specs, status, and deferred review findings.
- [docs/reviews/](docs/reviews/): records of the independent gate reviews.
