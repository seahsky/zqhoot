output "user_pool_id" {
  description = "Cognito user pool ID (ZQ_COGNITO_USER_POOL_ID)."
  value       = aws_cognito_user_pool.this.id
}

output "user_pool_arn" {
  description = "Cognito user pool ARN."
  value       = aws_cognito_user_pool.this.arn
}

output "client_id" {
  description = "Public app client ID (ZQ_COGNITO_CLIENT_ID)."
  value       = aws_cognito_user_pool_client.web.id
}

output "hosted_domain_url" {
  description = "Managed login base URL: https://{prefix}.auth.{region}.amazoncognito.com."
  value       = "https://${aws_cognito_user_pool_domain.this.domain}.auth.${data.aws_region.current.region}.amazoncognito.com"
}

output "issuer_url" {
  description = "Token issuer (iss claim): https://cognito-idp.{region}.amazonaws.com/{pool id}."
  value       = "https://cognito-idp.${data.aws_region.current.region}.amazonaws.com/${aws_cognito_user_pool.this.id}"
}

output "callback_urls" {
  description = "OAuth redirect URLs registered on the app client."
  value       = aws_cognito_user_pool_client.web.callback_urls
}

output "logout_urls" {
  description = "Sign-out redirect URLs registered on the app client."
  value       = aws_cognito_user_pool_client.web.logout_urls
}
