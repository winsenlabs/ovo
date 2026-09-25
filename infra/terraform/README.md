# Fargate primary profile

This is configuration only. It has not been applied to an AWS account and is not deployment evidence.

## Boundaries

- Uses an existing VPC with public ALB subnets, private task subnets with NAT or equivalent egress, an existing PostgreSQL database security group, ACM certificate, and Secrets Manager JSON secret.
- Runs API, console, dispatcher, media gateway, and one-slot workers on Fargate. PostgreSQL, SQS, Secrets Manager, ALB, Cloud Map, and CloudWatch are declared managed dependencies, not “application compute.”
- The dispatcher is the only role allowed to call `ecs:UpdateService` for the worker service. No Application Auto Scaling policy exists. A PostgreSQL lease fences that writer, and Terraform ignores worker `desired_count` drift after bootstrap.
- Workers alone consume SQS and update task protection. Protection failure must prevent dial admission.
- Security groups permit public TLS only to the ALB, ALB-to-app ports, gateway-to-worker port 4100, PostgreSQL 5432, and outbound HTTPS. Private subnets need DNS and NAT/VPC endpoints supplied by the surrounding VPC.

## Offline review

1. Copy `terraform.tfvars.example` outside version control and replace placeholders.
2. Inspect `terraform plan`; do not use floating image tags.
3. Confirm the runtime secret contains `DATABASE_URL`, `TWILIO_ACCOUNT_SID`, and `TWILIO_AUTH_TOKEN` without printing it.
4. Confirm PostgreSQL backups/PITR, deletion protection, TLS requirements, and migrations in the database platform that owns the control schema.
5. Confirm carrier callback URLs, DNS, certificate, NAT/VPC endpoint routing, quotas, and desired-count maximums.

Do not apply this profile until the runbook gates in `docs/runbooks/fargate-deployment.md` pass. The media gateway executable/routing handshake and control API currently remain integration gates; Terraform resources do not prove those application paths.
