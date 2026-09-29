# Offline test of the whole composition against a mocked AWS provider: terraform test needs no
# credentials. It proves the modules wire together without a dependency cycle and that config.json
# has the shape of RuntimeConfig. The missing-Lambda-package precondition is tested in the
# http-api and realtime-ws modules (a test cannot expect failures inside a child module).

mock_provider "aws" {
  mock_data "aws_region" {
    defaults = {
      region = "us-east-1"
    }
  }

  mock_resource "aws_dynamodb_table" {
    defaults = {
      arn = "arn:aws:dynamodb:us-east-1:123456789012:table/zqhoot"
    }
  }

  mock_resource "aws_s3_bucket" {
    defaults = {
      arn                         = "arn:aws:s3:::zqhoot-bucket-20260929"
      bucket                      = "zqhoot-bucket-20260929"
      bucket_regional_domain_name = "zqhoot-bucket-20260929.s3.us-east-1.amazonaws.com"
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

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/zqhoot"
    }
  }

  mock_resource "aws_cloudwatch_log_group" {
    defaults = {
      arn = "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/zqhoot"
    }
  }

  mock_resource "aws_lambda_function" {
    defaults = {
      arn        = "arn:aws:lambda:us-east-1:123456789012:function:zqhoot"
      invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:zqhoot/invocations"
    }
  }

  mock_resource "aws_cloudfront_function" {
    defaults = {
      arn = "arn:aws:cloudfront::123456789012:function/zqhoot-spa-rewrite"
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

override_resource {
  target = module.http_api.aws_apigatewayv2_api.this
  values = {
    id            = "httpapi1"
    api_endpoint  = "https://httpapi1.execute-api.us-east-1.amazonaws.com"
    execution_arn = "arn:aws:execute-api:us-east-1:123456789012:httpapi1"
  }
}

override_resource {
  target = module.realtime_ws.aws_apigatewayv2_api.this
  values = {
    id            = "wsapi1"
    api_endpoint  = "wss://wsapi1.execute-api.us-east-1.amazonaws.com"
    execution_arn = "arn:aws:execute-api:us-east-1:123456789012:wsapi1"
  }
}

# The mock gives every bucket the same name; give the media bucket its own so the tests can tell
# whether a module was wired to the media bucket or to the site bucket.
override_resource {
  target = module.data.aws_s3_bucket.media
  values = {
    arn                         = "arn:aws:s3:::zqhoot-media-20260929"
    bucket                      = "zqhoot-media-20260929"
    bucket_regional_domain_name = "zqhoot-media-20260929.s3.us-east-1.amazonaws.com"
  }
}

variables {
  # Any file that exists: the mock never reads the packages.
  lambda_ws_zip   = "main.tf"
  lambda_http_zip = "main.tf"

  cognito_domain_prefix = "zqhoot-abc12345"
}

run "composes_without_a_cycle_and_writes_runtime_config" {
  command = apply

  assert {
    condition     = aws_s3_object.config.key == "config.json" && aws_s3_object.config.content_type == "application/json" && aws_s3_object.config.cache_control == "no-cache"
    error_message = "config.json is JSON and must never be cached"
  }

  # Mirrors RuntimeConfig in packages/protocol/src/config.ts.
  assert {
    condition = jsonencode(jsondecode(aws_s3_object.config.content)) == jsonencode({
      target       = "aws"
      apiBaseUrl   = ""
      wsUrl        = "wss://wsapi1.execute-api.us-east-1.amazonaws.com/live"
      mediaBaseUrl = "https://d111111abcdef8.cloudfront.net/"
      joinUrl      = "https://d111111abcdef8.cloudfront.net/join"
      auth = {
        mode       = "cognito"
        region     = "us-east-1"
        userPoolId = "us-east-1_AbCdEfG"
        clientId   = "client123"
        domain     = "https://zqhoot-abc12345.auth.us-east-1.amazoncognito.com"
      }
    })
    error_message = "config.json does not match RuntimeConfig"
  }

  assert {
    condition     = output.site_url == "https://d111111abcdef8.cloudfront.net" && output.distribution_id == "E2EXAMPLE"
    error_message = "the site URL and distribution ID outputs the deploy script reads"
  }

  # Everything scripts/deploy-aws.sh and scripts/destroy-aws.sh read with terraform output -raw.
  assert {
    condition = alltrue([
      output.region == "us-east-1",
      output.site_bucket_name != null,
      output.media_bucket_name != null,
      output.distribution_id != null,
      output.ws_url == "wss://wsapi1.execute-api.us-east-1.amazonaws.com/live",
      output.table_name != null,
      output.cognito_user_pool_id == "us-east-1_AbCdEfG",
      output.cognito_client_id == "client123",
      output.cognito_domain == "https://zqhoot-abc12345.auth.us-east-1.amazoncognito.com",
    ])
    error_message = "an output the scripts need is missing or wrong"
  }
}

# What this environment feeds into the two Lambda functions (the module tests only check the merge
# for inputs they supply themselves). The two functions and their exact variable sets are the
# contract with the wave 2 server-lambda build.
run "wires_the_lambda_environments" {
  command = apply

  assert {
    condition = jsonencode(module.realtime_ws.environment) == jsonencode({
      ZQ_TARGET               = "aws"
      ZQ_TABLE_NAME           = output.table_name
      ZQ_SITE_ORIGIN          = "https://d111111abcdef8.cloudfront.net"
      ZQ_COGNITO_USER_POOL_ID = "us-east-1_AbCdEfG"
      ZQ_COGNITO_CLIENT_ID    = "client123"
      ZQ_SESSION_TTL_DAYS     = "30"
      ZQ_WS_CALLBACK_URL      = "https://wsapi1.execute-api.us-east-1.amazonaws.com/live"
      ZQ_LOG_LEVEL            = "info"
      NODE_OPTIONS            = "--enable-source-maps"
    })
    error_message = "the ws Lambda environment is miswired"
  }

  assert {
    condition = jsonencode(module.http_api.environment) == jsonencode({
      ZQ_TARGET               = "aws"
      ZQ_TABLE_NAME           = output.table_name
      ZQ_SITE_ORIGIN          = "https://d111111abcdef8.cloudfront.net"
      ZQ_COGNITO_USER_POOL_ID = "us-east-1_AbCdEfG"
      ZQ_COGNITO_CLIENT_ID    = "client123"
      ZQ_SESSION_TTL_DAYS     = "30"
      ZQ_MEDIA_BUCKET         = "zqhoot-media-20260929"
      ZQ_WS_FUNCTION_NAME     = output.ws_function_name
      ZQ_WARM_CONCURRENCY     = "4"
      ZQ_LOG_LEVEL            = "info"
      NODE_OPTIONS            = "--enable-source-maps"
    })
    error_message = "the http Lambda environment is miswired"
  }

  # The Cognito client accepts sign-in redirects only on the site's /host route.
  assert {
    condition     = jsonencode(module.auth.callback_urls) == jsonencode(["https://d111111abcdef8.cloudfront.net/host"]) && jsonencode(module.auth.logout_urls) == jsonencode(["https://d111111abcdef8.cloudfront.net/host"])
    error_message = "the Cognito callback and logout URLs must be {site}/host"
  }
}

# Presigned-POST uploads go browser -> media bucket. static-site must be given the media bucket (not
# the site bucket) so its regional endpoint lands in the CSP; the CSP itself is asserted in the
# static-site module test.
run "media_upload_origin_is_the_media_bucket" {
  command = apply

  assert {
    condition     = output.media_bucket_name == "zqhoot-media-20260929" && output.site_bucket_name != output.media_bucket_name
    error_message = "the media bucket must be distinct from the site bucket"
  }

  assert {
    condition     = output.media_upload_origin == "https://zqhoot-media-20260929.s3.us-east-1.amazonaws.com"
    error_message = "the CSP upload origin must be the media bucket's regional endpoint"
  }
}

run "custom_domain_becomes_the_site_origin" {
  command = apply

  variables {
    custom_domain       = "quiz.example.com"
    acm_certificate_arn = "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000"
  }

  assert {
    condition     = jsondecode(aws_s3_object.config.content).joinUrl == "https://quiz.example.com/join" && jsondecode(aws_s3_object.config.content).mediaBaseUrl == "https://quiz.example.com/"
    error_message = "config.json must use the custom domain"
  }

  assert {
    condition     = module.http_api.environment["ZQ_SITE_ORIGIN"] == "https://quiz.example.com" && module.realtime_ws.environment["ZQ_SITE_ORIGIN"] == "https://quiz.example.com"
    error_message = "both Lambda functions must get the custom domain as ZQ_SITE_ORIGIN"
  }

  assert {
    condition     = jsonencode(module.auth.callback_urls) == jsonencode(["https://quiz.example.com/host"])
    error_message = "the Cognito callback URL must use the custom domain"
  }
}
