output "api_endpoint" {
  description = "HTTP API base URL (https://...)."
  value       = aws_apigatewayv2_api.this.api_endpoint
}

output "api_domain" {
  description = "HTTP API host name without scheme, used as the CloudFront custom origin."
  value       = trimprefix(aws_apigatewayv2_api.this.api_endpoint, "https://")
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
