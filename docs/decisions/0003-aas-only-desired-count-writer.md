# ADR 0003: Application Auto Scaling owns worker desired count

Status: accepted, 2026-10-02. Supersedes the writer choice in [plugin-first Fargate §4](../08-plugin-first-fargate.md#4-service-topology-and-scaling-responsibility).

The dispatcher computes demand from durable eligibility, leases, ready capacity, schedules and quotas. Each replica publishes the same `OVO/Capacity` signal. The dispatcher has no `ecs:UpdateService` permission and never writes ECS desired count. Application Auto Scaling (AAS) is the sole desired-count writer for the worker service. Terraform creates its scalable target, target tracking policy, fast scale-out alarm and scheduled actions. The Compose profile keeps a fixed worker count and logs the signal without AAS.

The signal is not an admission grant: workers still require a ready-slot reservation, ownership fence and scale-in protection. The dispatcher emits no signal when its inputs fail, and health reports that failure. AAS policy and CloudWatch state must be checked during a scaling incident; operators must not manually race a second writer against the policy.

Evidence: `infra/terraform/terraform.contract.test.ts` checks the AAS resources and absence of `ecs:UpdateService`; `apps/dispatcher/src/dispatcher-loop.test.ts` checks independent replicas publish the computed signal. Live AWS scaling remains unverified until an authorized drill.
