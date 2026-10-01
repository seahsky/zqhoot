# Offline test against a mocked AWS provider: terraform test needs no credentials.

mock_provider "aws" {
  mock_resource "aws_s3_bucket" {
    defaults = {
      arn                         = "arn:aws:s3:::tst-site-20260929"
      bucket                      = "tst-site-20260929"
      bucket_regional_domain_name = "tst-site-20260929.s3.us-east-1.amazonaws.com"
    }
  }

  mock_resource "aws_cloudfront_function" {
    defaults = {
      arn = "arn:aws:cloudfront::123456789012:function/tst-spa-rewrite"
    }
  }

  mock_resource "aws_cloudfront_distribution" {
    defaults = {
      arn         = "arn:aws:cloudfront::123456789012:distribution/E2EXAMPLE"
      domain_name = "d111111abcdef8.cloudfront.net"
      id          = "E2EXAMPLE"
    }
  }
}

variables {
  name                              = "tst"
  api_origin                        = "https://abc123.execute-api.us-east-1.amazonaws.com"
  media_bucket_id                   = "tst-media-20260929"
  media_bucket_arn                  = "arn:aws:s3:::tst-media-20260929"
  media_bucket_regional_domain_name = "tst-media-20260929.s3.us-east-1.amazonaws.com"
  ws_url                            = "wss://def456.execute-api.us-east-1.amazonaws.com/live"
  cognito_domain                    = "https://tst-abc12345.auth.us-east-1.amazoncognito.com"
}

run "origins_are_the_two_buckets_behind_oac" {
  command = apply

  assert {
    condition     = jsonencode(sort([for o in aws_cloudfront_distribution.this.origin : o.origin_id])) == jsonencode(["media", "site"])
    error_message = "two origins only: the site bucket and the media bucket"
  }

  # The browser calls the HTTP API directly at its execute-api endpoint (real client IP for the
  # per-IP rate limits, ADR-0002), so CloudFront holds no origin for it.
  assert {
    condition     = alltrue([for o in aws_cloudfront_distribution.this.origin : length(o.custom_origin_config) == 0])
    error_message = "no custom origin: the HTTP API is not behind CloudFront"
  }

  assert {
    condition     = !anytrue([for o in aws_cloudfront_distribution.this.origin : strcontains(o.domain_name, "execute-api")])
    error_message = "no origin may point at API Gateway"
  }

  assert {
    condition     = alltrue([for o in aws_cloudfront_distribution.this.origin : o.origin_access_control_id != null && o.origin_access_control_id != ""])
    error_message = "both S3 origins use origin access control"
  }

  assert {
    condition     = aws_cloudfront_origin_access_control.s3.signing_protocol == "sigv4" && aws_cloudfront_origin_access_control.s3.signing_behavior == "always"
    error_message = "OAC signs with sigv4"
  }
}

run "behaviours_route_site_and_media_and_not_the_api" {
  command = apply

  # The managed policies are looked up by name. The mock cannot return their ids (the data source's
  # id attribute is not computed in the provider schema), so this checks the names, not which
  # behaviour got which id.
  assert {
    condition     = data.aws_cloudfront_cache_policy.caching_optimized.name == "Managed-CachingOptimized"
    error_message = "the managed cache policy is looked up by its AWS name"
  }

  assert {
    condition = (
      aws_cloudfront_distribution.this.default_cache_behavior[0].target_origin_id == "site" &&
      one(aws_cloudfront_distribution.this.default_cache_behavior[0].function_association).event_type == "viewer-request" &&
      jsonencode(aws_cloudfront_distribution.this.default_cache_behavior[0].allowed_methods) == jsonencode(["GET", "HEAD"])
    )
    error_message = "the default behaviour serves the site, read-only, through the viewer-request function"
  }

  assert {
    condition = anytrue([
      for b in aws_cloudfront_distribution.this.ordered_cache_behavior :
      b.path_pattern == "/media/*" && b.target_origin_id == "media"
    ])
    error_message = "/media/* goes to the media bucket"
  }

  assert {
    condition     = jsonencode([for b in aws_cloudfront_distribution.this.ordered_cache_behavior : b.path_pattern]) == jsonencode(["/media/*"])
    error_message = "/media/* is the only ordered behaviour: there is no /api/* behaviour"
  }

  assert {
    condition = alltrue(concat(
      [for b in aws_cloudfront_distribution.this.ordered_cache_behavior : contains(["site", "media"], b.target_origin_id)],
      [for b in aws_cloudfront_distribution.this.default_cache_behavior : contains(["site", "media"], b.target_origin_id)],
    ))
    error_message = "every behaviour must target one of the two buckets"
  }

  assert {
    condition     = aws_cloudfront_function.spa_rewrite.runtime == "cloudfront-js-2.0" && aws_cloudfront_function.spa_rewrite.publish
    error_message = "a published CloudFront Functions JS 2.0 function"
  }

  assert {
    condition     = aws_cloudfront_distribution.this.is_ipv6_enabled && aws_cloudfront_distribution.this.price_class == "PriceClass_100"
    error_message = "IPv6 on, PriceClass_100 by default"
  }
}

