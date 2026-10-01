#!/usr/bin/env bash
# Runs the k6 load test (load/zqhoot.js) against a zqhoot stack deployed on AWS.
#
#   ZQ_HOST_TOKEN=<Cognito ID token> load/run-aws.sh <site-url> <ws-url> [<api-url>] [--yes] [--dry-run]
#
#   site-url  The site as browsers see it, no path: https://d1234abcd.cloudfront.net or your
#             custom domain. Sent as the WebSocket Origin, which API Gateway's $connect compares
#             with ZQ_SITE_ORIGIN, so it must be exactly that value.
#   ws-url    The WebSocket API endpoint, wss://{id}.execute-api.{region}.amazonaws.com/{stage}.
#   api-url   The HTTP API base (`apiBaseUrl` in config.json). Default: read from the site's
#             /config.json.
#
# The token is a Cognito ID token of a host, valid for the whole run (the app client issues them
# for one hour; a default run takes about six minutes). It is read from the environment so it
# never appears in a process list or in shell history. Two ways to get one:
#
#   1. Sign in to the deployed site as a host, open the browser's developer tools, Network tab,
#      and copy the value after `Bearer ` from the Authorization header of any /api request
#      (the app sends the ID token, ADR-0009).
#   2. `aws cognito-idp initiate-auth` returns one, but only if the operator has added
#      ALLOW_USER_PASSWORD_AUTH to the app client's explicit_auth_flows (the Terraform module
#      allows only SRP and refresh tokens, so this is an opt-in change):
#        export ZQ_HOST_TOKEN=$(aws cognito-idp initiate-auth --auth-flow USER_PASSWORD_AUTH \
#          --client-id <app client id> --auth-parameters USERNAME=<email>,PASSWORD=<password> \
#          --query AuthenticationResult.IdToken --output text)
#
# What it does to your account: creates one quiz and one session under the token's host, opens
# about 400 WebSocket connections, sends about 5,000 messages and receives about 17,000 through
# API Gateway, Lambda and DynamoDB (a default run; RESULTS.md has the counts). Nothing is deleted
# afterwards; the session expires by TTL.
# Without --yes it asks first. --dry-run prints the command and stops.
#
# Run it from a machine close to the Region (an EC2 instance there is best), or the network
# path adds to every latency. Broadcast latency compares this machine's clock with API Gateway's
# and the Lambda's, so it carries their clock skew; keep both NTP-synced and read millisecond
# figures with that error in mind. See load/README.md.

set -euo pipefail

usage() {
  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//' >&2
  exit 2
}

SITE="" WS="" API="" YES=0 DRY=0
for arg in "$@"; do
  case "$arg" in
    --yes) YES=1 ;;
    --dry-run) DRY=1 ;;
    -h | --help) usage ;;
    -*) echo "unknown option $arg" >&2; usage ;;
    *)
      if [ -z "$SITE" ]; then SITE="$arg"
      elif [ -z "$WS" ]; then WS="$arg"
      elif [ -z "$API" ]; then API="$arg"
      else usage; fi
      ;;
  esac
