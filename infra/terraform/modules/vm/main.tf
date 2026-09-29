data "aws_region" "current" {}

data "aws_caller_identity" "current" {}

# Canonical's Ubuntu 24.04 LTS (noble) arm64 server image, gp3-backed. The name filter follows the
# pattern Canonical publishes: ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-YYYYMMDD.
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*"]
  }

  filter {
    name   = "architecture"
    values = ["arm64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

locals {
  ssm_path = "/zqhoot/${var.name}"

  user_data = templatefile("${path.module}/user_data.sh.tftpl", {
    region           = data.aws_region.current.region
    ssm_path         = local.ssm_path
    repo_url         = var.repo_url
    repo_ref         = var.repo_ref
    domain           = var.domain
    fetch_env_script = file("${path.module}/files/fetch-env.sh")
    unit_file        = file("${path.module}/files/zqhoot.service")
  })

  web_ingress = {
    http_ipv4  = { port = 80, cidr_ipv4 = "0.0.0.0/0", cidr_ipv6 = null }
    http_ipv6  = { port = 80, cidr_ipv4 = null, cidr_ipv6 = "::/0" }
    https_ipv4 = { port = 443, cidr_ipv4 = "0.0.0.0/0", cidr_ipv6 = null }
    https_ipv6 = { port = 443, cidr_ipv4 = null, cidr_ipv6 = "::/0" }
  }
}

resource "aws_iam_role" "this" {
  name = "${var.name}-vm"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "Ec2AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.this.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# Written with jsonencode rather than aws_iam_policy_document so the tests can read the policy
# back without a real provider.
resource "aws_iam_role_policy" "parameters" {
  name = "read-own-parameters"
  role = aws_iam_role.this.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ReadOwnParameters"
        Effect = "Allow"
        Action = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
        # GetParametersByPath is authorised against the path itself as well as the parameters
        # below it. The trailing /* is the parameter name, one per environment variable.
        Resource = [
          "arn:aws:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_path}",
          "arn:aws:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_path}/*",
        ]
      },
      {
        Sid    = "DecryptWithAwsManagedSsmKey"
        Effect = "Allow"
        Action = ["kms:Decrypt"]
        # The key id behind alias/aws/ssm is not known until the first SecureString is written, so
        # the resource is any key in this account and Region, narrowed by the condition below.
        Resource = "arn:aws:kms:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:key/*"
        # SecureStrings use the AWS-managed alias/aws/ssm key. Allowing Decrypt only when the call
        # comes through SSM keeps the role from using any key directly, and no customer-managed
        # key is created.
        Condition = {
          StringEquals = { "kms:ViaService" = "ssm.${data.aws_region.current.region}.amazonaws.com" }
        }
      },
    ]
  })
}

resource "aws_iam_instance_profile" "this" {
  name = "${var.name}-vm"
  role = aws_iam_role.this.name
}

resource "aws_security_group" "this" {
  name        = "${var.name}-vm"
  description = "zqhoot VM: HTTP and HTTPS from anywhere, SSH only if ssh_cidr is set"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "web" {
  for_each = local.web_ingress

  security_group_id = aws_security_group.this.id
  description       = "Public web traffic (Caddy)"
  ip_protocol       = "tcp"
  from_port         = each.value.port
  to_port           = each.value.port
  cidr_ipv4         = each.value.cidr_ipv4
  cidr_ipv6         = each.value.cidr_ipv6
}

resource "aws_vpc_security_group_ingress_rule" "ssh" {
  count = var.ssh_cidr == null ? 0 : 1

  security_group_id = aws_security_group.this.id
  description       = "SSH from the operator"
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
  cidr_ipv4         = var.ssh_cidr
}

# The instance pulls packages, images and the repository, and talks to SSM.
resource "aws_vpc_security_group_egress_rule" "all_ipv4" {
  security_group_id = aws_security_group.this.id
  description       = "All outbound IPv4"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "all_ipv6" {
  security_group_id = aws_security_group.this.id
  description       = "All outbound IPv6"
  ip_protocol       = "-1"
  cidr_ipv6         = "::/0"
}

resource "aws_instance" "this" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  subnet_id              = var.subnet_id
  vpc_security_group_ids = [aws_security_group.this.id]
  iam_instance_profile   = aws_iam_instance_profile.this.name

  user_data                   = local.user_data
  user_data_replace_on_change = false

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required" # IMDSv2 only
    # One hop keeps containers off the instance role: only the host reads the parameters.
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_size
    encrypted             = true # AWS-managed EBS key: no monthly key fee
    delete_on_termination = true
  }

  tags = {
    Name = var.name
  }

  # The instance keeps live game state on its own disk. A newer AMI or an edited bootstrap script
  # must not replace it behind the operator's back; use `terraform apply -replace` on purpose.
  lifecycle {
    ignore_changes = [ami, user_data]
  }
}

resource "aws_eip" "this" {
  domain   = "vpc"
  instance = aws_instance.this.id

  tags = {
    Name = var.name
  }
}
