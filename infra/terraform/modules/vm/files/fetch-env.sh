#!/bin/bash
# Installed as /usr/local/sbin/zqhoot-fetch-env and run by zqhoot.service before every start.
#
# Waits until the operator has published the app's environment (scripts/vm-put-secrets.sh writes
# every key as a SecureString under $ZQ_SSM_PATH, then the _READY marker last), then renders it to
# deploy/vm/.env. The instance role is the only credential; nothing secret is in user_data.
set -euo pipefail

# shellcheck disable=SC1091
. /etc/zqhoot/vm.conf
export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION"

env_file="$ZQ_APP_DIR/deploy/vm/.env"
ready="$ZQ_SSM_PATH/_READY"
deadline=$(($(date +%s) + ${ZQ_WAIT_SECONDS:-3600}))

until err=$(aws ssm get-parameter --name "$ready" --query Parameter.Name --output text 2>&1 >/dev/null); do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "gave up waiting for $ready: $err" >&2
    exit 1
  fi
  echo "waiting for $ready (publish the environment with scripts/vm-put-secrets.sh): $err"
  sleep 15
done

mkdir -p "$(dirname "$env_file")"
# Same directory as the target so the final mv is atomic; mktemp creates the file with mode 600.
tmp=$(mktemp "$env_file.XXXXXX")
trap 'rm -f "$tmp"' EXIT

# Compose treats an unquoted $ in .env as interpolation, and the scrypt hash format contains
# several, so every value is single-quoted. Single quotes cannot be escaped inside single quotes,
# so a value that contains one (or a newline) is rejected instead of silently mangled.
aws ssm get-parameters-by-path --path "$ZQ_SSM_PATH" --recursive --with-decryption --output json |
  jq -r --arg prefix "$ZQ_SSM_PATH/" --arg q "'" '
    .Parameters[]
    | (.Name | ltrimstr($prefix)) as $key
    | select($key != "_READY")
    | if ($key | test("^[A-Za-z_][A-Za-z0-9_]*$") | not) then error("unsupported parameter name: " + .Name)
      elif (.Value | (contains($q) or contains("\n") or contains("\r"))) then error("value of " + $key + " contains a single quote or newline")
      else $key + "=" + $q + .Value + $q
      end
  ' >"$tmp"

if [ -n "${ZQ_DOMAIN:-}" ] && ! grep -q '^ZQ_DOMAIN=' "$tmp"; then
  printf "ZQ_DOMAIN='%s'\n" "$ZQ_DOMAIN" >>"$tmp"
fi

chmod 600 "$tmp"
mv "$tmp" "$env_file"
trap - EXIT
echo "wrote $env_file ($(wc -l <"$env_file") variables)"
