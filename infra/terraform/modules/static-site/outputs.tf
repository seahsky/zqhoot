output "distribution_id" {
  description = "CloudFront distribution ID (for cache invalidations)."
  value       = aws_cloudfront_distribution.this.id
}

output "distribution_arn" {
  description = "CloudFront distribution ARN."
  value       = aws_cloudfront_distribution.this.arn
}

output "distribution_domain_name" {
  description = "The *.cloudfront.net domain name. Point a custom domain's CNAME here."
  value       = aws_cloudfront_distribution.this.domain_name
}

output "site_url" {
  description = "Public site URL without a trailing slash: the first alias when a custom domain is set, else the CloudFront domain."
  value       = "https://${local.custom_domain ? var.aliases[0] : aws_cloudfront_distribution.this.domain_name}"
}

output "site_bucket_name" {
  description = "Site bucket name. The deploy script syncs the built web app here."
  value       = aws_s3_bucket.site.bucket
}

output "site_bucket_arn" {
  description = "Site bucket ARN."
  value       = aws_s3_bucket.site.arn
}

output "media_upload_origin" {
  description = "Origin the browser posts media uploads to (allowed in the CSP connect-src and form-action). Presigned POST URLs must use this host."
  value       = local.media_upload_origin
}
