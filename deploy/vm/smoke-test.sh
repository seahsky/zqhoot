#!/usr/bin/env bash
# End-to-end smoke test of the VM stack (Caddy + app) in plain-HTTP mode. It never touches a real
# deployment: it uses its own Compose project, volumes and a generated .env in a temp directory,
# listens on 127.0.0.1 only and removes everything afterwards.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: deploy/vm/smoke-test.sh [options]

Builds the image (unless --image is given), starts the Compose stack with ZQ_TLS_MODE=http on
127.0.0.1 and checks it through Caddy:

  1. the Caddyfile validates in all four TLS modes (acme, files, internal, http)
  2. the stack becomes healthy; the app runs as a non-root user on a read-only root filesystem, and
     its image has no npm, corepack, yarn or node_modules
  3. GET /api/health, /config.json and / respond, with the security headers of ADR-0013; static
     assets are compressed
  4. log in, create a quiz and a session over the API; API responses are not compressed
  5. a host and a player connect over WebSocket, the player joins, a foreign Origin is refused
  6. restart the app: the quiz, the session and the player's token are still valid
  7. tear everything down

Options:
  --keep         Leave the stack running afterwards and print how to reach and remove it.
  --image IMAGE  Use an image that already exists locally instead of building one.
  -h, --help     Show this help.

Environment:
  ZQ_SMOKE_HTTP_PORT   Host port for Caddy. Default: a free port.
  ZQ_BUILD_CA_FILE     PEM file with the CA of a TLS-intercepting egress proxy, given to the image
                       build as the secret "cacert". Default: NODE_EXTRA_CA_CERTS or SSL_CERT_FILE,
                       but only when HTTPS_PROXY is set.
  HTTPS_PROXY          When set, passed to the image build; a loopback proxy also switches the build
                       to host networking. See "Building behind a proxy" in deploy/vm/README.md.

Needs: Docker with Compose v2 and BuildKit, curl, openssl and Node 22 or newer.
EOF
}

keep=0
image=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --keep)
      keep=1
      shift
      ;;
    --image)
      [ "$#" -ge 2 ] || {
        echo "--image needs a value" >&2
        exit 2
      }
      image="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"

step() { printf '\n[%s] %s\n' "$1" "$2"; }
ok() { printf '  ok  %s\n' "$1"; }
die() {
  printf '  FAIL %s\n' "$1" >&2
  exit 1
}

for tool in docker curl openssl node; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed or not on PATH"
done
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 ('docker compose') is required"
node -e 'process.exit(typeof WebSocket === "function" && typeof fetch === "function" ? 0 : 1)' ||
  die "Node 22 or newer is required (global WebSocket)"

free_port() {
  node -e 'const s = require("node:net").createServer().listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); })'
}

http_port="${ZQ_SMOKE_HTTP_PORT:-$(free_port)}"
https_port="$(free_port)"
suffix="$$-$(date +%s)"
project="zqhoot-smoke-$suffix"
tmp="$(mktemp -d)"
built_image=0
if [ -z "$image" ]; then
  image="zqhoot-smoke:$suffix"
  built_image=1
fi
origin="http://localhost:$http_port"
base="$origin"

export ZQ_ENV_FILE="$tmp/.env"
export ZQ_IMAGE="$image"
export ZQ_BIND_ADDRESS=127.0.0.1
dc() {
  docker compose -p "$project" --env-file "$tmp/.env" -f "$script_dir/docker-compose.yml" "$@"
}
# curl must reach localhost directly even where a proxy is configured for everything else.
http() { curl --noproxy '*' -sS --max-time 15 "$@"; }

password="$(openssl rand -hex 16)"
write_env() {
  # $1: the password hash. Single quotes keep the $ in it from being expanded.
  umask 077
  cat >"$tmp/.env" <<EOF
ZQ_DOMAIN=localhost
ZQ_TLS_MODE=http
ZQ_PUBLIC_URL=$origin
ZQ_HTTP_PORT=$http_port
ZQ_HTTPS_PORT=$https_port
ZQ_ADMIN_USER=admin
ZQ_ADMIN_PASSWORD_HASH='$1'
ZQ_JWT_SECRET=$(openssl rand -base64 48)
EOF
}

cleanup() {
  status=$?
  trap - EXIT
  if [ "$status" -ne 0 ]; then
    echo >&2
    echo "The smoke test failed. State of the stack:" >&2
    dc ps -a >&2 || true
    dc logs --no-color --tail=40 >&2 || true
  fi
  if [ "$keep" -eq 1 ] && [ "$status" -eq 0 ]; then
    cat <<EOF

Stack left running (--keep).
  Open:      $origin   (log in as admin, password: $password)
  Logs:      docker compose -p $project --env-file $tmp/.env -f $script_dir/docker-compose.yml logs -f
  Remove:    ZQ_ENV_FILE=$tmp/.env ZQ_IMAGE=$image docker compose -p $project --env-file $tmp/.env -f $script_dir/docker-compose.yml down -v
             rm -r $tmp
EOF
  else
    dc down -v --remove-orphans >/dev/null 2>&1 || true
    if [ "$built_image" -eq 1 ]; then docker rmi "$image" >/dev/null 2>&1 || true; fi
    rm -rf "$tmp"
  fi
  exit "$status"
}
trap cleanup EXIT

