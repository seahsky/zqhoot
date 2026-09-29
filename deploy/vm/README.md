# zqhoot on a single VM

Runs the whole app on one Linux machine with Docker: the Node server (`apps/server-node`, which also
serves the web app) behind [Caddy](https://caddyserver.com/), which terminates TLS. The design is
[ADR-0015](../../docs/adr/0015-vm-deployment.md); the server's own settings are in
[`apps/server-node/README.md`](../../apps/server-node/README.md).

```
browser ──443──► caddy ──► app:8080 (node)  ── /data (volume zqdata: state.json, media/)
                   │            └─ web app, /config.json, /api/*, /ws, /media/*
                   └─ certificates (volume caddy_data)
```

| File                 | What it is                                                                |
| -------------------- | ------------------------------------------------------------------------- |
| `docker-compose.yml` | The stack: `app` (built from the repo's `Dockerfile`) and `caddy`         |
| `Caddyfile`          | Reverse proxy, security headers, compression, access log, the TLS modes   |
| `.env.example`       | Every setting, with placeholders. Copy to `.env`                          |
| `smoke-test.sh`      | End-to-end check of the whole stack on your machine (see below)           |
| `certs/`             | Where `cert.pem` and `key.pem` go for the `files` TLS mode (never in git) |

Only Caddy publishes ports (80, 443 and 443/udp for HTTP/3). The app is reachable only through it.

## What you need

- A Linux host with Docker Engine and the Compose v2 plugin (`docker compose version`). On Ubuntu
  24.04: `sudo apt-get install docker.io docker-compose-v2 docker-buildx`.
- Ports 80 and 443 free and reachable. Automatic HTTPS needs them open to the internet.
- For automatic HTTPS: a DNS name whose A (and AAAA) record points at the host. Without one, use the
  `internal` or `files` TLS mode.
- About 1 GB of free disk for the image build, and 1 GB of RAM (2 GB is comfortable while building).
- Outbound access to Docker Hub and the npm registry for the first build.

## First-time setup

```sh
git clone https://github.com/seahsky/zqhoot.git && cd zqhoot/deploy/vm
cp .env.example .env && chmod 600 .env
```

1. **Edit `.env`.** Set `ZQ_DOMAIN` to your DNS name and `ZQ_TLS_MODE` (see [TLS modes](#tls-modes)).
2. **Generate the JWT secret** and put it in `ZQ_JWT_SECRET`:

   ```sh
   openssl rand -base64 48
   ```

3. **Generate the admin password hash** and put it, between single quotes, in
   `ZQ_ADMIN_PASSWORD_HASH`. The command builds the image the first time and asks for the password
   twice without echoing it:

   ```sh
   docker compose run --rm app node hash-password.mjs
   ```

   Single quotes matter: the hash contains `$`, which Compose would otherwise try to expand.

4. **Start it:**

   ```sh
   docker compose up -d --build
   docker compose ps          # app should become "healthy", caddy "running"
   docker compose logs -f     # Ctrl-C leaves the stack running
   ```

5. **Open** `https://your.domain/`, log in as `ZQ_ADMIN_USER` (default `admin`) with the password you
   hashed. In `acme` mode the first request may take a few seconds while Caddy obtains the
   certificate.

The server refuses to start on an invalid configuration and prints every problem (never the values).
The placeholders in `.env.example` are invalid on purpose, so a file copied without editing does not
run with a guessable secret.

## TLS modes

`ZQ_TLS_MODE` in `.env` selects one; the same `Caddyfile` serves all of them.

| Mode       | Certificate                                                     | Use it when                                             |
| ---------- | --------------------------------------------------------------- | ------------------------------------------------------- |
| `acme`     | Automatic, from a public CA (Let's Encrypt or ZeroSSL). Default | The host has a public DNS name and open 80/443          |
| `files`    | Yours: `certs/cert.pem` and `certs/key.pem`                     | You already have a certificate (corporate CA, wildcard) |
| `internal` | Signed by Caddy's own certificate authority                     | LAN or air-gapped, no public DNS                        |
| `http`     | None: plain HTTP on port 80                                     | **Local testing only** (the smoke test uses it)         |

`ZQ_PUBLIC_URL` defaults to `https://$ZQ_DOMAIN`. It must be exactly what people type in the browser
(scheme, host, and a port if it is not 443), because the WebSocket `Origin` check compares against it.
Set it explicitly for the `http` mode (`http://localhost`) or a non-standard port.

**`acme`.** Point the DNS record at the host, open 80 and 443 (the certificate authority validates
over them), start the stack. Certificates renew by themselves; keep the `caddy_data` volume, it holds
the account and the certificates. Set `ZQ_ACME_EMAIL` to receive expiry notices. If issuance fails,
`docker compose logs caddy` says why (usually DNS not yet pointing here, or a closed port).

**`files`.** Put the full chain in `certs/cert.pem` and the private key in `certs/key.pem`
(`ZQ_CERTS_DIR` chooses another folder). The files are mounted read-only and are git-ignored. Caddy
does not renew them; after replacing them run

```sh
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
```

**`internal`.** Caddy issues the certificate from its own root, so every device must trust that root
or its browser warns. Export it once the stack has started and install it on the devices:

```sh
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt
```

`ZQ_DOMAIN` must be a name the devices can resolve (a local DNS entry, or an IP address). Phones need
HTTPS for several browser features, so do not use `http` for real sessions.

**`http`.** Listens on port 80 for any host name and sends no HSTS. It does not use `ZQ_DOMAIN`, but
Compose still requires the variable in every mode, so give it any value (`localhost`). Passwords and
tokens cross the network in clear text: never expose it beyond your own machine.

## Configuration

`.env` is read twice: Compose substitutes `${...}` in `docker-compose.yml` from it, and the `app`
service receives it as its environment. `.env.example` lists every variable with a comment; the server
variables are documented in [`apps/server-node/README.md`](../../apps/server-node/README.md).

Fixed by the stack and not overridable from `.env`: `ZQ_PORT=8080`, `ZQ_HOST=0.0.0.0`,
`ZQ_DATA_DIR=/data`, `ZQ_WEB_DIST=/app/web` and `ZQ_TRUST_PROXY=true` (Caddy is the only client the
app sees, so its `X-Forwarded-For` header identifies the real client for the per-IP rate limits).

After editing `.env`, apply it with `docker compose up -d` (Compose recreates what changed).

## Day-two operations

```sh
docker compose ps                  # status and health
docker compose logs -f app         # the app's JSON log lines
docker compose logs -f caddy       # Caddy's log, and the access log (one JSON line per request)
docker compose restart app         # graceful: state.json is written on SIGTERM
docker compose down                # stop and remove containers; volumes (your data) stay
```

Container logs rotate at 3 files of 10 MB each. Caddy's access log redacts `Authorization` and cookies
and the `t` token of media upload URLs.

### Upgrading

```sh
git pull
ZQ_REVISION=$(git rev-parse HEAD) docker compose up -d --build
```

This rebuilds the image and recreates the containers whose image or configuration changed. Only
changed source is rebuilt: the dependency layer is reused until `pnpm-lock.yaml` or a `package.json`
changes. `ZQ_REVISION` is optional; it is recorded in the image's `org.opencontainers.image.revision`
label (`docker image inspect zqhoot:local`), so a running image can be traced to a commit. Sessions
in progress are interrupted for a few seconds: the app writes its state on shutdown, and phones
reconnect and resume on their own ([ADR-0008](../../docs/adr/0008-reconnect-resume.md)). Upgrade
between sessions when you can. Pin a tag (`git checkout v1.2.3`) for repeatable deployments.

### Backups

Everything the app owns is in the `zqdata` volume (`zqhoot_zqdata` on disk): `state.json` (quizzes,
sessions, results) and `media/` (uploaded images). Copying while the app runs is safe: the file is
replaced atomically and media files are written once.

```sh
docker run --rm -v zqhoot_zqdata:/data:ro -v "$PWD":/backup alpine \
  tar czf /backup/zqdata-$(date +%F).tgz -C /data .
```

Restore into an empty or existing volume with the app stopped:

```sh
docker compose stop app
docker run --rm -v zqhoot_zqdata:/data -v "$PWD":/backup alpine \
  sh -c 'rm -rf /data/* /data/.[!.]* 2>/dev/null; tar xzf /backup/zqdata-2026-09-29.tgz -C /data && chown -R 1000:1000 /data'
docker compose start app
```

Also back up `.env` (it holds the secrets) somewhere safe, separately from the data. The `caddy_data`
volume holds certificates that can be issued again, but back it up if you use the `internal` mode:
its root certificate is what your devices trust.

### Secrets

- **Change the admin password:** run `docker compose run --rm app node hash-password.mjs`, replace
  `ZQ_ADMIN_PASSWORD_HASH` in `.env` (single quotes), `docker compose up -d`.
- **Rotate `ZQ_JWT_SECRET`:** replace it and `docker compose up -d`. The host is logged out and
  pending media upload grants stop working; nothing else depends on it.
- Renaming `ZQ_ADMIN_USER` starts an empty account: quizzes belong to `local:<name>`.

## Deploying on AWS with Terraform

`infra/terraform/envs/aws-vm` creates one EC2 instance (Ubuntu 24.04, Elastic IP, ports 80 and 443,
SSM Session Manager for access) that installs Docker, clones this repository at `repo_ref` into
`/opt/zqhoot` and runs this same stack with a systemd unit. See the module's
[README](../../infra/terraform/modules/vm/README.md) and the environment's `terraform.tfvars.example`.

1. `terraform init && terraform apply` in `infra/terraform/envs/aws-vm` (set `repo_url`, `repo_ref`,
   `domain`). Nothing secret goes through Terraform.
2. Prepare `deploy/vm/.env` on your machine exactly as under [First-time setup](#first-time-setup)
   (`ZQ_DOMAIN`, `ZQ_JWT_SECRET`, `ZQ_ADMIN_PASSWORD_HASH`; keep `ZQ_TLS_MODE=acme`). You can generate
   the hash with `docker compose run --rm app node hash-password.mjs` anywhere Docker runs, or with
   `pnpm --filter @zqhoot/server-node hash-password` in a checkout.
3. Publish it to SSM Parameter Store as SecureStrings:

   ```sh
   scripts/vm-put-secrets.sh --name zqhoot --region us-east-1 --env-file deploy/vm/.env
   ```

   The instance is waiting for this. Within about a minute it renders the parameters into
   `/opt/zqhoot/deploy/vm/.env` (mode 600) and runs `docker compose up -d --build`.

4. Point the domain's A record at the `public_ip` output. Caddy obtains the certificate once DNS
   resolves.

To upgrade or change settings later, connect with `aws ssm start-session --target <instance_id>`:

```sh
cd /opt/zqhoot && sudo git fetch --tags origin && sudo git checkout --detach origin/main   # or a tag
sudo systemctl restart zqhoot      # re-reads SSM, then docker compose down and up --build
```

To change a value, run `scripts/vm-put-secrets.sh` again, then restart the unit. `journalctl -u zqhoot`
and `docker compose -f deploy/vm/docker-compose.yml logs` show what is happening.

Two limits of that setup: the instance's metadata hop limit is 1, so containers cannot use the
instance role (`ZQ_STORE=dynamodb` from the container needs credentials passed in `.env`), and the
default `memory` store keeps state on the instance's disk only. Back up `zqdata` as above, or take EBS
snapshots.

## Smoke test

```sh
deploy/vm/smoke-test.sh            # builds the image, tests, tears everything down
deploy/vm/smoke-test.sh --keep     # leaves the stack running and prints how to reach and remove it
deploy/vm/smoke-test.sh --image zqhoot:local    # test an image you already built
```

It needs Docker with Compose v2, `curl`, `openssl` and Node 22 or newer, and touches nothing of a real
deployment: its own Compose project, a generated `.env` in a temp directory, a random free port on
127.0.0.1, `ZQ_TLS_MODE=http`. It checks that:

- the `Caddyfile` validates in all four TLS modes (`caddy validate` in the Caddy image) and rejects an
  unknown mode;
- the app is healthy and runs as a non-root user with a read-only root filesystem, all capabilities
  dropped, no published port and no package manager (`npm`, `corepack`, `yarn`) or `node_modules`
  in the image;
- `/api/health`, `/config.json` and `/` answer through Caddy, with the ADR-0013 headers and without
  HSTS (HTTP mode), without `Server` or `Via`, and static text assets are compressed while API
  responses are not;
- login works (and a wrong password does not), a quiz and a session can be created, a host and a
  player connect over WebSocket, a foreign `Origin` is refused;
- after `docker compose restart app` the quiz, the session and the player's token are still valid.

It does not look at specific screens of the web app, so it keeps working while the UI changes.

## Building behind a proxy

**This section is specific to environments whose outbound HTTPS goes through a TLS-intercepting proxy
(this project's development sandbox). On an ordinary network none of it is needed: a plain
`docker compose up -d --build` just works.**

Such an environment breaks `docker build` in up to two ways: the build containers do not trust the
proxy's CA (npm downloads fail with "certificate verify failed"), and, where the registry is only
reachable through the proxy, the proxy listens on the host's `127.0.0.1`, which a build container
cannot reach. The `Dockerfile` therefore accepts an optional build secret `cacert` (a PEM bundle) and
honours the predefined `HTTPS_PROXY` and `NO_PROXY` build arguments. Neither ends up in the image: the
secret exists only while a `RUN` step runs, and Docker keeps proxy arguments out of the image history.

```sh
docker build --network host \
  --build-arg HTTPS_PROXY="$HTTPS_PROXY" --build-arg NO_PROXY="$NO_PROXY" \
  --secret id=cacert,src=/root/.ccr/ca-bundle.crt \
  -t zqhoot:local .
docker compose up -d --no-build    # uses the image that was just built (ZQ_IMAGE, default zqhoot:local)
```

`--network host` and the two `--build-arg`s are needed only when the registry is reachable through the
loopback proxy alone; in this project's sandbox the registry is also reachable directly, so the `--secret`
by itself is enough there. `smoke-test.sh` adds these flags by itself when `HTTPS_PROXY` is set (CA
from `ZQ_BUILD_CA_FILE`, else `NODE_EXTRA_CA_CERTS`, else `SSL_CERT_FILE`).

## Security notes

- Only Caddy is exposed. The `app` container has no published port, runs as the unprivileged `node`
  user, on a read-only root filesystem (writable: the `/data` volume and a tmpfs `/tmp`), with all
  capabilities dropped and `no-new-privileges`. Caddy runs with a read-only root filesystem too and
  only the capability to bind ports 80 and 443.
- The image holds the bundled server and the built web app only: no source, no `node_modules` (the
  base image's npm, corepack and yarn are removed too), no `.env`. Source maps are kept (for readable
  stack traces) without the embedded source text.
- Response headers follow [ADR-0013](../../docs/adr/0013-security.md): HSTS for one year (TLS modes
  only), `nosniff`, `Referrer-Policy`, `Permissions-Policy` and a CSP. The app sets an exact CSP on its
  pages and a stricter one on uploaded media; Caddy adds its default only where the app sent none.
  Caddy's `Server` and `Via` headers are removed, and only the web app's static files are compressed
  (never `/api/*`, whose login answer carries the host's token, or `/config.json`).
- `.env` and `certs/*` are git-ignored. Keep `.env` at mode 600; it holds the JWT secret and the
  password hash.
- Behind another proxy or CDN in front of Caddy, its `X-Forwarded-For` is ignored by Caddy unless you
  add `trusted_proxies` to the Caddyfile, and the per-IP limits then count that proxy. Put nothing
  in front unless you have to.

## Troubleshooting

| Symptom                                                                         | Likely cause and fix                                                                                                                                                                                           |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `required variable ZQ_DOMAIN is missing a value`                                | `.env` is missing or has no `ZQ_DOMAIN`. Run Compose from `deploy/vm` (or with `-f deploy/vm/docker-compose.yml`) so it finds the `.env` next to the file.                                                     |
| `app` restarts or is `unhealthy`; log says `invalid configuration`              | Read `docker compose logs app`: each problem is listed by variable name. Placeholders (`CHANGE_ME`) and a JWT secret under 32 bytes are rejected on purpose.                                                   |
| Values with `$` look mangled                                                    | Put the password hash in single quotes in `.env`.                                                                                                                                                              |
| Browser shows a certificate error in `acme` mode                                | DNS does not point at this host yet, or 80/443 are blocked. `docker compose logs caddy \| grep -i -E 'error\|obtain'`. Let's Encrypt limits repeated failures; wait, fix, retry.                               |
| Certificate warning in `internal` mode                                          | The device does not trust Caddy's root: see [TLS modes](#tls-modes).                                                                                                                                           |
| Page loads but the game never connects; app log has `websocket origin rejected` | `ZQ_PUBLIC_URL` is not exactly the address in the browser (scheme, host, port). Fix it in `.env`, `docker compose up -d`.                                                                                      |
| `bind: address already in use` on start                                         | Another service uses 80 or 443. Stop it, or (for testing only) set `ZQ_HTTP_PORT` and `ZQ_HTTPS_PORT`.                                                                                                         |
| Many players see `429` or "rate-limited"                                        | The app must see real client addresses. The stack sets `ZQ_TRUST_PROXY=true`; check that nothing else sits between the players and Caddy. A class behind one NAT shares one IP: 400 requests burst is allowed. |
| Generating the hash in a script or over a non-interactive session               | Pipe the password and add `-T`: `printf '%s' "$PW" \| docker compose run --rm -T app node hash-password.mjs`.                                                                                                  |
| `docker build` fails on TLS or times out on a corporate or sandbox network      | See [Building behind a proxy](#building-behind-a-proxy).                                                                                                                                                       |
| `no space left on device` while building                                        | The build needs about 1 GB free. `docker builder prune` and `docker image prune` reclaim old layers.                                                                                                           |
| Data looks lost after a restart                                                 | Check `docker volume ls` for `zqhoot_zqdata`; `docker compose down -v` deletes volumes, plain `down` does not. Restore from a backup.                                                                          |
