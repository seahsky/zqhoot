output "public_ip" {
  description = "Elastic IP address of the instance. Point the domain's A record here."
  value       = aws_eip.this.public_ip
}

output "instance_id" {
  description = "EC2 instance ID, for aws ssm start-session --target."
  value       = aws_instance.this.id
}

output "ssm_parameter_path" {
  description = "SSM Parameter Store path the instance reads its environment from, without a trailing slash."
  value       = local.ssm_path
}
