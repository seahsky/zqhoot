# W2-vm-deploy: Docker image, Compose stack, Caddy

Owner: Sonnet implementation agent. Reviewer: independent Opus agent.

## Goal

Make the VM target deployable on any Linux host with Docker: a production image of the Node server + web app, a Compose stack with Caddy terminating TLS, documented configuration, and verified locally (Docker works in this environment).

Read first:

- `docs/adr/0015-vm-deployment.md`, `docs/adr/0013-security.md`
- `apps/server-node/README.md`, `apps/web/README.md`
- `docs/tasks/W1-infra.md`: the `vm` module's user_data expects `deploy/vm/docker-compose.yml` and `deploy/vm/.env`.

## Files you own

- `Dockerfile` and `.dockerignore` at the repo root
- `deploy/vm/**`: `docker-compose.yml`, `Caddyfile`, `.env.example`, `README.md`, `smoke-test.sh`

## Requirements

- **Dockerfile** (multi-stage, BuildKit):
  - **Build stage:** `node:24-alpine`, corepack pnpm 10.33.0, `pnpm install --frozen-lockfile`, `pnpm --filter @zqhoot/web build` and `pnpm --filter @zqhoot/server-node build`.
  - **Runtime stage:** `node:24-alpine`. It contains only `apps/server-node/dist` (the server is bundled; no `node_modules` unless a native module requires it, and none should), the web `dist` at `/app/web`, `ZQ_WEB_DIST=/app/web` and `ZQ_DATA_DIR=/data`.
  - Non-root `node` user, `/data` owned by it, `EXPOSE 8080`.
  - `HEALTHCHECK` with `wget -qO- http://127.0.0.1:8080/api/health` (busybox wget is present in alpine).
  - `CMD ["node", "--enable-source-maps", "server.mjs"]`.
  - Image labels (OCI).
  - **Proxy:** this environment reaches npm through a proxy. Build with `docker build --network host` and pass `HTTPS_PROXY`/CA as build args in a way that doesn't leak into the final image. Document it in the README as environment-specific, not required elsewhere.
- **`.dockerignore`:** `node_modules`, `**/dist`, `.git`, `infra/.terraform`, `load/results`, test output and `.env*`.
- **`docker-compose.yml`:**
  - Service `app`: build from the repo root, `env_file: .env`, volume `zqdata:/data`, `restart: unless-stopped`, no published ports (only Caddy is exposed), healthcheck, read-only root filesystem with a tmpfs `/tmp`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`.
  - Service `caddy`: `caddy:2-alpine`, ports 80/443 (and 443/udp), volumes for `Caddyfile`, `caddy_data` and `caddy_config`, `depends_on: app` (healthy).
  - Named volumes.
- **`Caddyfile`:**
  - Site address `{$ZQ_DOMAIN}`, reverse proxy to `app:8080`. WebSockets work through `reverse_proxy` natively, so no special directives are needed.
  - Headers per ADR-0013 (HSTS only when HTTPS), `encode zstd gzip` (static only; WebSocket frames pass through untouched), and access logs to stdout.
  - Three TLS modes selected by `ZQ_TLS_MODE`:
    - `acme` (default, automatic HTTPS; `ZQ_ACME_EMAIL` optional)
    - `files` (mount `/certs/cert.pem`, `/certs/key.pem`)
    - `internal` (Caddy's internal CA)
  - Implement it so one Caddyfile works for all three, e.g. snippets imported by an environment placeholder. Verify each mode parses with `caddy validate` or `caddy adapt` inside the container.
  - Also a `http` mode for local testing only (plain HTTP on :80), clearly labelled.
- **`.env.example`:** every server variable from `apps/server-node/README.md` plus `ZQ_DOMAIN`, `ZQ_TLS_MODE` and `ZQ_ACME_EMAIL`, with placeholder values and comments. No real secrets. Include the command to generate `ZQ_JWT_SECRET` (`openssl rand -base64 48`) and the password hash (`docker compose run --rm app node hash-password.mjs`).
- **`smoke-test.sh`:**
  1. Bring the stack up with `ZQ_TLS_MODE=http` on localhost and a generated `.env` in a temp dir.
  2. Wait for health.
  3. `curl` `/api/health`, `/config.json` and `/` through Caddy.
  4. Log in, create a quiz and a session via the API.
  5. Open a WebSocket through Caddy and join as a player. Use a tiny Node script that relies on Node 22's global `WebSocket`, so no dependency is needed.
  6. Tear down (`--keep` to leave it running).

  It must pass in this environment.

- **`deploy/vm/README.md`:** requirements (Docker Engine + Compose v2, ports 80/443, a DNS name for ACME); first-time setup; upgrading (`git pull && docker compose up -d --build`); backups (the `zqdata` volume); TLS modes; the AWS path via Terraform (`infra/terraform/envs/aws-vm`, `scripts/vm-put-secrets.sh`); troubleshooting.

## Acceptance criteria

1. `docker build --network host -t zqhoot:test .` succeeds here. The runtime image contains no source, `.env` or dev dependencies (check with `docker run --rm zqhoot:test ls -R /app | head`). Report the image size.
2. `deploy/vm/smoke-test.sh` passes here end to end (Caddy + app, HTTP mode).
3. All four Caddy modes validate.
4. The app container runs as non-root with a read-only root filesystem.
5. No secrets are committed; `.env` is gitignored.
