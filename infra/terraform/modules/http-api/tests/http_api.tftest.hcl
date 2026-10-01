# Offline test against a mocked AWS provider: terraform test needs no credentials.

mock_provider "aws" {
  mock_resource "aws_apigatewayv2_api" {
    defaults = {
      id            = "abc123"
      api_endpoint  = "https://abc123.execute-api.us-east-1.amazonaws.com"
      execution_arn = "arn:aws:execute-api:us-east-1:123456789012:abc123"
    }
  }

  mock_resource "aws_cloudwatch_log_group" {
    defaults = {
      arn = "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/t-http"
    }
  }

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/t-http"
    }
  }

  mock_resource "aws_lambda_function" {
    defaults = {
      arn        = "arn:aws:lambda:us-east-1:123456789012:function:t-http"
      invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:t-http/invocations"
    }
  }
}

variables {
  name               = "t"
  lambda_zip         = "main.tf" # any file that exists: the mock never reads it
  table_name         = "t"
  table_arn          = "arn:aws:dynamodb:us-east-1:123456789012:table/t"
  gsi_arn            = "arn:aws:dynamodb:us-east-1:123456789012:table/t/index/gsi1"
  media_bucket_name  = "t-media-x"
  media_bucket_arn   = "arn:aws:s3:::t-media-x"
  ws_function_name   = "t-ws"
  ws_function_arn    = "arn:aws:lambda:us-east-1:123456789012:function:t-ws"
  warm_concurrency   = 4
  log_retention_days = 14
  environment = {
    ZQ_SITE_ORIGIN          = "https://d111111abcdef8.cloudfront.net"
    ZQ_COGNITO_USER_POOL_ID = "us-east-1_AbCdEfG"
    ZQ_COGNITO_CLIENT_ID    = "client"
    ZQ_SESSION_TTL_DAYS     = "30"
  }
}

run "function_shape_and_environment_contract" {
  command = apply

  assert {
    condition     = aws_lambda_function.this.runtime == "nodejs24.x" && jsonencode(aws_lambda_function.this.architectures) == jsonencode(["arm64"])
    error_message = "the http function must be nodejs24.x on arm64"
  }

  assert {
    condition     = aws_lambda_function.this.memory_size == 512 && aws_lambda_function.this.timeout == 10 && aws_lambda_function.this.handler == "index.handler"
    error_message = "defaults must be 512 MB, 10 s, index.handler"
  }

  # The wave 2 server-lambda build reads exactly these variables.
  assert {
    condition = jsonencode(aws_lambda_function.this.environment[0].variables) == jsonencode({
      ZQ_TARGET               = "aws"
      ZQ_TABLE_NAME           = "t"
      ZQ_SITE_ORIGIN          = "https://d111111abcdef8.cloudfront.net"
      ZQ_COGNITO_USER_POOL_ID = "us-east-1_AbCdEfG"
      ZQ_COGNITO_CLIENT_ID    = "client"
      ZQ_SESSION_TTL_DAYS     = "30"
      ZQ_MEDIA_BUCKET         = "t-media-x"
      ZQ_WS_FUNCTION_NAME     = "t-ws"
      ZQ_WARM_CONCURRENCY     = "4"
      ZQ_LOG_LEVEL            = "info"
      NODE_OPTIONS            = "--enable-source-maps"
    })
    error_message = "the environment does not match the Lambda environment contract"
  }

  assert {
    condition     = aws_cloudwatch_log_group.this.name == "/aws/lambda/t-http" && aws_cloudwatch_log_group.this.retention_in_days == 14
    error_message = "the log group must be explicit, named after the function, with retention"
  }
}

run "environment_defaults_can_be_overridden_but_wiring_cannot" {
  command = apply

  variables {
    environment = {
      ZQ_LOG_LEVEL  = "debug"
      ZQ_TABLE_NAME = "hijack"
    }
  }

  assert {
    condition     = aws_lambda_function.this.environment[0].variables["ZQ_LOG_LEVEL"] == "debug"
    error_message = "ZQ_LOG_LEVEL should be overridable"
  }

  assert {
    condition     = aws_lambda_function.this.environment[0].variables["ZQ_TABLE_NAME"] == "t"
    error_message = "wired values must win over var.environment"
  }
}

run "iam_is_least_privilege" {
  command = apply

  # Every action is named, and no resource is a bare "*".
  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.this.policy).Statement :
      alltrue([for a in tolist(s.Action) : !strcontains(a, "*")])
    ])
    error_message = "no wildcard actions"
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.this.policy).Statement :
      alltrue([for r in tolist(s.Resource) : r != "*"])
    ])
    error_message = "no bare wildcard resources"
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.this.policy).Statement :
      contains(tolist(s.Resource), "arn:aws:dynamodb:us-east-1:123456789012:table/t/index/gsi1") &&
      contains(tolist(s.Resource), "arn:aws:dynamodb:us-east-1:123456789012:table/t")
    ])
    error_message = "DynamoDB access must cover the table and the gsi1 index"
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.this.policy).Statement :
      join(",", tolist(s.Action)) == "s3:PutObject" && join(",", tolist(s.Resource)) == "arn:aws:s3:::t-media-x/media/*"
    ])
    error_message = "s3:PutObject only under the media/ prefix"
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.this.policy).Statement :
      join(",", tolist(s.Action)) == "lambda:InvokeFunction" && join(",", tolist(s.Resource)) == "arn:aws:lambda:us-east-1:123456789012:function:t-ws"
    ])
    error_message = "lambda:InvokeFunction only on the ws function"
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.this.policy).Statement :
      join(",", tolist(s.Resource)) == "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/t-http:*"
    ])
    error_message = "logs only on the function's own log group"
  }
}

