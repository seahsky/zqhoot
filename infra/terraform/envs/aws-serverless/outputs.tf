output "region" {
  description = "AWS Region of the deployment."
  value       = var.region
}

output "site_url" {
  description = "Public URL of the app. Hosts open /host, players open /join."
  value       = module.static_site.site_url
}

output "site_bucket_name" {
  description = "Bucket the web app is synced into."
  value       = module.static_site.site_bucket_name
}

output "media_bucket_name" {
  description = "Bucket holding uploaded quiz images."
  value       = module.data.media_bucket_name
}

output "media_upload_origin" {
  description = "Origin browsers upload media to (the media bucket's regional S3 endpoint). Presigned POST URLs must use this host, or the Content-Security-Policy blocks the upload."
  value       = module.static_site.media_upload_origin
}

output "distribution_id" {
  description = "CloudFront distribution ID, for invalidations."
  value       = module.static_site.distribution_id
}

output "distribution_domain_name" {
  description = "The *.cloudfront.net domain. Point a custom domain's CNAME here."
  value       = module.static_site.distribution_domain_name
}

output "ws_url" {
  description = "WebSocket URL players and hosts connect to."
  value       = module.realtime_ws.wss_url
}

output "table_name" {
  description = "DynamoDB table name."
  value       = module.data.table_name
}

output "cognito_user_pool_id" {
  description = "Cognito user pool ID; hosts are created here."
  value       = module.auth.user_pool_id
}

output "cognito_client_id" {
  description = "Cognito public app client ID."
  value       = module.auth.client_id
}

output "cognito_domain" {
  description = "Cognito managed login base URL."
  value       = module.auth.hosted_domain_url
}

output "cognito_issuer_url" {
  description = "Token issuer URL."
  value       = module.auth.issuer_url
}

output "http_function_name" {
  description = "Name of the http Lambda function."
  value       = module.http_api.function_name
}

output "ws_function_name" {
  description = "Name of the ws Lambda function."
  value       = module.realtime_ws.function_name
}
