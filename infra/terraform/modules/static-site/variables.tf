variable "name" {
  description = "Deployment name. Used as the prefix of the site bucket and of the CloudFront helper resources."
  type        = string
}

variable "api_origin" {
  description = "CSP source expression for the HTTP API, added to connect-src: the browser calls the API directly, not through CloudFront. The environment passes a Region-wide execute-api wildcard, because the API's exact host cannot be an input here: the API's CORS allow-list needs this distribution's domain, so the two would depend on each other."
  type        = string

  validation {
    condition     = can(regex("^https://[^/\\s;,]+$", var.api_origin))
    error_message = "api_origin must be an https:// host source without a path, such as https://*.execute-api.us-east-1.amazonaws.com."
  }
}

variable "media_bucket_id" {
  description = "ID of the media bucket, served under /media/*. This module attaches its bucket policy."
  type        = string
}

variable "media_bucket_arn" {
  description = "ARN of the media bucket."
  type        = string
}

variable "media_bucket_regional_domain_name" {
  description = "Regional S3 domain name of the media bucket. Also the origin browsers upload media to, so it is allowed in the Content-Security-Policy connect-src and form-action."
  type        = string
}

variable "ws_url" {
  description = "wss:// URL of the WebSocket API, allowed in the Content-Security-Policy connect-src."
  type        = string
}

variable "cognito_domain" {
  description = "Cognito managed login base URL (https://...), allowed in connect-src and form-action."
  type        = string
}

variable "price_class" {
  description = "CloudFront price class. PriceClass_100 serves North America and Europe only and is the cheapest."
  type        = string
  default     = "PriceClass_100"

  validation {
    condition     = contains(["PriceClass_100", "PriceClass_200", "PriceClass_All"], var.price_class)
    error_message = "price_class must be PriceClass_100, PriceClass_200 or PriceClass_All."
  }
}

variable "aliases" {
  description = "Optional custom domain names for the distribution. When empty the *.cloudfront.net name and its default certificate are used."
  type        = list(string)
  default     = []
}

variable "acm_certificate_arn" {
  description = "ARN of an ACM certificate in us-east-1 that covers every alias. Required when aliases is set."
  type        = string
  default     = null

  validation {
    condition     = length(var.aliases) == 0 || var.acm_certificate_arn != null
    error_message = "acm_certificate_arn is required when aliases is set."
  }
}

variable "force_destroy" {
  description = "Let Terraform delete the site bucket even when it still holds objects."
  type        = bool
  default     = false
}
