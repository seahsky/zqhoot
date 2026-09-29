# Offline test of the composition against a mocked AWS provider: terraform test needs no
# credentials.

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

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/zqhoot-vm"
    }
  }

  mock_resource "aws_eip" {
    defaults = {
      public_ip = "203.0.113.10"
    }
  }

  mock_resource "aws_instance" {
    defaults = {
      id = "i-0123456789abcdef0"
    }
  }
}

variables {
  repo_url = "https://example.com/org/zqhoot.git"
  domain   = "quiz.example.com"
}

run "outputs_tell_the_operator_what_to_do_next" {
  command = apply

  assert {
    condition     = output.public_ip == "203.0.113.10" && output.instance_id == "i-0123456789abcdef0" && output.ssm_parameter_path == "/zqhoot/zqhoot"
    error_message = "public_ip, instance_id and ssm_parameter_path outputs"
  }

  assert {
    condition = alltrue([
      strcontains(output.next_steps, "scripts/vm-put-secrets.sh --name zqhoot --region us-east-1"),
      strcontains(output.next_steps, "quiz.example.com"),
      strcontains(output.next_steps, "203.0.113.10"),
      strcontains(output.next_steps, "i-0123456789abcdef0"),
    ])
    error_message = "next_steps must point at the secrets script, the DNS record and the SSM session"
  }
}
