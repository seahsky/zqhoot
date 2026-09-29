#!/usr/bin/env bash
# Checks every Terraform directory without touching AWS: terraform fmt, init -backend=false and
# validate for each module and environment, the offline terraform tests, a guard against
# always-on paid resources in the serverless stack, then tflint over the whole tree.
# Needs no credentials. Exits non-zero if any check fails.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: infra/terraform/validate.sh [--skip-tests] [--skip-tflint] [--help]

Runs, in order:
  1. terraform fmt -check -recursive
  2. terraform init -backend=false and terraform validate in every directory under
     modules/ and envs/ (the first init creates a git-ignored .terraform.lock.hcl there)
  3. terraform test in every directory that has a tests/ folder. The tests use a mocked AWS
     provider, so they need neither credentials nor network access.
  4. A grep guard: the serverless stack (the modules it uses plus envs/aws-serverless) must
     not declare NAT gateways, VPCs, KMS keys, Secrets Manager, WAF, Route 53 zones,
     provisioned concurrency, API caching or Elastic IPs (ADR-0012: nothing always-on).
  5. tflint --recursive with infra/terraform/.tflint.hcl

Options:
  --skip-tests    Skip step 3.
  --skip-tflint   Skip step 5 (for machines without tflint).
  --help          Show this help.

Exit status is 0 only if every step passed.
EOF
}

# Without a shared cache, init unpacks the ~800 MB AWS provider into every directory it checks.
export TF_PLUGIN_CACHE_DIR="${TF_PLUGIN_CACHE_DIR:-$HOME/.terraform.d/plugin-cache}"
mkdir -p "$TF_PLUGIN_CACHE_DIR"

skip_tests=0
skip_tflint=0
for arg in "$@"; do
  case "$arg" in
    --skip-tests) skip_tests=1 ;;
    --skip-tflint) skip_tflint=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
failed=()

run() {
  local label="$1"
  shift
  echo "--- $label"
  if ! "$@"; then
    failed+=("$label")
  fi
}

# Like run, but shows the command's output only when it fails (terraform init is very chatty).
run_quiet() {
  local label="$1" out
  shift
  echo "--- $label"
  if ! out=$("$@" 2>&1); then
    printf '%s\n' "$out"
    failed+=("$label")
  fi
}

serverless_dirs=(
  modules/data modules/auth modules/http-api modules/realtime-ws modules/static-site
  envs/aws-serverless
)
fixed_fee_pattern='resource +"(aws_nat_gateway|aws_vpc|aws_eip|aws_kms_key|aws_kms_alias|aws_secretsmanager_[a-z_]+|aws_wafv2_[a-z_]+|aws_waf_[a-z_]+|aws_route53_zone|aws_lambda_provisioned_concurrency_config)"|provisioned_concurrent_executions|cache_cluster_enabled|kms_key_id|kms_key_arn|kms_master_key_id|aws:kms'

guard_fixed_fees() {
  local hits
  hits="$(cd "$root" && grep -rEn --include='*.tf' --exclude-dir=.terraform "$fixed_fee_pattern" "${serverless_dirs[@]}" || true)"
  if [ -n "$hits" ]; then
    echo "always-on paid resources are not allowed in the serverless stack (ADR-0012):" >&2
    printf '%s\n' "$hits" >&2
    return 1
  fi
}

run "terraform fmt -check" terraform -chdir="$root" fmt -check -recursive

for dir in "$root"/modules/* "$root"/envs/*; do
  [ -d "$dir" ] || continue
  name="${dir#"$root"/}"
  run_quiet "init $name" terraform -chdir="$dir" init -backend=false -input=false -no-color
  run "validate $name" terraform -chdir="$dir" validate -no-color
done

if [ "$skip_tests" -eq 0 ]; then
  for dir in "$root"/modules/* "$root"/envs/*; do
    [ -d "$dir/tests" ] || continue
    name="${dir#"$root"/}"
    run "test $name" terraform -chdir="$dir" test -no-color
  done
fi

run "no always-on paid resources in the serverless stack" guard_fixed_fees

if [ "$skip_tflint" -eq 0 ]; then
  run "tflint" bash -c 'cd "$1" && tflint --recursive --config "$1/.tflint.hcl"' _ "$root"
fi

echo
if [ "${#failed[@]}" -gt 0 ]; then
  echo "FAILED (${#failed[@]}):" >&2
  printf '  %s\n' "${failed[@]}" >&2
  exit 1
fi
echo "OK: every check passed for every module and environment."
