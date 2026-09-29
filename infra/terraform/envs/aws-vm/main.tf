provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project    = "zqhoot"
      Deployment = var.name
      ManagedBy  = "terraform"
    }
  }
}

module "vm" {
  source = "../../modules/vm"

  name          = var.name
  instance_type = var.instance_type
  repo_url      = var.repo_url
  repo_ref      = var.repo_ref
  domain        = var.domain
  ssh_cidr      = var.ssh_cidr
}
