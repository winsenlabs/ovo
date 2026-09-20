# PostgreSQL backup restore

**Trigger:** approved restore drill or control/orchestration data loss/corruption.  
**Owner:** database/platform on-call; security owner for deletion-state review.  
**Goals:** RPO ≤5 minutes and RTO ≤60 minutes are proposed, not achieved, until measured on the selected database platform.

## Procedure

1. Stop API mutations, outbox publication, queue consumption, capacity writes and carrier admission. Preserve logs and record the restore point.
2. Restore to an isolated database first; validate checksums/platform status and migration level. Do not point workers at it yet.
3. Reapply deletion tombstones/retention decisions that occurred after the restore point before exposing artifacts or credentials.
4. Reconcile every nonterminal job, dial request, carrier call, operation and outbox row against external providers. Treat sent-but-unmarked outbox rows as duplicate-capable. Treat unknown dial/write outcomes as reconciliation-only.
5. Fence pre-restore ownership/capacity epochs. Start one dispatcher, verify its leader epoch, then API and synthetic workers. Keep carrier admission disabled.
6. Run a synthetic job/outbox/ten-delivery ownership check and verify event/audit projections can rebuild. Reopen admission gradually after approval.

## Rollback and verification

If validation fails, keep the original environment read-only and restore another point; never merge ownership rows ad hoc. Retain backup ID, restore timestamps, migration output, tombstone replay, reconciled IDs/counts, duplicate simulation and measured RPO/RTO.

The current local control SQLite and PostgreSQL orchestration stores do not yet have one production restore boundary. This runbook cannot pass end to end until the production control store is PostgreSQL or a coordinated restore design is implemented and drilled.
