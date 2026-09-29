# vm

One EC2 instance that runs the single-process Docker Compose stack
([ADR-0015](../../../../docs/adr/0015-vm-deployment.md)). It has no secrets in Terraform, state or
`user_data`: the app's environment is read from SSM Parameter Store at boot.

## Resources

- **Instance**: `t4g.small` by default (any Graviton type; the AMI is arm64), Ubuntu 24.04 LTS from
  Canonical (owner `099720109477`, name filter
  `ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*`, most recent). Encrypted gp3 root
  volume (20 GB by default, AWS-managed EBS key), IMDSv2 required with a hop limit of 1 so
  containers cannot reach the instance role.
- **Security group**: 80 and 443 from `0.0.0.0/0` and `::/0`; 22 only if `ssh_cidr` is set; all
  outbound. **Elastic IP** attached.
- **Instance profile**: `AmazonSSMManagedInstanceCore` (Session Manager), `ssm:GetParameter`,
  `GetParameters` and `GetParametersByPath` on `parameter/zqhoot/{name}` and `parameter/zqhoot/{name}/*`,
  and `kms:Decrypt` on keys in the account and Region only when called through
  `ssm.{region}.amazonaws.com` (the AWS-managed `alias/aws/ssm` key that SecureStrings use; no
  customer-managed key exists).
- **`user_data`** ([user_data.sh.tftpl](user_data.sh.tftpl)): installs `docker.io`,
  `docker-compose-v2`, `git`, `jq`, `unzip`, `curl`, `ca-certificates` from the Ubuntu archive and AWS
  CLI v2 from `awscli.amazonaws.com` (`awscli` is not in the noble archive); clones `var.repo_url`
  at `var.repo_ref` into `/opt/zqhoot`; writes `/etc/zqhoot/vm.conf`
  (region, SSM path, domain: nothing secret), [`zqhoot-fetch-env`](files/fetch-env.sh) and
  [`zqhoot.service`](files/zqhoot.service); enables and starts the unit without blocking cloud-init.
- **`zqhoot.service`** (runs on every boot): `zqhoot-fetch-env` waits for `/zqhoot/{name}/_READY`,
  then renders every parameter under `/zqhoot/{name}/` to `/opt/zqhoot/deploy/vm/.env` (mode 600,
  values single-quoted so `$` survives Compose interpolation; a value containing a single quote or
  newline is refused), then `docker compose -f deploy/vm/docker-compose.yml up -d --build`. Stopping
  the unit runs `docker compose down`, so the app gets its `SIGTERM` snapshot on shutdown.
  `scripts/vm-put-secrets.sh` writes the parameters and the marker.

## Inputs

| Name               | Type   | Default     | Description                                                                 |
| ------------------ | ------ | ----------- | --------------------------------------------------------------------------- |
| `name`             | string | required    | Names the instance and security group; scopes `/zqhoot/{name}/`.            |
| `repo_url`         | string | required    | HTTPS clone URL, readable without credentials.                              |
| `repo_ref`         | string | `"main"`    | Branch, tag or commit; pin a tag for repeatable deployments.                |
| `domain`           | string | `""`        | DNS name for Caddy (`ZQ_DOMAIN`); added to `.env` unless SSM already has it. |
| `instance_type`    | string | `"t4g.small"` | Graviton instance type.                                                   |
| `root_volume_size` | number | `20`        | Root volume size in GB.                                                     |
| `ssh_cidr`         | string | `null`      | IPv4 CIDR allowed to SSH; null keeps port 22 closed.                        |
| `vpc_id`           | string | `null`      | VPC for the security group; null uses the default VPC.                      |
| `subnet_id`        | string | `null`      | Public subnet; null lets EC2 pick one in the default VPC.                   |

`repo_url`, `repo_ref` and `domain` are written into a shell script inside single quotes, so their
validation rejects quotes, backticks, `$`, backslashes and whitespace.

## Outputs

`public_ip`, `instance_id`, `ssm_parameter_path` (`/zqhoot/{name}`).

## Notes

- `lifecycle.ignore_changes = [ami, user_data]`: the instance holds live game state on its disk, so
  a newer AMI or an edited bootstrap script must not replace it. Replace it deliberately with
  `terraform apply -replace=module.vm.aws_instance.this`, or upgrade in place (see the parent README).
- Package names were checked against the `noble` and `noble-updates` arm64 indexes and with
  `apt-cache` on an Ubuntu 24.04 host, not on an EC2 instance. The unit passes
  `systemd-analyze verify` on systemd 255.4 (Ubuntu 24.04's version). The AMI name filter and the
  AWS CLI installer step are unverified on AWS.