run "security_headers_follow_adr_0013" {
  command = apply

  assert {
    condition = one(one(aws_cloudfront_response_headers_policy.security.security_headers_config).content_security_policy).content_security_policy == join("; ", [
      "default-src 'self'",
      "connect-src 'self' https://abc123.execute-api.us-east-1.amazonaws.com wss://def456.execute-api.us-east-1.amazonaws.com/live https://tst-abc12345.auth.us-east-1.amazoncognito.com https://tst-media-20260929.s3.us-east-1.amazonaws.com",
      "img-src 'self' data: blob:",
      "style-src 'self' 'unsafe-inline'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self' https://tst-abc12345.auth.us-east-1.amazoncognito.com https://tst-media-20260929.s3.us-east-1.amazonaws.com",
    ])
    error_message = "the Content-Security-Policy does not match ADR-0013 plus the API and media upload origins"
  }

  # The browser calls the HTTP API directly, so without this entry in connect-src every API call
  # is blocked on the AWS target. The API is fetched, never form-posted.
  assert {
    condition = anytrue([
      for part in split("; ", one(one(aws_cloudfront_response_headers_policy.security.security_headers_config).content_security_policy).content_security_policy) :
      startswith(part, "connect-src ") && contains(split(" ", part), "https://abc123.execute-api.us-east-1.amazonaws.com")
    ])
    error_message = "the HTTP API origin must be in connect-src"
  }

  # A wildcard would let a script that runs on the page reach any API Gateway API in the Region.
  assert {
    condition     = !strcontains(output.content_security_policy, "*")
    error_message = "no wildcard anywhere in the Content-Security-Policy"
  }

  assert {
    condition     = output.content_security_policy == one(one(aws_cloudfront_response_headers_policy.security.security_headers_config).content_security_policy).content_security_policy
    error_message = "the content_security_policy output is the header value"
  }

  # Presigned-POST uploads go browser -> media bucket, so its regional endpoint must be allowed by
  # both directives that can carry the upload.
  assert {
    condition = alltrue([
      for d in ["connect-src", "form-action"] :
      anytrue([
        for part in split("; ", one(one(aws_cloudfront_response_headers_policy.security.security_headers_config).content_security_policy).content_security_policy) :
        startswith(part, "${d} ") && contains(split(" ", part), "https://tst-media-20260929.s3.us-east-1.amazonaws.com")
      ])
    ])
    error_message = "the media bucket origin must be in connect-src and form-action or every upload is blocked"
  }

  assert {
    condition     = output.media_upload_origin == "https://tst-media-20260929.s3.us-east-1.amazonaws.com"
    error_message = "media_upload_origin is the media bucket's regional endpoint"
  }

  assert {
    condition     = one(one(aws_cloudfront_response_headers_policy.security.security_headers_config).strict_transport_security).access_control_max_age_sec == 31536000
    error_message = "HSTS for one year"
  }

  assert {
    condition     = one(one(aws_cloudfront_response_headers_policy.security.security_headers_config).frame_options).frame_option == "DENY"
    error_message = "X-Frame-Options DENY"
  }

  assert {
    condition     = one(one(aws_cloudfront_response_headers_policy.security.security_headers_config).referrer_policy).referrer_policy == "strict-origin-when-cross-origin"
    error_message = "Referrer-Policy"
  }

  assert {
    condition     = length(one(aws_cloudfront_response_headers_policy.security.security_headers_config).content_type_options) == 1
    error_message = "X-Content-Type-Options: nosniff"
  }

  assert {
    condition = anytrue([
      for i in one(aws_cloudfront_response_headers_policy.security.custom_headers_config).items :
      i.header == "Permissions-Policy" && i.value == "camera=(), microphone=(), geolocation=()"
    ])
    error_message = "Permissions-Policy is a custom header"
  }
}

