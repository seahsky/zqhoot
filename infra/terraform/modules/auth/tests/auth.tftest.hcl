# Offline test against a mocked AWS provider: terraform test needs no credentials.

mock_provider "aws" {
  mock_data "aws_region" {
    defaults = {
      region = "us-east-1"
    }
  }

  mock_resource "aws_cognito_user_pool" {
    defaults = {
      id  = "us-east-1_AbCdEfG"
      arn = "arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_AbCdEfG"
    }
  }

  mock_resource "aws_cognito_user_pool_client" {
    defaults = {
      id = "client123"
    }
  }
}

variables {
  name          = "tst"
  domain_prefix = "tst-abc12345"
  callback_urls = ["https://d111111abcdef8.cloudfront.net/host"]
  logout_urls   = ["https://d111111abcdef8.cloudfront.net/host"]
}

run "user_pool_defaults" {
  command = apply

  assert {
    condition     = aws_cognito_user_pool.this.user_pool_tier == "ESSENTIALS"
    error_message = "the user pool defaults to the Essentials tier"
  }

  assert {
    condition     = jsonencode(aws_cognito_user_pool.this.username_attributes) == jsonencode(["email"])
    error_message = "email is the username"
  }

  assert {
    condition     = one(aws_cognito_user_pool.this.username_configuration).case_sensitive == false
    error_message = "email sign-in is case-insensitive; the setting cannot be changed once the pool exists"
  }

  assert {
    condition     = one(aws_cognito_user_pool.this.admin_create_user_config).allow_admin_create_user_only
    error_message = "self sign-up is disabled by default"
  }

  assert {
    condition     = one(aws_cognito_user_pool.this.password_policy).minimum_length == 12
    error_message = "passwords need at least 12 characters"
  }

  assert {
    condition     = aws_cognito_user_pool.this.mfa_configuration == "OPTIONAL" && one(aws_cognito_user_pool.this.software_token_mfa_configuration).enabled
    error_message = "MFA is optional and offers authenticator apps"
  }

  assert {
    condition     = aws_cognito_user_pool.this.deletion_protection == "INACTIVE"
    error_message = "deletion protection is off by default"
  }

  assert {
    condition     = length(aws_cognito_user.initial_admin) == 0
    error_message = "no initial admin unless initial_admin_email is set"
  }
}

run "public_client_uses_authorization_code_with_pkce" {
  command = apply

  assert {
    condition     = !aws_cognito_user_pool_client.web.generate_secret
    error_message = "the client is public: no secret"
  }

  assert {
    condition     = jsonencode(sort(aws_cognito_user_pool_client.web.allowed_oauth_flows)) == jsonencode(["code"]) && aws_cognito_user_pool_client.web.allowed_oauth_flows_user_pool_client
    error_message = "authorization code grant only"
  }

  assert {
    condition     = jsonencode(sort(aws_cognito_user_pool_client.web.allowed_oauth_scopes)) == jsonencode(["email", "openid", "profile"])
    error_message = "scopes are openid, email and profile"
  }

  assert {
    condition     = jsonencode(aws_cognito_user_pool_client.web.supported_identity_providers) == jsonencode(["COGNITO"])
    error_message = "only the Cognito user pool as identity provider"
  }

  assert {
    condition     = aws_cognito_user_pool_client.web.access_token_validity == 1 && aws_cognito_user_pool_client.web.id_token_validity == 1 && aws_cognito_user_pool_client.web.refresh_token_validity == 30
    error_message = "token validity is 1 h / 1 h / 30 d"
  }

  assert {
    condition     = one(aws_cognito_user_pool_client.web.token_validity_units).access_token == "hours" && one(aws_cognito_user_pool_client.web.token_validity_units).id_token == "hours" && one(aws_cognito_user_pool_client.web.token_validity_units).refresh_token == "days"
    error_message = "token validity units"
  }

  assert {
    condition     = aws_cognito_user_pool_client.web.prevent_user_existence_errors == "ENABLED"
    error_message = "user existence errors are prevented"
  }

  assert {
    condition     = jsonencode(sort(aws_cognito_user_pool_client.web.callback_urls)) == jsonencode(["https://d111111abcdef8.cloudfront.net/host"])
    error_message = "callback URLs come from the variable"
  }
}

run "outputs" {
  command = apply

  assert {
    condition     = output.hosted_domain_url == "https://tst-abc12345.auth.us-east-1.amazoncognito.com"
    error_message = "hosted_domain_url shape"
  }

  assert {
    condition     = output.issuer_url == "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_AbCdEfG"
    error_message = "issuer_url shape"
  }

  assert {
    condition     = output.client_id == "client123" && output.user_pool_id == "us-east-1_AbCdEfG"
    error_message = "client and pool ids"
  }
}

run "initial_admin_gets_no_password" {
  command = apply

  variables {
    initial_admin_email = "host@example.com"
  }

  assert {
    condition     = length(aws_cognito_user.initial_admin) == 1 && aws_cognito_user.initial_admin[0].username == "host@example.com"
    error_message = "the initial admin is created when initial_admin_email is set"
  }

  # Cognito generates and emails the temporary password, so nothing sensitive can land in state.
  assert {
    condition     = aws_cognito_user.initial_admin[0].password == null && aws_cognito_user.initial_admin[0].temporary_password == null
    error_message = "no password may be set on the initial admin"
  }

  assert {
    condition     = jsonencode(aws_cognito_user.initial_admin[0].desired_delivery_mediums) == jsonencode(["EMAIL"])
    error_message = "the invitation goes out by email"
  }
}

run "options_are_wired" {
  command = apply

  variables {
    allow_self_signup   = true
    mfa_configuration   = "OFF"
    deletion_protection = true
  }

  assert {
    condition     = !one(aws_cognito_user_pool.this.admin_create_user_config).allow_admin_create_user_only && aws_cognito_user_pool.this.mfa_configuration == "OFF" && aws_cognito_user_pool.this.deletion_protection == "ACTIVE"
    error_message = "allow_self_signup, mfa_configuration and deletion_protection must reach the user pool"
  }

  assert {
    condition     = length(aws_cognito_user_pool.this.software_token_mfa_configuration) == 0
    error_message = "no MFA block when MFA is off"
  }
}

run "domain_prefix_rejects_reserved_words" {
  command = plan

  variables {
    domain_prefix = "my-cognito-login"
  }

  expect_failures = [var.domain_prefix]
}
