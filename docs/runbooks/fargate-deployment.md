# Fargate deployment

**Trigger:** initial environment creation or an approved immutable-image release.  
**Owner:** platform on-call; voice on-call approves carrier admission.  
**Dashboard/records:** ECS service events, ALB target health, `OVO/Capacity`, SQS/DLQ, PostgreSQL migrations/outbox, release audit.

## Preconditions

1. Review `infra/terraform/README.md`; verify private-subnet NAT/VPC endpoints, ACM/DNS, PostgreSQL TLS/backups/deletion protection, Secrets Manager fields, regional quotas, and immutable image digests.
2. Confirm the control API's current storage profile. Its local SQLite adapter is not a production peer of the PostgreSQL orchestration store. Do not call the system production-ready until control and orchestration share a supported backup/restore boundary.
3. Run unit tests and the disposable-PostgreSQL ownership integration. Live carrier, AWS routing, task protection, and load gates are separate.
4. Set inbound warm floor to zero until media routing and carrier signature gates pass; otherwise set an explicitly cost-approved floor.

## Procedure

```bash
terraform -chdir=infra/terraform fmt -check
terraform -chdir=infra/terraform init
terraform -chdir=infra/terraform validate
terraform -chdir=infra/terraform plan -out=ovo.tfplan
```

Have a second operator inspect the plan for public resources, IAM wildcard actions, secret references, worker maximum, images, and absence of Application Auto Scaling policies. Applying is an authorized human deployment step; this repository implementation did not apply it.

After an authorized apply, run migrations from a one-off task with the same dispatcher image/config before admitting work. Start API/console/dispatcher/gateway, then leave workers at zero for the scale-from-zero drill or prewarm through the dispatcher authority. Never manually race `UpdateService` against the dispatcher.

## Expected signals

- API and gateway target health are green; dispatcher has a current PostgreSQL capacity-leader epoch.
- One scale decision includes fresh mutually exclusive counts and one reason.
- A synthetic job appears in outbox, SQS, and exactly one owned attempt; no carrier dial is enabled in this check.
- Worker readiness includes plugin initialization and routing registration; task protection succeeds before any authorized dial.

## Rollback/recovery

Stop new admission first. Roll back task definitions for new sessions while active protected sessions drain. Do not force a worker count below active+reserved commitments. If protection/routing is unhealthy, keep carrier admission disabled and reconcile jobs; do not redial unknown outcomes.

## Verification record

Retain plan digest, task-definition/image digests, migration IDs, leader epoch, timestamps for zero-to-ready, target health, protection result, duplicate count, and operator names. Mark carrier/Fargate gates unverified unless an authorized live drill produced retained evidence.
