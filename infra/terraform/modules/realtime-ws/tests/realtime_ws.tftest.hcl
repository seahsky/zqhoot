# Offline test against a mocked AWS provider: terraform test needs no credentials.

mock_provider "aws" {
  mock_data "aws_region" {
    defaults = {
      region = "us-east-1"
    }
  }

  mock_resource "aws_apigatewayv2_api" {
    defaults = {
      id            = "abc123"
      api_endpoint  = "wss://abc123.execute-api.us-east-1.amazonaws.com"
      execution_arn = "arn:aws:execute-api:us-east-1:123456789012:abc123"
    }
  }

  mock_resource "aws_cloudwatch_log_group" {
    defaults = {
      arn = "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/t-ws"
    }
  }

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/t-ws"
    }
  }

  mock_resource "aws_lambda_function" {
    defaults = {
      arn        = "arn:aws:lambda:us-east-1:123456789012:function:t-ws"
      invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:t-ws/invocations"
    }
  }
}

variables {
  name       = "t"
  lambda_zip = "main.tf" # any file that exists: the mock never reads it
  table_name = "t"
  table_arn  = "arn:aws:dynamodb:us-east-1:123456789012:table/t"
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
    error_message = "the ws function must be nodejs24.x on arm64"
  }

  assert {
    condition     = aws_lambda_function.this.memory_size == 512 && aws_lambda_function.this.timeout == 30 && aws_lambda_function.this.handler == "index.handler"
    error_message = "defaults must be 512 MB, 30 s, index.handler"
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
      ZQ_WS_CALLBACK_URL      = "https://abc123.execute-api.us-east-1.amazonaws.com/live"
      ZQ_LOG_LEVEL            = "info"
      NODE_OPTIONS            = "--enable-source-maps"
    })
    error_message = "the environment does not match the Lambda environment contract"
  }

  assert {
    condition     = aws_cloudwatch_log_group.this.name == "/aws/lambda/t-ws" && aws_cloudwatch_log_group.this.retention_in_days == 14
    error_message = "the log group must be explicit, named after the function, with retention"
  }
}

run "iam_is_least_privilege" {
  command = apply

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
      join(",", tolist(s.Action)) == "execute-api:ManageConnections" &&
      join(",", tolist(s.Resource)) == "arn:aws:execute-api:us-east-1:123456789012:abc123/live/POST/@connections/*,arn:aws:execute-api:us-east-1:123456789012:abc123/live/DELETE/@connections/*"
    ])
    error_message = "ManageConnections only on POST and DELETE @connections of this API's stage"
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.this.policy).Statement :
      join(",", tolist(s.Resource)) == "arn:aws:dynamodb:us-east-1:123456789012:table/t"
    ])
    error_message = "DynamoDB access on the table only (no index)"
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.this.policy).Statement :
      join(",", tolist(s.Resource)) == "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/t-ws:*"
    ])
    error_message = "logs only on the function's own log group"
  }
}

run "api_routes_stage_and_outputs" {
  command = apply

  assert {
    condition     = aws_apigatewayv2_api.this.protocol_type == "WEBSOCKET" && aws_apigatewayv2_api.this.route_selection_expression == "$request.body.type"
    error_message = "WebSocket API selecting routes by $request.body.type"
  }

  assert {
    condition     = jsonencode(sort(keys(aws_apigatewayv2_route.this))) == jsonencode(["$connect", "$default", "$disconnect"])
    error_message = "routes must be $connect, $disconnect and $default"
  }

  assert {
    condition     = aws_apigatewayv2_integration.lambda.integration_type == "AWS_PROXY"
    error_message = "AWS_PROXY integration"
  }

  assert {
    condition     = aws_apigatewayv2_stage.this.name == "live" && aws_apigatewayv2_stage.this.auto_deploy
    error_message = "stage live with auto-deploy"
  }

  assert {
    condition     = aws_apigatewayv2_stage.this.default_route_settings[0].throttling_burst_limit == 1000 && aws_apigatewayv2_stage.this.default_route_settings[0].throttling_rate_limit == 2000
    error_message = "default throttling is burst 1000, rate 2000"
  }

  assert {
    condition     = length(aws_apigatewayv2_stage.this.access_log_settings) == 0 && length(aws_cloudwatch_log_group.access) == 0
    error_message = "access logging is off by default"
  }

  assert {
    condition     = output.wss_url == "wss://abc123.execute-api.us-east-1.amazonaws.com/live" && output.callback_url == "https://abc123.execute-api.us-east-1.amazonaws.com/live"
    error_message = "wss_url and callback_url do not match the documented shapes"
  }
}

run "access_logs_exclude_ip_and_query_string" {
  command = apply

  variables {
    enable_access_logs = true
    stage_name         = "prod"
  }

  assert {
    condition     = length(aws_apigatewayv2_stage.this.access_log_settings) == 1
    error_message = "access logging should turn on with enable_access_logs"
  }

  assert {
    condition     = !strcontains(aws_apigatewayv2_stage.this.access_log_settings[0].format, "sourceIp") && !strcontains(aws_apigatewayv2_stage.this.access_log_settings[0].format, "queryString")
    error_message = "the access log format must not contain the client IP or the query string (ADR-0009)"
  }

  assert {
    condition     = output.callback_url == "https://abc123.execute-api.us-east-1.amazonaws.com/prod"
    error_message = "the stage name flows into callback_url"
  }
}

run "missing_package_fails_plan_with_a_precondition" {
  command = plan

  variables {
    lambda_zip = "does-not-exist.zip"
  }

  expect_failures = [aws_lambda_function.this]
}
