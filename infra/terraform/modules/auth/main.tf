data "aws_region" "current" {}

locals {
  managed_login_version = var.user_pool_tier == "LITE" ? 1 : 2
}

# The callback URLs contain the CloudFront domain, and CloudFront's response headers policy needs
# the Cognito domain from this module. So the user pool and the domain must not depend on the
# callback URLs; only the app client (which takes them) sits on that side of the loop.
resource "aws_cognito_user_pool" "this" {
  name           = "${var.name}-hosts"
  user_pool_tier = var.user_pool_tier

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  # Hosts type their address by hand, so Alice@example.com and alice@example.com must be the same
  # account. Set it explicitly rather than rely on a default: Cognito cannot change it after the
  # pool exists (that would mean recreating the pool and every host account).
  username_configuration {
    case_sensitive = false
  }

  mfa_configuration   = var.mfa_configuration
  deletion_protection = var.deletion_protection ? "ACTIVE" : "INACTIVE"

  password_policy {
    minimum_length                   = 12
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = true
    temporary_password_validity_days = 7
  }

  admin_create_user_config {
    allow_admin_create_user_only = !var.allow_self_signup
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  dynamic "software_token_mfa_configuration" {
    for_each = var.mfa_configuration == "OFF" ? [] : [1]

    content {
      enabled = true
    }
  }
}

resource "aws_cognito_user_pool_domain" "this" {
  domain                = var.domain_prefix
  user_pool_id          = aws_cognito_user_pool.this.id
  managed_login_version = local.managed_login_version
}

# Public client for the single-page app: authorization code grant with PKCE, no secret.
resource "aws_cognito_user_pool_client" "web" {
  name         = "${var.name}-web"
  user_pool_id = aws_cognito_user_pool.this.id

  generate_secret = false

  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"]

  callback_urls = var.callback_urls
  logout_urls   = var.logout_urls

  # The app never calls InitiateAuth itself. SRP is what the hosted sign-in page uses for passwords.
  explicit_auth_flows = ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]

  access_token_validity  = 1
  id_token_validity      = 1
  refresh_token_validity = 30

  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }

  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true
}

# Managed login renders nothing useful until a branding style exists; Cognito's own defaults are enough.
resource "aws_cognito_managed_login_branding" "web" {
  count = local.managed_login_version == 2 ? 1 : 0

  user_pool_id                = aws_cognito_user_pool.this.id
  client_id                   = aws_cognito_user_pool_client.web.id
  use_cognito_provided_values = true

  depends_on = [aws_cognito_user_pool_domain.this]
}

# No password is set: Cognito generates a temporary one and emails it, so it never enters state.
resource "aws_cognito_user" "initial_admin" {
  count = var.initial_admin_email == null ? 0 : 1

  user_pool_id             = aws_cognito_user_pool.this.id
  username                 = var.initial_admin_email
  desired_delivery_mediums = ["EMAIL"]

  attributes = {
    email          = var.initial_admin_email
    email_verified = "true"
  }
}
