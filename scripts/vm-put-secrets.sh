#!/usr/bin/env bash
# Publishes the VM's environment file to SSM Parameter Store as SecureStrings.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/vm-put-secrets.sh [options]

Reads a local .env file and writes every KEY=value to SSM Parameter Store as
/zqhoot/{name}/{KEY}, type SecureString, standard tier, encrypted with the AWS-managed
alias/aws/ssm key (no monthly fee). The aws-vm instance reads them with its instance role and
renders deploy/vm/.env from them. Values never pass through Terraform, state or user_data.

A marker parameter /zqhoot/{name}/_READY is written last; the VM waits for it, so it never
starts from a half-written environment.

Options:
  --name NAME       Deployment name, the same as the aws-vm "name" variable. Default: zqhoot.
  --region REGION   AWS Region. Default: $AWS_REGION, then $AWS_DEFAULT_REGION, then the AWS
                    CLI's configured region, then us-east-1.
  --env-file FILE   Source file. Default: deploy/vm/.env in the repository.
  --dry-run         Print which parameters would be written (never their values) and stop.
  -h, --help        Show this help.

.env format: KEY=value per line; blank lines and # comments are skipped; an optional "export "
prefix and one pair of surrounding quotes are removed. Wrap values that contain $ in single
quotes (for example the scrypt hash). Values must not contain a single quote or a newline.

Running it again overwrites existing values (SSM keeps the previous versions in the parameter
history). Keys you delete from the file are not deleted from SSM. To apply changes to a running
VM, restart the service: sudo systemctl restart zqhoot (over aws ssm start-session).
EOF
}

name="zqhoot"
region=""
env_file=""
dry_run=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --name)
      [ "$#" -ge 2 ] || {
        echo "--name needs a value" >&2
        exit 2
      }
      name="$2"
      shift 2
      ;;
    --region)
      [ "$#" -ge 2 ] || {
        echo "--region needs a value" >&2
        exit 2
      }
      region="$2"
      shift 2
      ;;
    --env-file)
      [ "$#" -ge 2 ] || {
        echo "--env-file needs a value" >&2
        exit 2
      }
      env_file="$2"
      shift 2
      ;;
    --dry-run)
      dry_run=1
      shift
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

case "$name" in
  [a-z]*) ;;
  *)
    echo "ERROR: --name must start with a lowercase letter" >&2
    exit 2
    ;;
esac
case "$name" in
  *[!a-z0-9-]*)
    echo "ERROR: --name may only contain lowercase letters, digits and hyphens" >&2
    exit 2
    ;;
esac

if [ -z "$env_file" ]; then
  env_file="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/deploy/vm/.env"
fi
[ -f "$env_file" ] || {
  echo "ERROR: env file not found: $env_file" >&2
  exit 1
}

if [ "$dry_run" -eq 0 ]; then
  command -v aws >/dev/null 2>&1 || {
    echo "ERROR: the AWS CLI (v2) is not installed or not on PATH" >&2
    exit 1
  }
fi
if [ -z "$region" ]; then
  region="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
fi
if [ -z "$region" ] && command -v aws >/dev/null 2>&1; then
  region="$(aws configure get region 2>/dev/null || true)"
fi
region="${region:-us-east-1}"

path="/zqhoot/$name"

# Values go to the AWS CLI as file:// references into a private (mode 700) temp directory rather
# than as arguments, so they do not show up in the process list.
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

keys=()
line_no=0
while IFS= read -r line || [ -n "$line" ]; do
  line_no=$((line_no + 1))
  line="${line%$'\r'}"

  # Trim leading whitespace, skip blanks and comments.
  line="${line#"${line%%[![:space:]]*}"}"
  case "$line" in
    '' | '#'*) continue ;;
  esac
  line="${line#export }"

  if [[ ! "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
    echo "ERROR: $env_file:$line_no is not KEY=value" >&2
    exit 1
  fi
  key="${BASH_REMATCH[1]}"
  value="${BASH_REMATCH[2]}"

  if [ "$key" = "_READY" ]; then
    echo "ERROR: $env_file:$line_no uses the reserved name _READY" >&2
    exit 1
  fi

  if [[ "$value" =~ ^\"(.*)\"[[:space:]]*$ ]] || [[ "$value" =~ ^\'(.*)\'[[:space:]]*$ ]]; then
    value="${BASH_REMATCH[1]}"
  else
    # Unquoted: drop a trailing " # comment" and surrounding whitespace, like dotenv parsers do.
    if [[ "$value" =~ ^(.*[^[:space:]])[[:space:]]+#.*$ ]]; then
      value="${BASH_REMATCH[1]}"
    fi
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
  fi

  if [ -z "$value" ]; then
    echo "warning: $key has an empty value; skipped (SSM does not store empty parameters)" >&2
    continue
  fi
  case "$value" in
    *\'*)
      echo "ERROR: the value of $key contains a single quote, which the VM's .env cannot represent" >&2
      exit 1
      ;;
  esac

  printf '%s' "$value" >"$tmp_dir/$key"
  # A repeated key keeps the last value, as in a dotenv file.
  already=0
  for existing in ${keys[@]+"${keys[@]}"}; do
    if [ "$existing" = "$key" ]; then
      already=1
    fi
  done
  if [ "$already" -eq 0 ]; then
    keys+=("$key")
  fi
done <"$env_file"

if [ "${#keys[@]}" -eq 0 ]; then
  echo "ERROR: no KEY=value entries found in $env_file" >&2
  exit 1
fi

echo "Target: $path/ in $region (SecureString, standard tier, key alias/aws/ssm)"
for key in "${keys[@]}"; do
  echo "  $path/$key"
done

if [ "$dry_run" -eq 1 ]; then
  echo "Dry run: nothing was written."
  exit 0
fi

for key in "${keys[@]}"; do
  aws ssm put-parameter --region "$region" --name "$path/$key" --type SecureString \
    --tier Standard --overwrite --value "file://$tmp_dir/$key" >/dev/null
  echo "wrote $key"
done

aws ssm put-parameter --region "$region" --name "$path/_READY" --type String \
  --tier Standard --overwrite --value "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >/dev/null
echo "wrote _READY"
echo "Done. A waiting VM starts the stack within about a minute."
