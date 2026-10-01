# ADR-0015: Single-VM deployment

Status: accepted (2026-09-29)

## Decision

- **Process:** one Node 24 process (`apps/server-node`) serves the built web app, `/config.json` (generated from environment at startup), `/api/*` (the same Hono app as Lambda), `/ws` (`ws`) and `/media/*`. It is one process by design: all live game state is in memory, which is what makes the VM path fast and simple.
- **Store:** `MemoryStore` with persistence. The whole state is written as JSON to `${ZQ_DATA_DIR}/state.json`: debounced 1 s after mutations, atomic via temp file + rename, and on `SIGTERM`. It is loaded at startup. Media goes to `${ZQ_DATA_DIR}/media`. Optional `ZQ_STORE=dynamodb` runs against a real DynamoDB table (e.g. on EC2 with an instance role), reusing `DynamoStore`.
- **Timers:** the question deadline close is scheduled with `setTimeout`, and restored on restart from persisted `deadline`s.
- **Compose** (`deploy/vm/docker-compose.yml`):
  - `app`: built from the repo's `Dockerfile` (multi-stage: pnpm install/build, then a slim runtime on `node:24-alpine`, non-root user). Healthcheck on `/api/health`. Volume `zqdata:/data`.
  - `caddy`: `caddy:2-alpine`, TCP 80/443 and UDP 443 (HTTP/3), `Caddyfile` reverse-proxies to `app:8080` with security headers. Volumes for Caddy data/config.
- **TLS options** (see open question 2 in ARCHITECTURE), chosen with `ZQ_TLS_MODE` in `deploy/vm/.env`:
  1. `acme` (default): Caddy automatic HTTPS via ACME for `ZQ_DOMAIN`. It needs a public DNS name and ports 80/443 reachable. This uses a public certificate authority, which is not a SaaS the app depends on at runtime.
  2. `files`: bring your own certificate. Mount `cert.pem` and `key.pem` from the directory in `ZQ_CERTS_DIR` (default `./certs`).
  3. `internal`: Caddy's internal CA (`tls internal`) for on-prem or air-gapped use. Devices must trust Caddy's root.
  4. `http`: no TLS, for a TLS-terminating proxy in front or for local testing.
- **`envs/aws-vm`** (Terraform):
  - One EC2 instance: default `t4g.small`, any arm64 type allowed, Canonical Ubuntu 24.04 LTS arm64.
  - Security group: TCP 80/443 and UDP 443. Port 22 is optional and off by default; SSM Session Manager is preferred.
  - gp3 root volume (encrypted), Elastic IP, IMDSv2 only, and an instance profile with `AmazonSSMManagedInstanceCore` plus read access to the app's parameters.
  - `user_data` installs Docker and Compose, clones the repo at a pinned ref and runs `docker compose up -d --build`.
  - Secrets never pass through Terraform, its state or `user_data`: the operator publishes `.env` values with `scripts/vm-put-secrets.sh` to SSM Parameter Store as SecureString parameters under `/zqhoot/{name}/` (standard parameters are free), writing a `_READY` marker last. At boot the instance waits for the marker, then writes `.env` from the parameters before starting Compose.
- **Amendment (2026-09-29, final audit):** this record first said Amazon Linux 2023, `ZQ_TLS=files`, ports 80/443 only, and secrets passed through `terraform apply -var-file`. The implementation uses Ubuntu 24.04 (Docker and Compose v2 come from the distribution's own packages), `ZQ_TLS_MODE`, UDP 443 for HTTP/3, and the SSM script so that no secret reaches Terraform state. The text above describes what was built.

## Consequences

- A VM restart loses in-flight socket connections. Phones reconnect and `resume` from the persisted state, up to 1 s stale.
- The VM target is not scale-to-zero and doesn't need to be.
- Capacity for one process: 400 players is a small load for `ws` (verified by the load test). Several concurrent sessions of 400 are expected to fit, but that is not verified.