write_env 'CHANGE_ME'

if [ "$built_image" -eq 1 ]; then
  step 1/8 "Build the image $image"
  build_flags=()
  proxy="${HTTPS_PROXY:-${https_proxy:-}}"
  if [ -n "$proxy" ]; then
    build_flags+=(--build-arg "HTTPS_PROXY=$proxy")
    no_proxy_list="${NO_PROXY:-${no_proxy:-}}"
    if [ -n "$no_proxy_list" ]; then build_flags+=(--build-arg "NO_PROXY=$no_proxy_list"); fi
    # A proxy on the host's loopback is only reachable from the build with host networking.
    case "$proxy" in
      *://localhost[:/]* | *://127.* | *://\[::1\]*) build_flags+=(--network host) ;;
    esac
    ca_file="${ZQ_BUILD_CA_FILE:-${NODE_EXTRA_CA_CERTS:-${SSL_CERT_FILE:-}}}"
    if [ -n "$ca_file" ] && [ -f "$ca_file" ]; then
      build_flags+=(--secret "id=cacert,src=$ca_file")
    fi
  elif [ -n "${ZQ_BUILD_CA_FILE:-}" ]; then
    build_flags+=(--secret "id=cacert,src=$ZQ_BUILD_CA_FILE")
  fi
  if ! DOCKER_BUILDKIT=1 docker build ${build_flags[@]+"${build_flags[@]}"} -t "$image" "$repo_root" \
    >"$tmp/build.log" 2>&1; then
    tail -n 40 "$tmp/build.log" >&2
    die "image build failed"
  fi
  ok "image built"
else
  step 1/8 "Use the existing image $image"
  docker image inspect "$image" >/dev/null 2>&1 || die "image $image does not exist locally"
  ok "image found"
fi

step 2/8 "Caddyfile validates in every TLS mode"
# The files mode reads its certificate while validating, so give it a throwaway one.
mkdir "$tmp/certs"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=quiz.example.com \
  -keyout "$tmp/certs/key.pem" -out "$tmp/certs/cert.pem" >/dev/null 2>&1
validate_caddy() {
  docker run --rm -v "$script_dir/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$tmp/certs:/certs:ro" \
    -e ZQ_DOMAIN=quiz.example.com -e "ZQ_TLS_MODE=$1" -e ZQ_ACME_EMAIL=ops@example.com \
    caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile >"$tmp/validate.log" 2>&1
}
for mode in acme files internal http; do
  validate_caddy "$mode" || {
    tail -n 5 "$tmp/validate.log" >&2
    die "the Caddyfile does not validate in $mode mode"
  }
  ok "mode $mode"
done
if validate_caddy nonsense; then die "the Caddyfile accepts an unknown ZQ_TLS_MODE"; fi
ok "an unknown mode is rejected"

step 3/8 "Generate a .env in $tmp"
hash="$(printf '%s' "$password" | dc run --rm -T app node hash-password.mjs)" ||
  die "docker compose run app node hash-password.mjs failed"
case "$hash" in
  'scrypt$'*) ok "hash-password printed a scrypt hash" ;;
  *) die "hash-password printed something unexpected: $hash" ;;
esac
write_env "$hash"
ok ".env written (mode 600, random JWT secret and password)"

step 4/8 "Start the stack (ZQ_TLS_MODE=http, 127.0.0.1:$http_port)"
dc up -d --no-build || die "docker compose up failed"
app_container="$(dc ps -q app)"
for _ in $(seq 1 60); do
  health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$app_container")"
  [ "$health" = healthy ] && break
  sleep 2
done
[ "${health:-}" = healthy ] || die "the app container is not healthy (status: ${health:-unknown})"
ok "the app container is healthy"
for _ in $(seq 1 30); do
  http -o /dev/null -f "$base/api/health" 2>/dev/null && break
  sleep 1
done
http -o /dev/null -f "$base/api/health" || die "Caddy does not proxy /api/health on $base"
ok "Caddy answers on $base"

step 5/8 "Container hardening"
uid="$(dc exec -T app id -u)"
[ "$uid" != 0 ] || die "the app runs as root"
ok "the app runs as uid $uid"
[ "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$app_container")" = true ] ||
  die "the app's root filesystem is not read-only"
# /home/node belongs to the node user, so only the read-only root filesystem can stop this write.
if dc exec -T app touch /home/node/write-test 2>/dev/null; then
  die "the app could write to its home directory"