run "api_routes_and_throttling" {
  command = apply

  assert {
    condition     = aws_apigatewayv2_route.api.route_key == "ANY /api/{proxy+}" && aws_apigatewayv2_route.health.route_key == "GET /api/health"
    error_message = "routes must be ANY /api/{proxy+} and GET /api/health"
  }

  assert {
    condition     = aws_apigatewayv2_integration.lambda.payload_format_version == "2.0" && aws_apigatewayv2_integration.lambda.integration_type == "AWS_PROXY"
    error_message = "Lambda proxy integration with payload format 2.0"
  }

  assert {
    condition     = aws_apigatewayv2_stage.default.name == "$default" && aws_apigatewayv2_stage.default.auto_deploy
    error_message = "$default stage with auto-deploy"
  }

  assert {
    condition     = aws_apigatewayv2_stage.default.default_route_settings[0].throttling_burst_limit == 400 && aws_apigatewayv2_stage.default.default_route_settings[0].throttling_rate_limit == 200
    error_message = "default throttling is burst 400, rate 200"
  }

  assert {
    condition     = output.api_endpoint == "https://abc123.execute-api.us-east-1.amazonaws.com"
    error_message = "the API endpoint output is the invoke URL: https, no trailing slash, no stage segment for $default"
  }
}

# The browser calls the API directly (not through CloudFront) so that sourceIp is the player's
# address, which makes every call cross-origin. The function answers CORS itself
# (ZQ_SITE_ORIGIN, ZQ_CORS_EXTRA_ORIGINS): if API Gateway also had a cors_configuration it would
# answer preflights without invoking the function and replace the function's CORS headers.
run "api_gateway_adds_no_cors_of_its_own" {
  command = apply

  assert {
    condition     = length(aws_apigatewayv2_api.this.cors_configuration) == 0
    error_message = "the API must have no cors_configuration: the function answers CORS, and API Gateway would override it"
  }

  # The default execute-api endpoint is the only way in, so it must not be disabled.
  assert {
    condition     = aws_apigatewayv2_api.this.disable_execute_api_endpoint == false
    error_message = "the default execute-api endpoint must stay enabled"
  }
}

# Preflight is an OPTIONS request. ANY includes it, and every path the app serves
# (packages/service http-app.ts: /api/health, /api/join/{pin}, /api/auth/login, /api/me,
# /api/quizzes..., /api/media/..., /api/sessions...) has a segment after /api/, so one proxy route
# covers all of them. A route that named methods without OPTIONS would break every preflight.
run "options_requests_reach_the_function" {
  command = apply

  assert {
    condition     = aws_apigatewayv2_route.api.route_key == "ANY /api/{proxy+}"
    error_message = "ANY /api/{proxy+} is what sends preflight OPTIONS requests to the function"
  }

  assert {
    condition     = aws_apigatewayv2_route.api.target == "integrations/${aws_apigatewayv2_integration.lambda.id}" && aws_apigatewayv2_route.health.target == aws_apigatewayv2_route.api.target
    error_message = "every route must target the Lambda integration"
  }

  # There is no $default route: a path outside /api gets API Gateway's own 404.
  assert {
    condition     = jsonencode([aws_apigatewayv2_route.api.route_key, aws_apigatewayv2_route.health.route_key]) == jsonencode(["ANY /api/{proxy+}", "GET /api/health"])
    error_message = "the only routes are ANY /api/{proxy+} and GET /api/health"
  }

  assert {
    condition     = !strcontains(aws_apigatewayv2_route.health.route_key, "OPTIONS") && !strcontains(aws_apigatewayv2_route.api.route_key, "OPTIONS")
    error_message = "no route names OPTIONS: ANY covers it"
  }
}

run "the_site_origins_reach_the_function_through_its_environment" {
  command = apply

  variables {
    environment = {
      ZQ_SITE_ORIGIN          = "https://quiz.example.com"
      ZQ_CORS_EXTRA_ORIGINS   = "https://d111111abcdef8.cloudfront.net,https://app.example.org"
      ZQ_COGNITO_USER_POOL_ID = "us-east-1_AbCdEfG"
      ZQ_COGNITO_CLIENT_ID    = "client"
      ZQ_SESSION_TTL_DAYS     = "30"
    }
  }

  assert {
    condition     = aws_lambda_function.this.environment[0].variables["ZQ_SITE_ORIGIN"] == "https://quiz.example.com" && aws_lambda_function.this.environment[0].variables["ZQ_CORS_EXTRA_ORIGINS"] == "https://d111111abcdef8.cloudfront.net,https://app.example.org"
    error_message = "ZQ_SITE_ORIGIN and ZQ_CORS_EXTRA_ORIGINS are the function's CORS allow-list and must be passed through unchanged"
  }
}

run "missing_package_fails_plan_with_a_precondition" {
  command = plan

  variables {
    lambda_zip = "does-not-exist.zip"
  }

  expect_failures = [aws_lambda_function.this]
}
