variable "name" {
  description = "Deployment name. The function and API are named {name}-ws."
  type        = string
}

variable "lambda_zip" {
  description = "Path to the deployment package (zip with index.mjs exporting handler). Resolved relative to the directory Terraform runs in."
  type        = string
}

variable "memory_size" {
  description = "Function memory in MB. More memory also buys CPU, which shortens cold starts and fan-out (ADR-0010)."
  type        = number
  default     = 512
}

variable "timeout" {
  description = "Function timeout in seconds. Longer than the http function because a broadcast fans out over PostToConnection."
  type        = number
  default     = 30
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention of the function's log group."
  type        = number
  default     = 14

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_days)
    error_message = "log_retention_days must be a retention period CloudWatch Logs accepts (1, 3, 5, 7, 14, 30, 60, 90, ...)."
  }
}

variable "environment" {
  description = "Extra environment variables (ZQ_SITE_ORIGIN, Cognito IDs, ...). Merged over the defaults; the values wired by this module always win."
  type        = map(string)
  default     = {}
}

variable "table_name" {
  description = "DynamoDB table name (ZQ_TABLE_NAME)."
  type        = string
}

variable "table_arn" {
  description = "ARN of the DynamoDB table the function may read and write."
  type        = string
}

variable "stage_name" {
  description = "WebSocket API stage name; it becomes the first path segment of the wss:// URL."
  type        = string
  default     = "live"

  validation {
    condition     = can(regex("^[A-Za-z0-9_-]+$", var.stage_name))
    error_message = "stage_name may only contain letters, digits, hyphens and underscores."
  }
}

variable "throttle_burst_limit" {
  description = "Stage default route burst limit (ADR-0013)."
  type        = number
  default     = 1000
}

variable "throttle_rate_limit" {
  description = "Stage default route steady-state limit in messages per second (ADR-0013)."
  type        = number
  default     = 2000
}

variable "enable_access_logs" {
  description = "Write API Gateway access logs (no IP address, no query string, ADR-0009). Off by default. API Gateway also needs an account-level CloudWatch Logs role (aws_api_gateway_account), which this module does not manage."
  type        = bool
  default     = false
}
