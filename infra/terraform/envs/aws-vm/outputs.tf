output "public_ip" {
  description = "Elastic IP of the VM. Point the domain's A record here."
  value       = module.vm.public_ip
}

output "instance_id" {
  description = "EC2 instance ID."
  value       = module.vm.instance_id
}

output "ssm_parameter_path" {
  description = "SSM Parameter Store path the VM reads its environment from."
  value       = module.vm.ssm_parameter_path
}

output "next_steps" {
  description = "What to do after the first apply."
  value       = <<-EOT
    The instance is installing Docker and cloning ${var.repo_url} at ${var.repo_ref}. It then waits for its environment.

    1. Publish the app's environment (ZQ_JWT_SECRET, ZQ_ADMIN_USER, ZQ_ADMIN_PASSWORD_HASH, ...). The values go to SSM Parameter Store
       as SecureStrings and never through Terraform:
         scripts/vm-put-secrets.sh --name ${var.name} --region ${var.region} --env-file deploy/vm/.env
       The VM picks them up within a minute and starts the stack.
    2. Create a DNS A record for ${var.domain == "" ? "your domain (also set ZQ_DOMAIN in the env file)" : var.domain} pointing at ${module.vm.public_ip}.
    3. Watch progress:
         aws ssm start-session --region ${var.region} --target ${module.vm.instance_id}
         sudo tail -f /var/log/zqhoot-bootstrap.log   # first boot
         sudo journalctl -u zqhoot -f                 # waiting for the environment, then docker compose
  EOT
}