run "bucket_policies_admit_only_this_distribution" {
  command = apply

  assert {
    condition = alltrue([
      for p in [aws_s3_bucket_policy.site.policy, aws_s3_bucket_policy.media.policy] :
      alltrue([
        for s in jsondecode(p).Statement :
        s.Effect == "Allow" && s.Principal.Service == "cloudfront.amazonaws.com" && s.Action == "s3:GetObject" &&
        s.Condition.StringEquals["AWS:SourceArn"] == "arn:aws:cloudfront::123456789012:distribution/E2EXAMPLE"
      ])
    ])
    error_message = "read-only, for cloudfront.amazonaws.com, conditioned on this distribution's ARN"
  }

  assert {
    condition     = jsondecode(aws_s3_bucket_policy.media.policy).Statement[0].Resource == "arn:aws:s3:::tst-media-20260929/media/*"
    error_message = "CloudFront may read only media/ from the media bucket"
  }
}

run "site_bucket_is_private" {
  command = apply

  assert {
    condition = (
      aws_s3_bucket_public_access_block.site.block_public_acls &&
      aws_s3_bucket_public_access_block.site.block_public_policy &&
      aws_s3_bucket_public_access_block.site.ignore_public_acls &&
      aws_s3_bucket_public_access_block.site.restrict_public_buckets
    )
    error_message = "Block Public Access must be fully on"
  }

  assert {
    condition     = one(one(aws_s3_bucket_server_side_encryption_configuration.site.rule).apply_server_side_encryption_by_default).sse_algorithm == "AES256"
    error_message = "SSE-S3"
  }

  assert {
    condition     = output.site_url == "https://d111111abcdef8.cloudfront.net"
    error_message = "the site URL is the CloudFront domain when there is no custom domain"
  }
}

run "custom_domain" {
  command = apply

  variables {
    aliases             = ["quiz.example.com"]
    acm_certificate_arn = "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000"
  }

  assert {
    condition     = output.site_url == "https://quiz.example.com"
    error_message = "the site URL is the first alias"
  }

  assert {
    condition     = one(aws_cloudfront_distribution.this.viewer_certificate).ssl_support_method == "sni-only" && one(aws_cloudfront_distribution.this.viewer_certificate).minimum_protocol_version == "TLSv1.2_2021"
    error_message = "a custom domain uses SNI and TLS 1.2 or later"
  }
}

run "aliases_need_a_certificate" {
  command = plan

  variables {
    aliases = ["quiz.example.com"]
  }

  expect_failures = [var.acm_certificate_arn]
}

run "api_origin_must_be_an_exact_https_origin" {
  command = plan

  variables {
    api_origin = "https://abc123.execute-api.us-east-1.amazonaws.com/api"
  }

  expect_failures = [var.api_origin]
}

run "api_origin_cannot_be_a_wildcard" {
  command = plan

  variables {
    api_origin = "https://*.execute-api.us-east-1.amazonaws.com"
  }

  expect_failures = [var.api_origin]
}

run "api_origin_cannot_be_a_bare_wildcard" {
  command = plan

  variables {
    api_origin = "https://*"
  }

  expect_failures = [var.api_origin]
}
