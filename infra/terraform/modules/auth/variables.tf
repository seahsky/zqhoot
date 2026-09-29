variable "name" {
  description = "Deployment name, used to name the user pool and app client."
  type        = string
}

variable "domain_prefix" {
  description = "Prefix of the Cognito hosted domain: https://{prefix}.auth.{region}.amazoncognito.com. Must be unique in the Region."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.domain_prefix)) && !can(regex("aws|amazon|cognito", var.domain_prefix))
    error_message = "domain_prefix must be lowercase letters, digits and hyphens, and must not contain \"aws\", \"amazon\" or \"cognito\"."
  }
}

variable "callback_urls" {
  description = "OAuth redirect URLs after sign-in, for example https://{site}/host."
  type        = list(string)

  validation {
    condition     = length(var.callback_urls) > 0
    error_message = "At least one callback URL is required."
  }
}

variable "logout_urls" {
  description = "URLs Cognito may redirect to after sign-out."
  type        = list(string)

  validation {
    condition     = length(var.logout_urls) > 0
    error_message = "At least one logout URL is required."
  }
}

variable "user_pool_tier" {
  description = "Cognito feature plan. ESSENTIALS is free up to 10,000 monthly active users and includes managed login."
  type        = string
  default     = "ESSENTIALS"

  validation {
    condition     = contains(["LITE", "ESSENTIALS", "PLUS"], var.user_pool_tier)
    error_message = "user_pool_tier must be LITE, ESSENTIALS or PLUS."
  }
}

variable "allow_self_signup" {
  description = "Let anyone create a host account from the sign-in page. Off by default: operators create hosts with the AWS CLI."
  type        = bool
  default     = false
}

variable "mfa_configuration" {
  description = "OFF, OPTIONAL or ON. Only authenticator-app (TOTP) codes are offered, because SMS needs an SNS role and per-message fees."
  type        = string
  default     = "OPTIONAL"

  validation {
    condition     = contains(["OFF", "OPTIONAL", "ON"], var.mfa_configuration)
    error_message = "mfa_configuration must be OFF, OPTIONAL or ON."
  }
}

variable "deletion_protection" {
  description = "Enable Cognito deletion protection. Terraform cannot destroy the user pool until it is turned off."
  type        = bool
  default     = false
}

variable "initial_admin_email" {
  description = "Optional host account to create. Cognito emails a temporary password to this address, so no password is ever stored in Terraform state."
  type        = string
  default     = null
}
