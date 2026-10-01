provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project    = "zqhoot"
      Deployment = var.name
      ManagedBy  = "terraform"
    }
  }
}

# Cognito domain prefixes are unique per Region across all accounts, so default to a random suffix.
resource "random_string" "cognito_domain" {
  length  = 8
  upper   = false
  special = false
}

locals {
  cognito_domain_prefix = coalesce(var.cognito_domain_prefix, "${var.name}-${random_string.cognito_domain.result}")

  # https://{custom domain or *.cloudfront.net}, no trailing slash.
  #
  # The dependency chain is acyclic at the resource level only: CloudFront needs the HTTP API's
  # host, the WebSocket URL and the Cognito domain, all of which come from resources that do not
  # depend on the site URL. The Lambda functions and the Cognito app client do, and they are not
  # inputs to CloudFront. In particular the HTTP API resource has no CORS configuration (the http
  # function answers CORS itself, from ZQ_SITE_ORIGIN), so it does not need the site URL and the
  # CSP can name its exact host.
  site_origin = module.static_site.site_url

  # https://{api id}.execute-api.{region}.amazonaws.com: the CSP's connect-src entry and the web
  # app's apiBaseUrl (it appends /api/...).
  api_origin = trimsuffix(module.http_api.api_endpoint, "/")

  lambda_environment = {
    ZQ_SITE_ORIGIN          = local.site_origin
    ZQ_COGNITO_USER_POOL_ID = module.auth.user_pool_id
    ZQ_COGNITO_CLIENT_ID    = module.auth.client_id
    ZQ_SESSION_TTL_DAYS     = tostring(var.session_ttl_days)
  }
}

module "data" {
  source = "../../modules/data"

  name                   = var.name
  site_origins           = [local.site_origin]
  point_in_time_recovery = var.point_in_time_recovery
  deletion_protection    = var.deletion_protection
}

module "auth" {
  source = "../../modules/auth"

  name                = var.name
  domain_prefix       = local.cognito_domain_prefix
  callback_urls       = ["${local.site_origin}/host"]
  logout_urls         = ["${local.site_origin}/host"]
  allow_self_signup   = var.allow_self_signup
  deletion_protection = var.deletion_protection
  initial_admin_email = var.initial_admin_email
}

module "realtime_ws" {
  source = "../../modules/realtime-ws"

  name               = var.name
  lambda_zip         = var.lambda_ws_zip
  log_retention_days = var.log_retention_days
  table_name         = module.data.table_name
  table_arn          = module.data.table_arn
  environment        = local.lambda_environment
}

module "http_api" {
  source = "../../modules/http-api"

  name               = var.name
  lambda_zip         = var.lambda_http_zip
  log_retention_days = var.log_retention_days
  table_name         = module.data.table_name
  table_arn          = module.data.table_arn
  gsi_arn            = module.data.gsi_arn
  media_bucket_name  = module.data.media_bucket_name
  media_bucket_arn   = module.data.media_bucket_arn
  ws_function_name   = module.realtime_ws.function_name
  ws_function_arn    = module.realtime_ws.function_arn
  warm_concurrency   = var.warm_concurrency
  environment        = local.lambda_environment
}

module "static_site" {
  source = "../../modules/static-site"

  name                              = var.name
  api_origin                        = local.api_origin
  media_bucket_id                   = module.data.media_bucket_name
  media_bucket_arn                  = module.data.media_bucket_arn
  media_bucket_regional_domain_name = module.data.media_bucket_regional_domain_name
  ws_url                            = module.realtime_ws.wss_url
  cognito_domain                    = module.auth.hosted_domain_url
  price_class                       = var.price_class
  aliases                           = var.custom_domain == null ? [] : [var.custom_domain]
  acm_certificate_arn               = var.acm_certificate_arn
}

# Public, non-secret runtime configuration; the shape is RuntimeConfig in packages/protocol/src/config.ts.
# Kept out of the web build so one build works for any deployment. scripts/deploy-aws.sh syncs the
# rest of the site with --exclude config.json, so this object is only ever written by Terraform.
resource "aws_s3_object" "config" {
  bucket        = module.static_site.site_bucket_name
  key           = "config.json"
  content_type  = "application/json"
  cache_control = "no-cache"

  content = jsonencode({
    target       = "aws"
    apiBaseUrl   = local.api_origin
    wsUrl        = module.realtime_ws.wss_url
    mediaBaseUrl = "${local.site_origin}/"
    joinUrl      = "${local.site_origin}/join"
    auth = {
      mode       = "cognito"
      region     = var.region
      userPoolId = module.auth.user_pool_id
      clientId   = module.auth.client_id
      domain     = module.auth.hosted_domain_url
    }
  })
}
