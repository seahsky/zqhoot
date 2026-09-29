# Run from this directory:  tflint --recursive --config "$(pwd)/.tflint.hcl"
# validate.sh does that for you.

config {
  # Follow the local ./modules calls so the envs are checked together with the modules they use.
  call_module_type = "local"
}

# Bundled with tflint. The recommended preset covers typed variables, required version and
# providers, unused declarations and standard module structure, among others.
plugin "terraform" {
  enabled = true
  preset  = "recommended"
}

# Not part of the recommended preset, but every module documents its interface and follows
# snake_case names, so keep it that way.
rule "terraform_documented_variables" {
  enabled = true
}

rule "terraform_documented_outputs" {
  enabled = true
}

rule "terraform_naming_convention" {
  enabled = true
}

# Without source/version tflint uses the plugin already installed at
# ~/.tflint.d/plugins/tflint-ruleset-aws (the offline build environment has it there).
plugin "aws" {
  enabled = true
}

# On a normal workstation, replace the block above with this one and run `tflint --init`:
#
# plugin "aws" {
#   enabled = true
#   version = "0.49.0"
#   source  = "github.com/terraform-linters/tflint-ruleset-aws"
# }
