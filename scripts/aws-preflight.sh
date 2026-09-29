#!/usr/bin/env bash
# Checks that an AWS account and Region can carry a 400-player session before you deploy.
set -euo pipefail

# Below this, a 400-answer burst is throttled. See the explanation printed on failure.
MIN_CONCURRENCY=100

usage() {
  cat <<'EOF'
Usage: scripts/aws-preflight.sh [region]

Checks, read-only:
  1. The AWS CLI is installed and has working credentials.
  2. Lambda "Concurrent executions" (aws lambda get-account-settings) is at least 100,
     which a 400-player answer burst needs. New accounts are sometimes limited to 10.
     If it is lower, the script prints the Service Quotas command that requests an increase.
  3. Informational: the API Gateway WebSocket connection-rate quota, if Service Quotas lists it.

Quotas are found by name in the applied quotas (list-service-quotas), then in the AWS default
quotas (list-aws-default-service-quotas) for those still at their default and so not applied.

region defaults to $AWS_REGION, then $AWS_DEFAULT_REGION, then the AWS CLI's configured
region, then us-east-1.

Exit status: 0 when the account is 400-ready, 1 when it is not or a check could not run.
Needs IAM permissions for sts:GetCallerIdentity, lambda:GetAccountSettings and
servicequotas:ListServiceQuotas and servicequotas:ListAWSDefaultServiceQuotas.
EOF
}

case "${1:-}" in
  -h | --help)
    usage
    exit 0
    ;;
  -*)
    echo "unknown option: $1" >&2
    usage >&2
    exit 2
    ;;
esac

if ! command -v aws >/dev/null 2>&1; then
  echo "ERROR: the AWS CLI (v2) is not installed or not on PATH." >&2
  echo "       https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html" >&2
  exit 1
fi

region="${1:-${AWS_REGION:-${AWS_DEFAULT_REGION:-}}}"
if [ -z "$region" ]; then
  region="$(aws configure get region 2>/dev/null || true)"
fi
region="${region:-us-east-1}"

if ! account="$(aws sts get-caller-identity --region "$region" --query Account --output text 2>&1)"; then
  echo "ERROR: the AWS CLI has no working credentials:" >&2
  echo "       $account" >&2
  echo "       Configure them (aws configure, aws sso login, or AWS_PROFILE) and retry." >&2
  exit 1
fi
echo "Account $account, Region $region"

if ! limit="$(aws lambda get-account-settings --region "$region" \
  --query 'AccountLimit.ConcurrentExecutions' --output text 2>&1)"; then
  echo "ERROR: could not read the Lambda account settings:" >&2
  echo "       $limit" >&2
  exit 1
fi
case "$limit" in
  '' | *[!0-9]*)
    echo "ERROR: unexpected Lambda concurrency value: $limit" >&2
    exit 1
    ;;
esac

# Prints "name<TAB>value<TAB>code" for every quota of a service. list-service-quotas returns only
# quotas that have an applied value in this account, so quotas that are still at their AWS default
# can be missing from it. Those come from list-aws-default-service-quotas, appended after the
# applied rows; awk keeps the first row for each name, so an applied value wins over the default.
# Empty output means neither call worked (no permission, or the service is unknown).
quota_rows() {
  local service="$1"
  {
    aws service-quotas list-service-quotas --service-code "$service" --region "$region" \
      --query 'Quotas[].[QuotaName,Value,QuotaCode]' --output text 2>/dev/null || true
    aws service-quotas list-aws-default-service-quotas --service-code "$service" --region "$region" \
      --query 'Quotas[].[QuotaName,Value,QuotaCode]' --output text 2>/dev/null || true
  } | awk -F'\t' 'NF >= 3 && !seen[$1]++'
}

ready=1
if [ "$limit" -lt "$MIN_CONCURRENCY" ]; then
  ready=0
  # Looked up by name: quota codes are not something to hard-code. The awk reads all its input
  # (no early exit) so the pipeline never dies of SIGPIPE under pipefail.
  quota_code="$(quota_rows lambda |
    awk -F'\t' '!found && $1 == "Concurrent executions" { print $3; found = 1 }' || true)"

  cat >&2 <<EOF
ERROR: Lambda concurrent executions in $region is $limit; a 400-player session needs at least $MIN_CONCURRENCY.

  Why: when the host opens a question, up to 400 phones answer within about 2 seconds. At about
  50 ms per answer that needs roughly 20 concurrent executions, and Lambda serves about 10
  requests per second per unit of concurrency. A limit of 10 therefore caps a function at
  roughly 100 requests per second, and the rest of the burst is throttled. New AWS accounts
  can start with a limit as low as 10; AWS raises it automatically as the account is used.

  Fix: request an increase (service code lambda, quota "Concurrent executions") and wait for
  it to be applied before the first real session:
EOF
  case "$quota_code" in
    '' | None)
      cat >&2 <<EOF

    # Neither the applied nor the default Service Quotas list showed "Concurrent executions"
    # (or access was denied). Find the quota code yourself; a quota still at its AWS default is
    # only in the second list:
    aws service-quotas list-service-quotas --service-code lambda --region $region \\
      --query 'Quotas[].[QuotaName,QuotaCode,Value]' --output table
    aws service-quotas list-aws-default-service-quotas --service-code lambda --region $region \\
      --query 'Quotas[].[QuotaName,QuotaCode,Value]' --output table
    # then:
    aws service-quotas request-service-quota-increase --service-code lambda \\
      --quota-code <QuotaCode> --desired-value 1000 --region $region
EOF
      ;;
    *)
      cat >&2 <<EOF

    aws service-quotas request-service-quota-increase --service-code lambda \\
      --quota-code $quota_code --desired-value 1000 --region $region

  Check the request with:

    aws service-quotas list-requested-service-quota-change-history-by-quota \\
      --service-code lambda --quota-code $quota_code --region $region
EOF
      ;;
  esac
  echo >&2
fi

echo
echo "API Gateway WebSocket connection quotas (informational):"
ws_quotas="$(quota_rows apigateway | grep -i 'websocket' | grep -i 'connect' || true)"
if [ -n "$ws_quotas" ]; then
  while IFS=$'\t' read -r qname qvalue qcode; do
    echo "  $qname: $qvalue ($qcode)"
  done <<EOF
$ws_quotas
EOF
  echo "  The new-connection burst cannot be raised: two 400-player lobbies opening in the same"
  echo "  second may see refused connections. Phones reconnect with jittered backoff."
else
  echo "  Service Quotas lists no WebSocket connection quota here (or access was denied)."
fi

echo
if [ "$ready" -eq 1 ]; then
  echo "OK: Lambda concurrency is $limit (>= $MIN_CONCURRENCY). This account is 400-ready."
  exit 0
fi
echo "NOT 400-ready: Lambda concurrency is $limit (< $MIN_CONCURRENCY)." >&2
exit 1
