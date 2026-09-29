#!/usr/bin/env bash
# Builds and deploys the serverless target (infra/terraform/envs/aws-serverless).
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/deploy-aws.sh [options]

Deploys zqhoot to AWS (Lambda, API Gateway, DynamoDB, Cognito, S3, CloudFront):
  1. scripts/aws-preflight.sh (Lambda concurrency check)
  2. pnpm install --frozen-lockfile, then builds the Lambda packages and the web app
  3. terraform init and apply in infra/terraform/envs/aws-serverless
  4. syncs apps/web/dist to the site bucket: new hashed assets first, then index.html and the
     other root files (never touches config.json, which Terraform owns). Previous builds'
     hashed assets are kept so open sessions and cached pages keep working during a deploy.
  5. invalidates /index.html and /config.json on CloudFront
  6. prints the site URL and the next steps

Options:
  --region REGION     AWS Region (also passed to Terraform as -var region=REGION).
                      Default: whatever Terraform would use (terraform.tfvars, TF_VAR_region,
                      else us-east-1). The preflight checks that same Region.
  --var-file FILE     Extra Terraform variable file. terraform.tfvars in the environment
                      directory is loaded automatically.
  --auto-approve      Do not ask before terraform apply. Without it Terraform shows the plan
                      and waits for a typed "yes".
  --skip-preflight    Skip step 1.
  --skip-build        Skip step 2 (use the packages and web build already on disk).
  -h, --help          Show this help.

Run it from anywhere; it changes to the repository root. Needs the AWS CLI v2, Terraform
1.10 or later, Node 22+ and pnpm. See infra/terraform/README.md.
EOF
}

region=""
var_file=""
auto_approve=0
skip_preflight=0
skip_build=0

while [ "$#" -gt 0 ]; do
  case "$1" in
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
    --auto-approve)
      auto_approve=1
      shift
      ;;
    --skip-preflight)
      skip_preflight=1
      shift
      ;;
    --skip-build)
      skip_build=1
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

if [ -n "$var_file" ]; then
  [ -f "$var_file" ] || {
    echo "ERROR: --var-file $var_file does not exist" >&2
    exit 1
  }
  var_file="$(cd "$(dirname "$var_file")" && pwd)/$(basename "$var_file")"
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

tf_dir="infra/terraform/envs/aws-serverless"
tf() { terraform -chdir="$tf_dir" "$@"; }

for tool in terraform aws; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "ERROR: $tool is not installed or not on PATH" >&2
    exit 1
  }
done
if [ "$skip_build" -eq 0 ]; then
  command -v pnpm >/dev/null 2>&1 || {
    echo "ERROR: pnpm is not installed or not on PATH" >&2
    exit 1
  }
fi

step() { printf '\n==> %s\n' "$*"; }

# Arguments shared by every terraform command that reads variables.
tf_var_args=()
if [ -n "$region" ]; then
  tf_var_args+=(-var "region=$region")
fi
if [ -n "$var_file" ]; then
  tf_var_args+=("-var-file=$var_file")
fi

# Ask Terraform which Region it will really use (terraform.tfvars, -var, TF_VAR_region, default),
# so the preflight checks the Region that is about to be deployed to. Needs no credentials.
tf init -input=false >/dev/null
region="$(printf 'var.region\n' | tf console -no-color ${tf_var_args[@]+"${tf_var_args[@]}"} | tr -d '"')"
[ -n "$region" ] || {
  echo "ERROR: could not determine the Terraform region variable" >&2
  exit 1
}

if [ "$skip_preflight" -eq 0 ]; then
  step "1/6 Preflight ($region)"
  scripts/aws-preflight.sh "$region"
else
  step "1/6 Preflight skipped"
fi

if [ "$skip_build" -eq 0 ]; then
  step "2/6 Build"
  pnpm install --frozen-lockfile
  pnpm --filter @zqhoot/server-lambda build
  pnpm --filter @zqhoot/web build
else
  step "2/6 Build skipped"
fi

for artifact in apps/server-lambda/dist/ws.zip apps/server-lambda/dist/http.zip apps/web/dist/index.html; do
  [ -f "$artifact" ] || {
    echo "ERROR: $artifact is missing; the build did not produce it." >&2
    exit 1
  }
done

step "3/6 Terraform apply ($tf_dir)"
apply_args=()
if [ "$auto_approve" -eq 1 ]; then
  apply_args+=(-auto-approve)
fi
tf apply ${tf_var_args[@]+"${tf_var_args[@]}"} ${apply_args[@]+"${apply_args[@]}"}

bucket="$(tf output -raw site_bucket_name)"
distribution_id="$(tf output -raw distribution_id)"
site_url="$(tf output -raw site_url)"
user_pool_id="$(tf output -raw cognito_user_pool_id)"

step "4/6 Sync web app to s3://$bucket"
# Order matters for anyone connected during the deploy: new hashed assets first, then everything
# else (index.html above all), then the invalidation in step 5. A tab still running the previous
# build keeps lazy-loading its old chunks, and a viewer served the old (edge-cached) index.html
# asks for the old asset names, so the previous build's assets must still be there. That is why
# assets/ is synced WITHOUT --delete: old hashed files stay (a few hundred KB per deploy, the
# names are unique so they never collide). scripts/destroy-aws.sh empties the bucket; to prune
# old assets by hand, do it well after the deploy (see infra/terraform/README.md).
#
# Hashed assets never change under the same name, so cache them for a year. Everything else,
# above all index.html, is revalidated on every request. The second sync uses --delete so root
# files removed from the build disappear; assets/ (kept, see above) and config.json (Terraform
# owns it) are excluded from it, and --exclude also protects them from --delete.
if [ -d apps/web/dist/assets ]; then
  aws s3 sync apps/web/dist/assets "s3://$bucket/assets" --region "$region" \
    --cache-control "public, max-age=31536000, immutable"
else
  echo "warning: apps/web/dist/assets does not exist; skipping the assets sync" >&2
fi
aws s3 sync apps/web/dist "s3://$bucket" --region "$region" --delete \
  --exclude "assets/*" --exclude "config.json" \
  --cache-control "no-cache"

step "5/6 Invalidate CloudFront"
aws cloudfront create-invalidation --distribution-id "$distribution_id" \
  --paths /index.html /config.json --query 'Invalidation.Id' --output text

step "6/6 Done"
cat <<EOF
Site:     $site_url
Hosts:    $site_url/host
Players:  $site_url/join

Next: create a host account (Cognito emails a temporary password; self sign-up is off unless
you enabled it). Skip this if you set initial_admin_email.

  aws cognito-idp admin-create-user --region $region --user-pool-id $user_pool_id \\
    --username you@example.com \\
    --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true \\
    --desired-delivery-mediums EMAIL

Then open $site_url/host and sign in. Tear everything down with scripts/destroy-aws.sh.
EOF
