output "wss_url" {
  description = "WebSocket URL clients connect to: wss://{api id}.execute-api.{region}.amazonaws.com/{stage}."
  value       = "${aws_apigatewayv2_api.this.api_endpoint}/${var.stage_name}"
}

output "callback_url" {
  description = "Management API URL the function posts to (ZQ_WS_CALLBACK_URL)."
  value       = local.callback_url
}

output "api_id" {
  description = "WebSocket API ID."
  value       = aws_apigatewayv2_api.this.id
}

output "stage_name" {
  description = "WebSocket API stage name."
  value       = var.stage_name
}

output "function_name" {
  description = "Name of the ws Lambda function."
  value       = aws_lambda_function.this.function_name
}

output "function_arn" {
  description = "ARN of the ws Lambda function."
  value       = aws_lambda_function.this.arn
}

output "environment" {
  description = "The complete environment of the Lambda function: var.environment merged with the values this module wires."
  value       = local.environment
}
