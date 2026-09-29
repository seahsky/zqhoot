variable "region" {
  description = "AWS Region. us-east-1 has the highest API Gateway throttle defaults (ARCHITECTURE.md, choice 8)."
  type        = string
  default     = "us-east-1"
}

variable "name" {
  description = "Deployment name: prefix of every resource and the DynamoDB table name. Use a different name for each deployment in the same account: IAM roles and CloudFront helper resources are account-wide."
  type        = string
  default     = "zqhoot"
}

variable "lambda_ws_zip" {
  description = "Path to the ws function package, relative to this directory (or to the -chdir directory). Built by pnpm --filter @zqhoot/server-lambda build."
  type        = string
  default     = "../../../../apps/server-lambda/dist/ws.zip"
}

variable "lambda_http_zip" {
  description = "Path to the http function package, relative to this directory (or to the -chdir directory). Built by pnpm --filter @zqhoot/server-lambda build."
  type        = string
  default     = "../../../../apps/server-lambda/dist/http.zip"
}

variable "warm_concurrency" {
  description = "How many ws function instances the http function warms when a lobby opens (ADR-0010)."
  type        = number
  default     = 4

  validation {
    condition     = var.warm_concurrency >= 0 && var.warm_concurrency <= 50 && floor(var.warm_concurrency) == var.warm_concurrency
    error_message = "warm_concurrency must be a whole number between 0 and 50."
  }
}

variable "session_ttl_days" {
  description = "Days a live session's data is kept before DynamoDB expires it. This is also the CSV export window."
  type        = number
  default     = 30

  validation {
    condition     = var.session_ttl_days >= 1 && floor(var.session_ttl_days) == var.session_ttl_days
    error_message = "session_ttl_days must be a whole number of days, at least 1."
  }
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for both functions."
  type        = number
  default     = 14
}

variable "custom_domain" {
  description = "Optional custom domain for the site (for example quiz.example.com). Needs acm_certificate_arn and a CNAME you create yourself: this stack has no Route 53 zone, which would cost a fixed monthly fee."
  type        = string
  default     = null
}

variable "acm_certificate_arn" {
  description = "ARN of an ACM certificate in us-east-1 covering custom_domain. Required when custom_domain is set."
  type        = string
  default     = null
}

variable "price_class" {
  description = "CloudFront price class."
  type        = string
  default     = "PriceClass_100"
}

variable "initial_admin_email" {
  description = "Optional email address of a first host account. Cognito emails it a temporary password, so no password is stored in state."
  type        = string
  default     = null
}

variable "cognito_domain_prefix" {
  description = "Prefix of the Cognito hosted domain. Null generates {name}-{random}, because the prefix must be unique across the Region."
  type        = string
  default     = null
}

variable "allow_self_signup" {
  description = "Let anyone create a host account. Off by default: operators create hosts with the AWS CLI."
  type        = bool
  default     = false
}

variable "deletion_protection" {
  description = "Protect the DynamoDB table and the Cognito user pool from deletion. Turn it off (and apply) before destroying."
  type        = bool
  default     = false
}

variable "point_in_time_recovery" {
  description = "Enable DynamoDB point-in-time recovery. Live-session data expires after session_ttl_days, so it is off by default."
  type        = bool
  default     = false
}
