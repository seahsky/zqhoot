variable "name" {
  description = "Deployment name. The function and API are named {name}-http."
  type        = string
}

variable "lambda_zip" {
  description = "Path to the deployment package (zip with index.mjs exporting handler). Resolved relative to the directory Terraform runs in."
  type        = string
}

variable "memory_size" {
  description = "Function memory in MB. More memory also buys CPU, which shortens cold starts (ADR-0010)."
  type        = number
  default     = 512
}

variable "timeout" {
  description = "Function timeout in seconds."
  type        = number
  default     = 10
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

variable "allowed_origins" {
  description = "Origins the browser may call this API from (CORS allow_origins): the site URL, or its custom domain URLs. Exact origins (scheme and host), no trailing slash, no wildcard."
  type        = list(string)

  validation {
    condition     = length(var.allowed_origins) > 0
    error_message = "allowed_origins needs at least one origin: without CORS the browser cannot call the API."
  }

  validation {
    condition     = alltrue([for o in var.allowed_origins : can(regex("^https?://[^/*?#\\s]+$", o))])
    error_message = "Every allowed origin must be an exact origin such as https://quiz.example.com: scheme and host, no path, no trailing slash, no wildcard."
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

variable "gsi_arn" {
  description = "ARN of the table's gsi1 index."
  type        = string
}

variable "media_bucket_name" {
  description = "Media bucket name (ZQ_MEDIA_BUCKET)."
  type        = string
}

variable "media_bucket_arn" {
  description = "ARN of the media bucket; the function may only put objects under media/."
  type        = string
}

variable "ws_function_name" {
  description = "Name of the WebSocket function, invoked for warm-up (ZQ_WS_FUNCTION_NAME)."
  type        = string
}

variable "ws_function_arn" {
  description = "ARN of the WebSocket function, the only function this one may invoke."
  type        = string
}

variable "warm_concurrency" {
  description = "How many WebSocket function instances to warm when a lobby opens (ZQ_WARM_CONCURRENCY)."
  type        = number
  default     = 4
}

variable "throttle_burst_limit" {
  description = "API stage default route burst limit (ADR-0013)."
  type        = number
  default     = 400
}

variable "throttle_rate_limit" {
  description = "API stage default route steady-state limit in requests per second (ADR-0013)."
  type        = number
  default     = 200
}
