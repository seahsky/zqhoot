variable "region" {
  description = "AWS Region."
  type        = string
  default     = "us-east-1"
}

variable "name" {
  description = "Deployment name. Names the instance and scopes the SSM parameter path /zqhoot/{name}/. Use a different name for each deployment in the same account: the IAM role is account-wide."
  type        = string
  default     = "zqhoot"
}

variable "instance_type" {
  description = "EC2 instance type. Must be Graviton (arm64)."
  type        = string
  default     = "t4g.small"
}

variable "repo_url" {
  description = "HTTPS URL of the repository the instance clones. It must be readable without credentials."
  type        = string
}

variable "repo_ref" {
  description = "Branch, tag or commit to deploy. Pin a tag or commit for repeatable deployments."
  type        = string
  default     = "main"
}

variable "domain" {
  description = "Public DNS name Caddy gets a certificate for (ZQ_DOMAIN). Its A record must point at the public_ip output before Caddy can obtain the certificate."
  type        = string
  default     = ""
}

variable "ssh_cidr" {
  description = "IPv4 CIDR allowed to reach SSH. Null keeps port 22 closed; use SSM Session Manager instead."
  type        = string
  default     = null
}
