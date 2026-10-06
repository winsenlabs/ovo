# OVO operations runbooks

These are operator procedures, not evidence that a live AWS/carrier environment has passed them. Replace bracketed values through the environment's secret-safe configuration; every variable is described in the [environment reference](../env-reference.md); never paste credentials into a shell history or incident ticket.

| Incident / change                                  | Runbook                                                     |
| -------------------------------------------------- | ----------------------------------------------------------- |
| Founder-approved first phone call                  | [First real call](first-real-call.md)                       |
| Buy and wire an Indian DID (Plivo)                 | [Indian DID](indian-did.md)                                 |
| First Fargate install or image release             | [Fargate deployment](fargate-deployment.md)                 |
| Compact single-host install                        | [Compact EC2 / Compose](compact-ec2.md)                     |
| Scaling, rollout, protection or drain              | [Scale and drain](scale-and-drain.md)                       |
| Single GCP VM: Spot, restarts, uptime alerts       | [Compact GCP](compact-gcp.md)                               |
| Bring ovo-dev from Wave 1 to live, in order        | [Go live](go-live.md)                                       |
| Deploy, redeploy, roll back, live on/off           | [Deploy ovo-dev](deploy-ovo-dev.md)                         |
| Worker crash or stale lease                        | [Worker loss reconciliation](worker-loss-reconciliation.md) |
| Carrier, speech, inference or tool provider outage | [Provider outage](provider-outage.md)                       |
| Control/orchestration database restore             | [Backup restore](backup-restore.md)                         |
| Nightly offsite backups and the monthly drill      | [Offsite backups](offsite-backups.md)                       |
| Provider credential exposure or rotation           | [Credential incident](credential-incident.md)               |
| Recording or export finalization failure           | [Recording/export failure](recording-export-failure.md)     |
| Budget, quota or unexpected spend                  | [Cost incident](cost-incident.md)                           |

Proposed operational targets remain gates until drilled: detect a stale worker within 15 seconds, begin reconciliation within 30 seconds, control-data RPO at most 5 minutes, and RTO at most 60 minutes. None implies live-audio recovery.
