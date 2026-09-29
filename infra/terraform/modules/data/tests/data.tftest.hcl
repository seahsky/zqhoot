# Offline test against a mocked AWS provider: terraform test needs no credentials.

mock_provider "aws" {
  mock_resource "aws_dynamodb_table" {
    defaults = {
      arn = "arn:aws:dynamodb:us-east-1:123456789012:table/tst"
    }
  }

  mock_resource "aws_s3_bucket" {
    defaults = {
      arn                         = "arn:aws:s3:::tst-media-20260929"
      bucket                      = "tst-media-20260929"
      bucket_regional_domain_name = "tst-media-20260929.s3.us-east-1.amazonaws.com"
    }
  }
}

variables {
  name         = "tst"
  site_origins = ["https://d111111abcdef8.cloudfront.net"]
}

# Must stay in sync with tableDefinition() in packages/store/src/dynamo-schema.ts.
run "table_matches_the_store_package_definition" {
  command = apply

  assert {
    condition     = aws_dynamodb_table.this.billing_mode == "PAY_PER_REQUEST" && aws_dynamodb_table.this.hash_key == "pk" && aws_dynamodb_table.this.range_key == "sk"
    error_message = "on-demand table keyed by pk/sk"
  }

  assert {
    condition = jsonencode({ for a in aws_dynamodb_table.this.attribute : a.name => a.type }) == jsonencode({
      pk     = "S"
      sk     = "S"
      gsi1pk = "S"
      gsi1sk = "S"
    })
    error_message = "attributes are pk, sk, gsi1pk and gsi1sk, all strings"
  }

  assert {
    condition     = length(aws_dynamodb_table.this.global_secondary_index) == 1 && one(aws_dynamodb_table.this.global_secondary_index).name == "gsi1" && one(aws_dynamodb_table.this.global_secondary_index).projection_type == "ALL"
    error_message = "one GSI named gsi1 projecting ALL"
  }

  assert {
    condition     = jsonencode([for k in one(aws_dynamodb_table.this.global_secondary_index).key_schema : "${k.key_type}:${k.attribute_name}"]) == jsonencode(["HASH:gsi1pk", "RANGE:gsi1sk"])
    error_message = "gsi1 is keyed by gsi1pk (hash) and gsi1sk (range)"
  }

  assert {
    condition     = one(aws_dynamodb_table.this.ttl).attribute_name == "expiresAt" && one(aws_dynamodb_table.this.ttl).enabled
    error_message = "TTL on expiresAt"
  }

  assert {
    condition     = length(aws_dynamodb_table.this.server_side_encryption) == 0
    error_message = "no customer-managed KMS key: the table stays on the AWS-owned key (ADR-0012)"
  }

  assert {
    condition     = !one(aws_dynamodb_table.this.point_in_time_recovery).enabled && !aws_dynamodb_table.this.deletion_protection_enabled
    error_message = "point-in-time recovery and deletion protection default to off"
  }

  assert {
    condition     = output.gsi_arn == "arn:aws:dynamodb:us-east-1:123456789012:table/tst/index/gsi1"
    error_message = "gsi_arn output"
  }
}

run "media_bucket_is_private_and_uploads_are_cors_limited" {
  command = apply

  assert {
    condition = (
      aws_s3_bucket_public_access_block.media.block_public_acls &&
      aws_s3_bucket_public_access_block.media.block_public_policy &&
      aws_s3_bucket_public_access_block.media.ignore_public_acls &&
      aws_s3_bucket_public_access_block.media.restrict_public_buckets
    )
    error_message = "Block Public Access must be fully on"
  }

  assert {
    condition     = one(aws_s3_bucket_ownership_controls.media.rule).object_ownership == "BucketOwnerEnforced"
    error_message = "BucketOwnerEnforced"
  }

  assert {
    condition     = one(one(aws_s3_bucket_server_side_encryption_configuration.media.rule).apply_server_side_encryption_by_default).sse_algorithm == "AES256"
    error_message = "SSE-S3, not KMS"
  }

  assert {
    condition = (
      length(aws_s3_bucket_cors_configuration.media.cors_rule) == 1 &&
      jsonencode(one(aws_s3_bucket_cors_configuration.media.cors_rule).allowed_methods) == jsonencode(["POST"]) &&
      jsonencode(one(aws_s3_bucket_cors_configuration.media.cors_rule).allowed_origins) == jsonencode(["https://d111111abcdef8.cloudfront.net"])
    )
    error_message = "CORS allows POST from var.site_origins only"
  }

  assert {
    condition     = one(one(aws_s3_bucket_lifecycle_configuration.media.rule).abort_incomplete_multipart_upload).days_after_initiation == 1
    error_message = "incomplete multipart uploads are aborted after 1 day"
  }
}

run "options_are_wired" {
  command = apply

  variables {
    point_in_time_recovery = true
    deletion_protection    = true
  }

  assert {
    condition     = one(aws_dynamodb_table.this.point_in_time_recovery).enabled && aws_dynamodb_table.this.deletion_protection_enabled
    error_message = "point_in_time_recovery and deletion_protection variables must reach the table"
  }
}

run "site_origins_must_be_bare_origins" {
  command = plan

  variables {
    site_origins = ["https://example.com/"]
  }

  expect_failures = [var.site_origins]
}
