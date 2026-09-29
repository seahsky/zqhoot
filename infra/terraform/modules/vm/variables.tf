variable "name" {
  description = "Deployment name. Names the instance and the security group, and scopes the SSM parameter path /zqhoot/{name}/."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,19}$", var.name))
    error_message = "name must be 2-20 characters: lowercase letters, digits and hyphens, starting with a letter."
  }
}

variable "instance_type" {
  description = "EC2 instance type. Must be Graviton (arm64) because the AMI is arm64."
  type        = string
  default     = "t4g.small"

  validation {
    condition     = can(regex("^[a-z]+[0-9]+g[a-z]*\\.", var.instance_type))
    error_message = "instance_type must be an arm64 (Graviton) type such as t4g.small, m7g.large or c7g.large."
  }
}

variable "root_volume_size" {
  description = "Root volume size in GB (encrypted gp3). Holds the OS, the Docker images and the app's data volume."
  type        = number
  default     = 20

  validation {
    condition     = var.root_volume_size >= 8
    error_message = "root_volume_size must be at least 8 GB, the size of the Ubuntu image."
  }
}

variable "repo_url" {
  description = "HTTPS URL of the repository to deploy. It is cloned without credentials, so it must be readable anonymously."
  type        = string

  # The value is written into a shell script inside single quotes: reject anything that could break out.
  validation {
    condition     = can(regex("^https://[A-Za-z0-9._~:/?#@!&()*+,;=%-]+$", var.repo_url))
    error_message = "repo_url must be an https:// URL without spaces, quotes, backticks, backslashes or dollar signs."
  }
}

variable "repo_ref" {
  description = "Branch, tag or commit to check out. Pin a tag or commit for repeatable deployments."
  type        = string
  default     = "main"

  validation {
    condition     = can(regex("^[A-Za-z0-9._/-]{1,100}$", var.repo_ref))
    error_message = "repo_ref may only contain letters, digits, dots, underscores, slashes and hyphens."
  }
}

variable "domain" {
  description = "Public DNS name Caddy requests a certificate for (ZQ_DOMAIN). Leave empty to set ZQ_DOMAIN yourself through vm-put-secrets.sh."
  type        = string
  default     = ""

  validation {
    condition     = var.domain == "" || can(regex("^([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?\\.)+[A-Za-z]{2,}$", var.domain))
    error_message = "domain must be empty or a DNS name such as quiz.example.com."
  }
}

variable "ssh_cidr" {
  description = "IPv4 CIDR allowed to reach SSH (port 22). Null keeps SSH closed; use SSM Session Manager instead."
  type        = string
  default     = null

  validation {
    condition     = var.ssh_cidr == null || can(cidrnetmask(var.ssh_cidr))
    error_message = "ssh_cidr must be an IPv4 CIDR block such as 203.0.113.7/32, or null."
  }
}

variable "vpc_id" {
  description = "VPC for the security group. Null uses the Region's default VPC. Set together with subnet_id."
  type        = string
  default     = null

  validation {
    condition     = var.subnet_id == null || var.vpc_id != null
    error_message = "vpc_id is required when subnet_id is set."
  }
}

variable "subnet_id" {
  description = "Public subnet for the instance. Null lets EC2 pick a default-VPC subnet."
  type        = string
  default     = null
}
