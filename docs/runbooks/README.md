# OVO operations runbooks

These are operator procedures, not evidence that a live AWS/carrier environment has passed them. Replace bracketed values through the environment's secret-safe configuration; never paste credentials into a shell history or incident ticket.

| Incident / change                                  | Runbook                                                     |
| -------------------------------------------------- | ----------------------------------------------------------- |
| First Fargate install or image release             | [Fargate deployment](fargate-deployment.md)                 |
| Compact single-host install                        | [Compact EC2 / Compose](compact-ec2.md)                     |
| Scaling, rollout, protection or drain              | [Scale and drain](scale-and-drain.md)                       |
| Worker crash or stale lease                        | [Worker loss reconciliation](worker-loss-reconciliation.md) |
| Carrier, speech, inference or tool provider outage | [Provider outage](provider-outage.md)                       |
| Control/orchestration database restore             | [Backup restore](backup-restore.md)                         |
| Provider credential exposure or rotation           | [Credential incident](credential-incident.md)               |
| Recording or export finalization failure           | [Recording/export failure](recording-export-failure.md)     |
| Budget, quota or unexpected spend                  | [Cost incident](cost-incident.md)                           |

Proposed operational targets remain gates until drilled: detect a stale worker within 15 seconds, begin reconciliation within 30 seconds, control-data RPO at most 5 minutes, and RTO at most 60 minutes. None implies live-audio recovery.
