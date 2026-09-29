variable "name" {
  description = "Deployment name. Used as the DynamoDB table name and as the prefix of the media bucket name."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,19}$", var.name))
    error_message = "name must be 2-20 characters: lowercase letters, digits and hyphens, starting with a letter."
  }
}

variable "site_origins" {
  description = "Browser origins (scheme and host, no path or trailing slash) allowed to POST uploads to the media bucket."
  type        = list(string)

  validation {
    condition     = length(var.site_origins) > 0 && alltrue([for o in var.site_origins : can(regex("^https?://[^/]+$", o))])
    error_message = "site_origins must be a non-empty list of origins such as \"https://example.com\" (no path, no trailing slash)."
  }
}

variable "point_in_time_recovery" {
  description = "Enable DynamoDB point-in-time recovery. Adds a per-GB monthly charge; live-session data expires after 30 days anyway."
  type        = bool
  default     = false
}

variable "deletion_protection" {
  description = "Enable DynamoDB deletion protection. Terraform cannot destroy the table until it is turned off."
  type        = bool
  default     = false
}

variable "force_destroy" {
  description = "Let Terraform delete the media bucket even when it still holds objects."
  type        = bool
  default     = false
}
