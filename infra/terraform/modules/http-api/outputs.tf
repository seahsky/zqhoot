output "api_endpoint" {
  description = "HTTP API invoke URL (https://{id}.execute-api.{region}.amazonaws.com, no trailing slash). The browser calls it directly, so it is the web app's apiBaseUrl."
  value       = aws_apigatewayv2_api.this.api_endpoint
}

output "allowed_origins" {
  description = "Origins the API's CORS configuration allows, read back from the API resource."
  value       = sort(tolist(one(aws_apigatewayv2_api.this.cors_configuration).allow_origins))
}

output "function_name" {
  description = "Name of the http Lambda function."
  value       = aws_lambda_function.this.function_name
}

output "function_arn" {
  description = "ARN of the http Lambda function."
  value       = aws_lambda_function.this.arn
}

output "environment" {
  description = "The complete environment of the Lambda function: var.environment merged with the values this module wires."
  value       = local.environment
}
