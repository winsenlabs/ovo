# Fargate primary profile

This is configuration only. It has not been applied to an AWS account and is not deployment evidence.

## Boundaries

- Uses an existing VPC with public ALB subnets, private task subnets with NAT or equivalent egress, an existing PostgreSQL database security group, ACM certificate, and Secrets Manager JSON secret.
- Runs API, console, dispatcher, media gateway, and one-slot workers on Fargate. PostgreSQL, SQS, Secrets Manager, ALB, Cloud Map, and CloudWatch are declared managed dependencies, not “application compute.”
- Application Auto Scaling alone writes the worker service's desired count. The dispatcher publishes capacity metrics and runs durable background tasks; it has no `ecs:UpdateService` permission. Terraform ignores worker `desired_count` drift after bootstrap.
- Workers alone consume SQS and update task protection. Protection failure must prevent dial admission.
- Security groups permit public TLS only to the ALB, ALB-to-app ports, gateway-to-worker port 4100, PostgreSQL 5432, and outbound HTTPS. Private subnets need DNS and NAT/VPC endpoints supplied by the surrounding VPC.

## Offline review

1. Copy `terraform.tfvars.example` outside version control and replace placeholders.
2. Inspect `terraform plan`; do not use floating image tags.
3. Confirm the runtime secret contains `DATABASE_URL`, `OVO_SECRETS_MASTER_KEY`, `OVO_CARRIER_ENV_BINDINGS`, `OVO_SESSION_SECRET`, `OVO_SEED_ADMIN_EMAIL`, `OVO_SEED_ADMIN_PASSWORD`, `OVO_MEDIA_WORKER_TOKEN`, and `OVO_INBOUND_ROUTE_SECRET` without printing it.
4. Confirm PostgreSQL backups/PITR, deletion protection, TLS requirements, and migrations in the database platform that owns the control schema.
5. Confirm carrier callback URLs, DNS, certificate, NAT/VPC endpoint routing, quotas, and desired-count maximums.

The dispatcher receives `carrier_concurrency`, `provider_concurrency`, and `spend_permitted_starts` as configured capacity ceilings. Each defaults to 100. Raise these values only after checking the carrier, provider, and spend limits in the deployed environment; these Terraform values are configuration, not a live quota feed. `worker_max_capacity` remains the overall ceiling.

The S3 backend example uses Terraform 1.10's `use_lockfile = true` for state locking. If adapting this profile for an older Terraform version, lower `required_version` and configure `dynamodb_table` with a pre-existing lock table instead. Review the locking migration before switching methods.

Do not apply this profile until the runbook gates in `docs/runbooks/fargate-deployment.md` pass. The media gateway executable/routing handshake and control API currently remain integration gates; Terraform resources do not prove those application paths.
