#!/usr/bin/env bash
# Runs the k6 load test (load/zqhoot.js) against a target started on this machine.
#
#   load/run-local.sh node               single-process Node server, the VM target
#   load/run-local.sh lambda-emulator    built Lambda handlers behind the local API Gateway
#                                        emulator and DynamoDB Local (:8000, started here when it
#                                        is not already answering and /opt/dynamodb-local exists)
#
# Everything the run needs is created and removed by the script: a temporary data directory (or a
# uniquely named DynamoDB table, and DynamoDB Local itself if this script started it), free ports,
# the server process and a 1 Hz CPU/RSS sampler. Test
# parameters come from the environment (ZQ_PLAYERS, ZQ_QUESTIONS, ZQ_RECONNECT_RATIO, ZQ_SEED,
# ...; see load/README.md). Results land in load/results/. The exit status is k6's: 99 means a
# gate (join success, answer acceptance) was missed.

set -euo pipefail

TARGET="${1:-}"
case "$TARGET" in
  node | lambda-emulator) ;;
  *)
    echo "usage: $0 node|lambda-emulator" >&2
    exit 2
    ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOAD="$ROOT/load"
K6="${K6:-k6}"
command -v "$K6" >/dev/null || { echo "k6 not found (set K6=/path/to/k6, see load/README.md)" >&2; exit 2; }
command -v node >/dev/null || { echo "node not found" >&2; exit 2; }

# ZQ_RUN_LABEL keeps runs with non-default parameters apart in load/results/.
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$TARGET${ZQ_RUN_LABEL:+-$ZQ_RUN_LABEL}"
RESULTS="$LOAD/results"
RAW="$RESULTS/raw"
mkdir -p "$RAW"
SERVER_LOG="$RAW/$RUN_ID-server.log"
K6_LOG="$RAW/$RUN_ID-k6.log"
CSV="$RESULTS/$RUN_ID-resources.csv"
JSON="$RESULTS/$RUN_ID.json"

# Extra flags for the server's node process, e.g. --cpu-prof (see tools/analyze-cpuprofile.js).
# Deliberately unquoted where it is used, so several flags split into several arguments.
SERVER_NODE_ARGS="${ZQ_SERVER_NODE_ARGS:-}"

# Loopback only, so these fixed values protect nothing and are never reused elsewhere.
PASSWORD="load-test-password"
JWT_SECRET="load-test-jwt-secret-0123456789-0123456789-0123456789"

SERVER_PID=""
SAMPLER_PID=""
K6_PID=""
DDB_LOCAL_PID=""
DATA_DIR=""
TABLE=""
DDB_ENDPOINT=""

free_port() {
  node -e "const s = require('node:net').createServer(); s.listen(0, '127.0.0.1', () => { console.log(s.address().port); s.close(); });"
}

wait_for() {
  local url="$1" pid="$2" tries=120
  # A stalled request must count as one failed try, or the try limit never triggers.
  until curl -sf --connect-timeout 1 --max-time 2 "$url" >/dev/null 2>&1; do
    kill -0 "$pid" 2>/dev/null || { echo "server exited early, see $SERVER_LOG" >&2; return 1; }
    tries=$((tries - 1))
    [ "$tries" -gt 0 ] || { echo "server did not become ready at $url" >&2; return 1; }
    sleep 0.5
  done
}

ddb_up() {
  curl -s --connect-timeout 1 --max-time 3 "$DDB_ENDPOINT" >/dev/null 2>&1
}

