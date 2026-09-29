output "table_name" {
  description = "DynamoDB table name (ZQ_TABLE_NAME)."
  value       = aws_dynamodb_table.this.name
}

output "table_arn" {
  description = "DynamoDB table ARN."
  value       = aws_dynamodb_table.this.arn
}

output "gsi_arn" {
  description = "ARN of the gsi1 index (sessions by host)."
  value       = "${aws_dynamodb_table.this.arn}/index/gsi1"
}

output "media_bucket_name" {
  description = "Media bucket name (ZQ_MEDIA_BUCKET)."
  value       = aws_s3_bucket.media.bucket

  # The static-site module attaches the bucket policy through this value. S3 aborts a policy write
  # that races with the public access block or the ownership controls being applied.
  depends_on = [
    aws_s3_bucket_public_access_block.media,
    aws_s3_bucket_ownership_controls.media,
  ]
}

output "media_bucket_arn" {
  description = "Media bucket ARN."
  value       = aws_s3_bucket.media.arn
}

output "media_bucket_regional_domain_name" {
  description = "Regional S3 domain name of the media bucket, used as a CloudFront origin."
  value       = aws_s3_bucket.media.bucket_regional_domain_name
}
