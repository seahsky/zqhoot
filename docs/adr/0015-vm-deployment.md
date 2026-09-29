# ADR-0015: Single-VM deployment

Status: accepted (2026-09-29)

## Decision

- **Process:** one Node 24 process (`apps/server-node`) serves the built web app, `/config.json` (generated from environment at startup), `/api/*` (the same Hono app as Lambda), `/ws` (`ws`) and `/media/*`. It is one process by design: all live game state is in memory, which is what makes the VM path fast and simple.
- **Store:** `MemoryStore` with persistence. The whole state is written as JSON to `${ZQ_DATA_DIR}/state.json`: debounced 1 s after mutations, atomic via temp file + rename, and on `SIGTERM`. It is loaded at startup. Media goes to `${ZQ_DATA_DIR}/media`. Optional `ZQ_STORE=dynamodb` runs against a real DynamoDB table (e.g. on EC2 with an instance role), reusing `DynamoStore`.
- **Timers:** the question deadline close is scheduled with `setTimeout`, and restored on restart from persisted `deadline`s.
- **Compose** (`deploy/vm/docker-compose.yml`):
  - `app`: built from the repo's `Dockerfile` (multi-stage: pnpm install/build, then a slim runtime on `node:24-alpine`, non-root user). Healthcheck on `/api/health`. Volume `zqdata:/data`.
  - `caddy`: `caddy:2-alpine`, ports 80/443, `Caddyfile` reverse-proxies to `app:8080` with security headers. Volumes for Caddy data/config.
- **TLS options** (see open question 2 in ARCHITECTURE):
  1. Default: Caddy automatic HTTPS via ACME for `ZQ_DOMAIN`. It needs a public DNS name and ports 80/443 reachable. This uses a public certificate authority, which is not a SaaS the app depends on at runtime.
  2. Bring your own certificate: mount cert/key and set `ZQ_TLS=files`.
  3. Internal CA (`tls internal`) for on-prem/air-gapped use. Devices must trust Caddy's root.
- **`envs/aws-vm`** (Terraform): one EC2 instance (default `t4g.small`, Amazon Linux 2023 arm64), security group 80/443 (22 optional and off by default; SSM Session Manager preferred), gp3 root volume, Elastic IP, and an instance profile with `AmazonSSMManagedInstanceCore`. `user_data` installs Docker and Compose, clones the repo at a pinned ref and runs `docker compose up -d --build`. Secrets are not in `user_data`: the operator writes `.env` over SSM before first start (documented), or passes it from a local file via `terraform apply -var-file` into SSM Parameter Store SecureString (standard parameters are free) that the instance reads at boot.

## Consequences

- A VM restart loses in-flight socket connections. Phones reconnect and `resume` from the persisted state, up to 1 s stale.
- The VM target is not scale-to-zero and doesn't need to be.
- Capacity for one process: 400 players is a small load for `ws` (verified by the load test). Several concurrent sessions of 400 are expected to fit, but that is not verified.
