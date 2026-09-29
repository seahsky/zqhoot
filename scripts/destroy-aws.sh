#!/usr/bin/env bash
# Tears down a zqhoot deployment. Destructive: asks for confirmation unless --yes is given.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/destroy-aws.sh [options]

Permanently destroys a deployment created from infra/terraform/envs/:

  aws-serverless (default)
    1. empties the site and media buckets (uploaded quiz images cannot be recovered)
    2. terraform destroy: DynamoDB table (all quizzes and sessions), Cognito user pool (all
       host accounts), CloudFront, API Gateways, Lambda functions, log groups
  aws-vm
    1. deletes the SSM parameters under /zqhoot/{name}/ (the VM's environment and secrets)
    2. terraform destroy: the instance and its disk (all game data), Elastic IP, security group

Before anything is deleted the script lists what will go and asks you to type "destroy".

Options:
  --env NAME     aws-serverless (default) or aws-vm.
  --region R     AWS Region (also passed to Terraform as -var region=R).
                 Default: whatever Terraform would use for that environment.
  --var-file F   Extra Terraform variable file, when you deployed with one.
  --yes          Skip the confirmation prompt (for automation).
  -h, --help     Show this help.

Deletion protection: if the table or user pool has deletion_protection on, set it to false
and run terraform apply first; the destroy stops at that resource otherwise.
EOF
}

env_name="aws-serverless"
region=""
var_file=""
assume_yes=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --env)
      [ "$#" -ge 2 ] || {
        echo "--env needs a value" >&2
        exit 2
      }
      env_name="$2"
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
    --var-file)
      [ "$#" -ge 2 ] || {
        echo "--var-file needs a value" >&2
        exit 2
      }
      var_file="$2"
      shift 2
      ;;
    --yes)
      assume_yes=1
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

case "$env_name" in
  aws-serverless | aws-vm) ;;
  *)
    echo "ERROR: --env must be aws-serverless or aws-vm, not $env_name" >&2
    exit 2
    ;;
esac

if [ -n "$var_file" ]; then
  [ -f "$var_file" ] || {
    echo "ERROR: --var-file $var_file does not exist" >&2
    exit 1
  }
  var_file="$(cd "$(dirname "$var_file")" && pwd)/$(basename "$var_file")"
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

tf_dir="infra/terraform/envs/$env_name"
tf() { terraform -chdir="$tf_dir" "$@"; }

for tool in terraform aws; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "ERROR: $tool is not installed or not on PATH" >&2
    exit 1
  }
done

tf_var_args=()
if [ -n "$region" ]; then
  tf_var_args+=(-var "region=$region")
fi
if [ -n "$var_file" ]; then
  tf_var_args+=("-var-file=$var_file")
fi

tf init -input=false >/dev/null
region="$(printf 'var.region\n' | tf console -no-color ${tf_var_args[@]+"${tf_var_args[@]}"} | tr -d '"')"
[ -n "$region" ] || {
  echo "ERROR: could not determine the Terraform region variable" >&2
  exit 1
}

# Outputs only exist once something has been applied. Without them the pre-cleanup is skipped and
# terraform destroy reports what is left.
output_or_empty() { tf output -raw "$1" 2>/dev/null || true; }

site_bucket=""
media_bucket=""
ssm_path=""
if [ "$env_name" = "aws-serverless" ]; then
  site_bucket="$(output_or_empty site_bucket_name)"
  media_bucket="$(output_or_empty media_bucket_name)"
else
  ssm_path="$(output_or_empty ssm_parameter_path)"
fi

echo "About to PERMANENTLY DESTROY the $env_name deployment in $region:"
if [ "$env_name" = "aws-serverless" ]; then
  echo "  - every object in s3://${site_bucket:-<no site bucket in state>} (the web app)"
  echo "  - every object in s3://${media_bucket:-<no media bucket in state>} (uploaded quiz images: not recoverable)"
  echo "  - the DynamoDB table (all quizzes and sessions), the Cognito user pool (all host accounts),"
  echo "    CloudFront, both API Gateways, both Lambda functions and their log groups"
else
  echo "  - every SSM parameter under ${ssm_path:-<no parameter path in state>}/ (the VM's environment and secrets)"
  echo "  - the EC2 instance and its disk (all live game data), the Elastic IP and the security group"
fi

if [ "$assume_yes" -ne 1 ]; then
  if [ ! -t 0 ]; then
    echo "ERROR: not running interactively; pass --yes to confirm." >&2
    exit 1
  fi
  printf 'Type "destroy" to continue: '
  read -r answer
  if [ "$answer" != "destroy" ]; then
    echo "Aborted; nothing was deleted."
    exit 1
  fi
fi

if [ "$env_name" = "aws-serverless" ]; then
  # Neither bucket has versioning, so removing the current objects empties it.
  for bucket in "$site_bucket" "$media_bucket"; do
    if [ -n "$bucket" ]; then
      echo "Emptying s3://$bucket"
      aws s3 rm "s3://$bucket" --recursive --region "$region" --only-show-errors
    fi
  done
elif [ -n "$ssm_path" ]; then
  echo "Deleting SSM parameters under $ssm_path/"
  names="$(aws ssm get-parameters-by-path --path "$ssm_path" --recursive --region "$region" \
    --query 'Parameters[].Name' --output text)"
  if [ -n "$names" ]; then
    # delete-parameters takes at most 10 names per call.
    # shellcheck disable=SC2086
    printf '%s\n' $names | xargs -n 10 aws ssm delete-parameters --region "$region" --query 'DeletedParameters' --output text --names
  fi
fi

# Confirmed above, so do not make the operator confirm twice.
tf destroy -auto-approve ${tf_var_args[@]+"${tf_var_args[@]}"}
echo "Destroyed the $env_name deployment."