done
[ -n "$SITE" ] && [ -n "$WS" ] || usage
case "$WS" in wss://* | ws://*) ;; *) echo "ws-url must start with wss://" >&2; exit 2 ;; esac
[ -n "${ZQ_HOST_TOKEN:-}" ] || { echo "ZQ_HOST_TOKEN is not set (see the header of this script)" >&2; exit 2; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOAD="$ROOT/load"
K6="${K6:-k6}"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-aws"
RESULTS="$LOAD/results"
PLAYERS="${ZQ_PLAYERS:-400}"
QUESTIONS="${ZQ_QUESTIONS:-10}"

export ZQ_TARGET=aws ZQ_RUN_ID="$RUN_ID" ZQ_AUTH_MODE=token ZQ_RESULTS_DIR="$RESULTS"
export ZQ_BASE_URL="${SITE%/}" ZQ_WS_URL="$WS"
[ -z "$API" ] || export ZQ_API_URL="${API%/}"
COMMIT="$(git -C "$ROOT" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
if ! git -C "$ROOT" diff --quiet HEAD -- . ':!load/results' 2>/dev/null; then COMMIT="$COMMIT-dirty"; fi
export ZQ_COMMIT="$COMMIT"
export ZQ_MACHINE="$(nproc) CPUs, $(awk '/MemTotal/ { printf "%.0f GB RAM", $2 / 1048576 }' /proc/meminfo), $(uname -sr)"

cat >&2 <<EOF
Target
  site      $ZQ_BASE_URL
  websocket $ZQ_WS_URL
  api       ${ZQ_API_URL:-(from $ZQ_BASE_URL/config.json)}
Load
  $PLAYERS players, $QUESTIONS questions, reconnect ratio ${ZQ_RECONNECT_RATIO:-0.1}, run $RUN_ID
EOF

if [ "$DRY" = 1 ]; then
  echo "dry run: would run  $K6 run $LOAD/zqhoot.js  (ZQ_HOST_TOKEN is set, not shown)" >&2
  exit 0
fi

command -v "$K6" >/dev/null || { echo "k6 not found (set K6=/path/to/k6, see load/README.md)" >&2; exit 2; }
if [ "$YES" != 1 ]; then
  read -r -p "This creates a quiz and a session in that account and opens $PLAYERS connections. Continue? [y/N] " answer
  case "$answer" in y | Y | yes) ;; *) echo "not started" >&2; exit 1 ;; esac
fi

want=65536
hard="$(ulimit -Hn)"
if [ "$hard" != "unlimited" ] && [ "$hard" -lt "$want" ]; then want="$hard"; fi
ulimit -n "$want" 2>/dev/null || true

mkdir -p "$RESULTS/raw"
K6_LOG="$RESULTS/raw/$RUN_ID-k6.log"
CSV="$RESULTS/$RUN_ID-resources.csv"
JSON="$RESULTS/$RUN_ID.json"

SAMPLER_PID=""
K6_PID=""
cleanup() {
  [ -z "$SAMPLER_PID" ] || { kill -TERM "$SAMPLER_PID" 2>/dev/null || true; wait "$SAMPLER_PID" 2>/dev/null || true; }
  if [ -n "$K6_PID" ] && kill -0 "$K6_PID" 2>/dev/null; then kill -TERM "$K6_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

LOADAVG_BEFORE="$(cut -d" " -f1-4 /proc/loadavg)"
"$K6" run --quiet "$LOAD/zqhoot.js" >"$K6_LOG" 2>&1 &
K6_PID=$!
node "$LOAD/tools/sample.js" --out "$CSV" --proc "k6=$K6_PID" &
SAMPLER_PID=$!
tail -n +1 -f --pid="$K6_PID" "$K6_LOG" &
TAIL_PID=$!

K6_STATUS=0
wait "$K6_PID" || K6_STATUS=$?
wait "$TAIL_PID" 2>/dev/null || true
LOADAVG_AFTER="$(cut -d" " -f1-4 /proc/loadavg)"
K6_PID=""
kill -TERM "$SAMPLER_PID" 2>/dev/null || true
wait "$SAMPLER_PID" 2>/dev/null || true
SAMPLER_PID=""

node "$LOAD/tools/summarize-resources.js" "$CSV" "$JSON" \
  --loadavg-before "$LOADAVG_BEFORE" --loadavg-after "$LOADAVG_AFTER" || true
# The repository formats committed JSON with prettier; do the same so `pnpm format:check` passes.
pnpm --dir "$ROOT" exec prettier --write "$JSON" >/dev/null 2>&1 || true
echo "results: ${JSON#"$ROOT"/} (k6 exit status $K6_STATUS; 99 means a gate was missed)"
exit "$K6_STATUS"
