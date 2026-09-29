data "aws_region" "current" {}

locals {
  function_name = "${var.name}-ws"

  # Built from the API id and the stage variable, not from the stage resource, so the function
  # (which the API's routes point at) never depends on the stage.
  callback_url = "https://${aws_apigatewayv2_api.this.id}.execute-api.${data.aws_region.current.region}.amazonaws.com/${var.stage_name}"

  environment = merge(
    {
      ZQ_LOG_LEVEL = "info"
      NODE_OPTIONS = "--enable-source-maps"
    },
    var.environment,
    {
      ZQ_TARGET          = "aws"
      ZQ_TABLE_NAME      = var.table_name
      ZQ_WS_CALLBACK_URL = local.callback_url
    },
  )

  routes = toset(["$connect", "$disconnect", "$default"])
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
        Resource = [var.table_arn]
      },
      {
        Sid    = "PostAndDeleteConnections"
        Effect = "Allow"
        Action = ["execute-api:ManageConnections"]
        # The /@connections/* segment is the connection id, which is only known at runtime.
        Resource = [
          "${aws_apigatewayv2_api.this.execution_arn}/${var.stage_name}/POST/@connections/*",
          "${aws_apigatewayv2_api.this.execution_arn}/${var.stage_name}/DELETE/@connections/*",
        ]
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

resource "aws_apigatewayv2_api" "this" {
  name                       = local.function_name
  protocol_type              = "WEBSOCKET"
  route_selection_expression = "$request.body.type"
}

resource "aws_apigatewayv2_integration" "lambda" {
  api_id             = aws_apigatewayv2_api.this.id
  integration_type   = "AWS_PROXY"
  integration_method = "POST"
  integration_uri    = aws_lambda_function.this.invoke_arn
}

resource "aws_apigatewayv2_route" "this" {
  for_each = local.routes

  api_id    = aws_apigatewayv2_api.this.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

resource "aws_cloudwatch_log_group" "access" {
  count = var.enable_access_logs ? 1 : 0

  name              = "/aws/apigateway/${local.function_name}"
  retention_in_days = var.log_retention_days
}

resource "aws_apigatewayv2_stage" "this" {
  api_id      = aws_apigatewayv2_api.this.id
  name        = var.stage_name
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = var.throttle_burst_limit
    throttling_rate_limit  = var.throttle_rate_limit
  }

  dynamic "access_log_settings" {
    for_each = aws_cloudwatch_log_group.access

    content {
      destination_arn = access_log_settings.value.arn
      format = jsonencode({
        requestId        = "$context.requestId"
        routeKey         = "$context.routeKey"
        eventType        = "$context.eventType"
        connectionId     = "$context.connectionId"
        status           = "$context.status"
        requestTimeEpoch = "$context.requestTimeEpoch"
        errorMessage     = "$context.error.message"
      })
    }
  }

  # Create the stage after the routes so its first automatic deployment already contains them.
  depends_on = [aws_apigatewayv2_route.this]
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowInvokeFromWebSocketApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.this.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this.execution_arn}/${var.stage_name}/*" # every route of this API's stage
}