# Starts DynamoDB Local in memory, as packages/store/README.md does, when the endpoint is a local
# port and the jar is installed (ZQ_DDB_LOCAL_DIR, default /opt/dynamodb-local). Only an instance
# started here is stopped afterwards; one that was already running is left alone.
start_dynamodb_local() {
  local dir="${ZQ_DDB_LOCAL_DIR:-/opt/dynamodb-local}" port tries=60
  [[ "$DDB_ENDPOINT" =~ ^http://(localhost|127\.0\.0\.1):([0-9]+)/?$ ]] || return 1
  port="${BASH_REMATCH[2]}"
  [ -f "$dir/DynamoDBLocal.jar" ] || return 1
  command -v java >/dev/null || return 1
  echo "== starting DynamoDB Local on port $port (in memory, from $dir)"
  (cd "$dir" && exec java -Djava.library.path=./DynamoDBLocal_lib -jar DynamoDBLocal.jar \
    -inMemory -port "$port") >"$RAW/$RUN_ID-dynamodb-local.log" 2>&1 &
  DDB_LOCAL_PID=$!
  until ddb_up; do
    if ! kill -0 "$DDB_LOCAL_PID" 2>/dev/null; then
      DDB_LOCAL_PID=""
      return 1
    fi
    tries=$((tries - 1))
    [ "$tries" -gt 0 ] || return 1
    sleep 0.5
  done
}

stop_server() {
  [ -n "$SERVER_PID" ] || return 0
  kill -TERM "$SERVER_PID" 2>/dev/null || true
  for _ in $(seq 1 60); do
    kill -0 "$SERVER_PID" 2>/dev/null || break
    sleep 0.25
  done
  kill -KILL "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  SERVER_PID=""
}

cleanup() {
  if [ -n "$SAMPLER_PID" ]; then
    kill -TERM "$SAMPLER_PID" 2>/dev/null || true
    wait "$SAMPLER_PID" 2>/dev/null || true
    SAMPLER_PID=""
  fi
  if [ -n "$K6_PID" ] && kill -0 "$K6_PID" 2>/dev/null; then kill -TERM "$K6_PID" 2>/dev/null || true; fi
  stop_server
  [ -z "$DATA_DIR" ] || rm -rf "$DATA_DIR"
  if [ -n "$TABLE" ]; then
    # Only this run's table; DynamoDB Local is shared with other work.
    (cd "$ROOT/apps/server-lambda" &&
      AWS_ACCESS_KEY_ID=emulator AWS_SECRET_ACCESS_KEY=emulator AWS_REGION=us-east-1 \
        ZQ_TABLE_NAME="$TABLE" ZQ_DDB_ENDPOINT="$DDB_ENDPOINT" node --input-type=module -e "
          import { DynamoDBClient, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
          await new DynamoDBClient({ endpoint: process.env.ZQ_DDB_ENDPOINT })
            .send(new DeleteTableCommand({ TableName: process.env.ZQ_TABLE_NAME }));
        ") >/dev/null 2>&1 || echo "note: table $TABLE was not deleted" >&2
  fi
  if [ -n "$DDB_LOCAL_PID" ]; then
    kill -TERM "$DDB_LOCAL_PID" 2>/dev/null || true
    wait "$DDB_LOCAL_PID" 2>/dev/null || true
    DDB_LOCAL_PID=""
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# 400 players are 400 sockets in the server and 400 in k6, plus keep-alive sockets to DynamoDB.
want=65536
hard="$(ulimit -Hn)"
if [ "$hard" != "unlimited" ] && [ "$hard" -lt "$want" ]; then want="$hard"; fi
ulimit -n "$want" 2>/dev/null || true
if [ "$(ulimit -n)" -lt 4096 ]; then
  echo "warning: open file limit is $(ulimit -n); a 400-player run needs about 2000" >&2
fi

case "$TARGET" in
  node)
    echo "== building the Node server"
    pnpm --dir "$ROOT" --filter @zqhoot/server-node build >/dev/null
    PORT="$(free_port)"
    DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/zqhoot-load-XXXXXX")"
    echo "== starting the Node server on 127.0.0.1:$PORT (data in $DATA_DIR)"
    ZQ_PORT="$PORT" ZQ_HOST=127.0.0.1 ZQ_PUBLIC_URL="http://127.0.0.1:$PORT" \
      ZQ_DATA_DIR="$DATA_DIR" ZQ_ADMIN_USER=admin ZQ_ADMIN_PASSWORD="$PASSWORD" \
      ZQ_JWT_SECRET="$JWT_SECRET" ZQ_LOG_LEVEL="${ZQ_LOG_LEVEL:-info}" \
      node $SERVER_NODE_ARGS --enable-source-maps "$ROOT/apps/server-node/dist/server.mjs" >"$SERVER_LOG" 2>&1 &
    SERVER_PID=$!
    wait_for "http://127.0.0.1:$PORT/api/health" "$SERVER_PID"
    export ZQ_BASE_URL="http://127.0.0.1:$PORT" ZQ_WS_URL="ws://127.0.0.1:$PORT/ws"
    export ZQ_ORIGIN="http://127.0.0.1:$PORT"
    DDB_PID=""
    ;;
  lambda-emulator)
    DDB_ENDPOINT="${ZQ_DDB_ENDPOINT:-http://localhost:8000}"
    ddb_up || start_dynamodb_local || {
      echo "DynamoDB Local is not answering on $DDB_ENDPOINT and could not be started here" >&2
      echo "(start it as in packages/store/README.md, or set ZQ_DDB_ENDPOINT / ZQ_DDB_LOCAL_DIR)" >&2
      exit 2
    }
    echo "== building the Lambda handlers and the emulator"
    pnpm --dir "$ROOT" --filter @zqhoot/server-lambda build >/dev/null
    HTTP_PORT="$(free_port)"
    WS_PORT="$(free_port)"
    MGMT_PORT="$(free_port)"
    TABLE="zqhoot-load-${RUN_ID//[^A-Za-z0-9]/-}"
    echo "== starting the emulator (http $HTTP_PORT, ws $WS_PORT, table $TABLE)"
    ZQ_EMU_HOST=127.0.0.1 ZQ_EMU_PUBLIC_HOST=127.0.0.1 ZQ_EMU_HTTP_PORT="$HTTP_PORT" \
      ZQ_EMU_WS_PORT="$WS_PORT" ZQ_EMU_MGMT_PORT="$MGMT_PORT" ZQ_TABLE_NAME="$TABLE" \
      ZQ_DDB_ENDPOINT="$DDB_ENDPOINT" ZQ_ADMIN_USER=admin ZQ_ADMIN_PASSWORD="$PASSWORD" \
      ZQ_JWT_SECRET="$JWT_SECRET" ZQ_LOG_LEVEL="${ZQ_LOG_LEVEL:-info}" \
      node $SERVER_NODE_ARGS --enable-source-maps "$ROOT/apps/server-lambda/dist/emulator/main.mjs" >"$SERVER_LOG" 2>&1 &
    SERVER_PID=$!
    wait_for "http://127.0.0.1:$HTTP_PORT/api/health" "$SERVER_PID"
    export ZQ_BASE_URL="http://127.0.0.1:$HTTP_PORT" ZQ_WS_URL="ws://127.0.0.1:$WS_PORT"
    export ZQ_ORIGIN="http://127.0.0.1:$HTTP_PORT"
    # DynamoDB Local is a separate process the test leans on; sample it too.
    DDB_PID="${DDB_LOCAL_PID:-$(pgrep -f DynamoDBLocal | head -n 1 || true)}"
    ;;
esac

export ZQ_TARGET="$TARGET" ZQ_RUN_ID="$RUN_ID" ZQ_AUTH_MODE=local ZQ_USERNAME=admin
export ZQ_PASSWORD="$PASSWORD" ZQ_RESULTS_DIR="$RESULTS"
COMMIT="$(git -C "$ROOT" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
if ! git -C "$ROOT" diff --quiet HEAD -- . ':!load/results' 2>/dev/null; then COMMIT="$COMMIT-dirty"; fi
export ZQ_COMMIT="$COMMIT"
export ZQ_MACHINE="$(nproc) CPUs ($(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | xargs)), $(awk '/MemTotal/ { printf "%.0f GB RAM", $2 / 1048576 }' /proc/meminfo), $(uname -sr), node $(node --version)"

LOADAVG_BEFORE="$(cut -d" " -f1-4 /proc/loadavg)"
echo "== load average before: $LOADAVG_BEFORE"
echo "== running k6 (run $RUN_ID, log $K6_LOG)"
"$K6" run --quiet "$LOAD/zqhoot.js" >"$K6_LOG" 2>&1 &
K6_PID=$!

SAMPLE_ARGS=(--out "$CSV" --proc "server=$SERVER_PID" --proc "k6=$K6_PID")
[ -z "${DDB_PID:-}" ] || SAMPLE_ARGS+=(--proc "dynamodb-local=$DDB_PID")
node "$LOAD/tools/sample.js" "${SAMPLE_ARGS[@]}" &
SAMPLER_PID=$!

# Show k6's output as it is written; tail stops when k6 does.
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

echo "== load average after: $LOADAVG_AFTER"
node "$LOAD/tools/summarize-resources.js" "$CSV" "$JSON" \
  --loadavg-before "$LOADAVG_BEFORE" --loadavg-after "$LOADAVG_AFTER" || true
# The repository formats committed JSON with prettier; do the same so `pnpm format:check` passes.
pnpm --dir "$ROOT" exec prettier --write "$JSON" >/dev/null 2>&1 || true

stop_server
echo "== results: ${JSON#"$ROOT"/}"
case "$K6_STATUS" in
  0) echo "== gates met" ;;
  99) echo "== a gate was missed (exit 99), see the table above" ;;
  *) echo "== k6 exited with status $K6_STATUS" ;;
esac
exit "$K6_STATUS"
