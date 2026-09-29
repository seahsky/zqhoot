locals {
  function_name = "${var.name}-http"

  # The Lambda environment needs the site URL. The API's CORS allow-list needs it too, but the API
  # depends on nothing else here: the integration, routes and permission are what point at the
  # function, so the Lambda environment never feeds back into the API.
  environment = merge(
    {
      ZQ_LOG_LEVEL = "info"
      NODE_OPTIONS = "--enable-source-maps"
    },
    var.environment,
    {
      ZQ_TARGET           = "aws"
      ZQ_TABLE_NAME       = var.table_name
      ZQ_MEDIA_BUCKET     = var.media_bucket_name
      ZQ_WS_FUNCTION_NAME = var.ws_function_name
      ZQ_WARM_CONCURRENCY = tostring(var.warm_concurrency)
    },
  )
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/aws/lambda/${local.function_name}"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "this" {
  name = local.function_name

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "LambdaAssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# Least privilege, ADR-0013. Written with jsonencode rather than aws_iam_policy_document so the
# tests can read the policy back without a real provider.
resource "aws_iam_role_policy" "this" {
  name = "least-privilege"
  role = aws_iam_role.this.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "TableItems"
        Effect = "Allow"
        # Mirrors ADR-0013. DynamoDB authorises TransactWriteItems through the underlying item actions.
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
          "dynamodb:BatchWriteItem",
          "dynamodb:TransactWriteItems",
          "dynamodb:ConditionCheckItem",
        ]
        Resource = [var.table_arn, var.gsi_arn]
      },
      {
        Sid      = "PresignedUploadsToMediaPrefix"
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = ["${var.media_bucket_arn}/media/*"] # key prefix, not an open resource
      },
      {
        Sid      = "WarmUpWebSocketFunction"
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction"]
        Resource = [var.ws_function_arn]
      },
      {
        Sid      = "OwnLogGroup"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = ["${aws_cloudwatch_log_group.this.arn}:*"] # log streams inside this group only
      },
    ]
  })
}

resource "aws_lambda_function" "this" {
  function_name = local.function_name
  role          = aws_iam_role.this.arn

  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  handler       = "index.handler"
  memory_size   = var.memory_size
  timeout       = var.timeout

  filename = var.lambda_zip
  # Null while the zip has not been built, so validate works on a clean checkout and plan reports
  # the precondition below instead of a missing-file error from deep inside the provider.
  source_code_hash = fileexists(var.lambda_zip) ? filebase64sha256(var.lambda_zip) : null

  environment {
    variables = local.environment
  }

  # Without this the function could create its own log group on first invoke, with no retention.
  depends_on = [aws_cloudwatch_log_group.this, aws_iam_role_policy.this]

  lifecycle {
    precondition {
      condition     = fileexists(var.lambda_zip)
      error_message = "Lambda package not found at ${var.lambda_zip}. Build it first: pnpm --filter @zqhoot/server-lambda build (scripts/deploy-aws.sh does this)."
    }
  }
}

# The browser calls this API directly at its execute-api endpoint, not through CloudFront, so that
# requestContext.http.sourceIp is the player's address and the per-IP limits (ADR-0013) count
# clients rather than CloudFront edges (ADR-0002). That makes every call cross-origin.
resource "aws_apigatewayv2_api" "this" {
  name          = local.function_name
  protocol_type = "HTTP"

  # The browser needs the default endpoint; never turn it off.
  disable_execute_api_endpoint = false

  # API Gateway answers preflight OPTIONS itself when CORS is configured, so there is no OPTIONS
  # route. It also discards any CORS header the function returns and adds these instead.
  # No authorizer: the function verifies Cognito ID tokens itself (ADR-0009).
  cors_configuration {
    allow_origins = var.allowed_origins
    allow_methods = ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
    allow_headers = ["authorization", "content-type"]
    # Lets the browser read the file name of the results CSV download.
    expose_headers = ["content-disposition"]
    max_age        = 86400 # the most API Gateway accepts
    # Bearer tokens in a header, no cookies: credentialed CORS is never needed.
    allow_credentials = false
  }
}

resource "aws_apigatewayv2_integration" "lambda" {
  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "AWS_PROXY"
  integration_method     = "POST"
  integration_uri        = aws_lambda_function.this.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "api" {
  api_id    = aws_apigatewayv2_api.this.id
  route_key = "ANY /api/{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

resource "aws_apigatewayv2_route" "health" {
  api_id    = aws_apigatewayv2_api.this.id
  route_key = "GET /api/health"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.this.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = var.throttle_burst_limit
    throttling_rate_limit  = var.throttle_rate_limit
  }

  # Create the stage after the routes so its first automatic deployment already contains them.
  depends_on = [aws_apigatewayv2_route.api, aws_apigatewayv2_route.health]
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowInvokeFromHttpApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.this.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this.execution_arn}/*/*" # any stage and route of this one API
}