fi
dc exec -T app sh -c 'touch /data/write-test && rm /data/write-test' >/dev/null 2>&1 ||
  die "the app cannot write to /data"
ok "read-only root filesystem, writable /data"
# The image holds the bundle and the web app only. The base image's package managers are removed, and
# with them the only node_modules folder (the server has no dependencies at run time). Looking for
# server.mjs too shows that the search works: it must be the only hit.
found="$(dc exec -T app find / -xdev -name server.mjs \
  -o -name node_modules -o -name npm -o -name npx -o -name corepack -o -name 'yarn*' 2>/dev/null || true)"
[ "$found" = /app/server.mjs ] ||
  die "the image has a package manager or node_modules (expected only /app/server.mjs): $found"
ok "no npm, npx, corepack, yarn or node_modules in the image"
caps="$(docker inspect -f '{{len .HostConfig.CapAdd}} {{.HostConfig.CapDrop}}' "$app_container")"
[ "$caps" = "0 [ALL]" ] || die "unexpected capabilities on the app: $caps"
ok "all capabilities dropped"
if docker port "$app_container" 2>/dev/null | grep -q .; then die "the app publishes a port"; fi
ok "the app publishes no port; only Caddy does"

step 6/8 "GET /api/health, /config.json and / through Caddy"
health_body="$(http "$base/api/health")"
case "$health_body" in
  *'"ok":true'*'"target":"vm"'*) ok "/api/health: $health_body" ;;
  *) die "/api/health answered: $health_body" ;;
esac
config_body="$(http "$base/config.json")"
case "$config_body" in
  *'"target":"vm"'*"\"wsUrl\":\"ws://localhost:$http_port/ws\""*) ok "/config.json names ws://localhost:$http_port/ws" ;;
  *) die "/config.json answered: $config_body" ;;
esac
headers="$tmp/root.headers"
root_status="$(http -D "$headers" -o "$tmp/root.body" -w '%{http_code}' "$base/")"
[ "$root_status" = 200 ] || die "GET / answered $root_status"
grep -qi '^content-type: text/html' "$headers" || die "GET / is not text/html"
grep -qi '<html' "$tmp/root.body" || die "GET / did not return an HTML document"
ok "GET / returns the web app's index.html"
grep -qi '^x-content-type-options: nosniff' "$headers" || die "missing X-Content-Type-Options"
grep -qi '^referrer-policy: strict-origin-when-cross-origin' "$headers" || die "missing Referrer-Policy"
grep -qi '^permissions-policy: camera=()' "$headers" || die "missing Permissions-Policy"
grep -qi "^content-security-policy: default-src 'self'" "$headers" || die "missing Content-Security-Policy"
ok "security headers present"
if grep -qi '^strict-transport-security' "$headers"; then die "HSTS is sent in http mode"; fi
if grep -qi '^server:' "$headers"; then die "a Server header is sent"; fi
if grep -qi '^via:' "$headers"; then die "a Via header is sent"; fi
ok "no HSTS in http mode, no Server or Via header"
# Compression is Caddy's job. Any script or stylesheet the page references will do.
asset="$(grep -oE '/assets/[^"]+\.(js|css)' "$tmp/root.body" | head -n 1 || true)"
if [ -n "$asset" ]; then
  http -H 'Accept-Encoding: zstd, gzip' -D "$tmp/asset.headers" -o /dev/null "$base$asset"
  grep -qiE '^content-encoding: (zstd|gzip)' "$tmp/asset.headers" || die "$asset is not compressed"
  ok "$asset is compressed by Caddy"
fi
if [ "$(http -o /dev/null -w '%{http_code}' "$base/definitely/not/a/file.txt")" != 404 ]; then
  die "a missing file with an extension is not a 404"
fi
ok "a missing file is a 404"

step 7/8 "API and WebSocket through Caddy"
export ZQ_SMOKE_BASE="$base" ZQ_SMOKE_ORIGIN="$origin" ZQ_SMOKE_USER=admin ZQ_SMOKE_PASSWORD="$password"
export ZQ_SMOKE_STATE="$tmp/state.json"
node "$script_dir/smoke-client.mjs" play || die "the API/WebSocket checks failed"

step 8/8 "Restart the app: state must survive"
dc restart app >/dev/null || die "docker compose restart failed"
for _ in $(seq 1 60); do
  health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$app_container")"
  [ "$health" = healthy ] && break
  sleep 2
done
[ "${health:-}" = healthy ] || die "the app is not healthy after the restart (status: ${health:-unknown})"
for _ in $(seq 1 30); do
  http -o /dev/null -f "$base/api/health" 2>/dev/null && break
  sleep 1
done
node "$script_dir/smoke-client.mjs" resume || die "the state did not survive the restart"

echo
echo "PASS: the VM stack works end to end in http mode."
