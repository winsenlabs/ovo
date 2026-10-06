# Offsite backups and the restore drill (Compose host)

**Trigger:** nightly (timer), monthly (drill), and any loss of the VM, its disk or its database.
**Owner:** the founder. **Signals:** `journalctl -u ovo-backup`, the heartbeat service, the drill's
JSON line.

The production restore procedure itself (isolation, the ownership fence, reconciliation, team-access
recovery) is [backup-restore.md](backup-restore.md); this runbook covers taking the backups offsite on
a schedule and rehearsing the restore.

## What is backed up, where

`scripts/backup/ovo-backup.sh`, run nightly at 03:15 IST by `ovo-backup.timer`:

| Item                                                                                               | How                                                                                                                                  | Where                                                                                           |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| PostgreSQL (every OVO table: control, orchestration, ledger, speech clips, telemetry, outcomes, …) | `pg_dump --format=custom` of the whole database, inside the bundled postgres container (or with `PGPASSFILE` for a managed database) | inside the archive                                                                              |
| `infra/compose/.env` (the secrets master key, session secret, generated passwords)                 | copied                                                                                                                               | inside the archive                                                                              |
| Manifest                                                                                           | checksums and per-table row counts                                                                                                   | inside the archive                                                                              |
| The archive                                                                                        | `tar` sealed with `age` to `OVO_OPS_BACKUP_AGE_RECIPIENT`                                                                            | `gs://<bucket>/postgres/YYYY/MM/ovo-<UTC stamp>.tar.age` and the newest 3 in `/var/backups/ovo` |
| Recordings volume                                                                                  | `gcloud storage rsync` mirror (deletions propagate, so retention and deletion tombstones hold offsite)                               | `gs://<bucket>/recordings/`                                                                     |

- The bucket (created by `scripts/backup/gcs-bucket-setup.sh`) is in asia-south1, private, versioned,
  with 14-day soft delete. Archives expire after 35 days, overwritten or deleted versions after 30.
- The archive holds the master key, so it is **always** encrypted before upload; the script refuses
  to upload a plain one. Only the age private key, kept offline, opens it. Losing that key loses the
  backups; losing the master key without a backup loses every stored provider credential.
- No password appears on a command line or in a log: the database password goes through a mode-0600
  `PGPASSFILE`, the heartbeat URL through curl's stdin.
- After success it pings `OVO_OPS_BACKUP_HEARTBEAT_URL`. Configure that check (healthchecks.io or
  similar) to alert when no ping arrives for **26 hours**: that is the "backup is stale" alarm.
- Recordings are not encrypted client-side (they rely on the private bucket and Google-managed
  encryption); they are personal data, so the bucket must stay in India and access-restricted.

Run one by hand: `sudo scripts/backup/ovo-backup.sh` (`--dry-run` prints the plan, `--skip-upload`
keeps it local, `--skip-recordings` skips the mirror).

## Restore

```sh
gcloud storage ls gs://<bucket>/postgres/**            # pick an archive
OVO_RESTORE_TARGET_URL='postgresql://ovo:…@127.0.0.1:54329/ovo_restored' \
  scripts/backup/ovo-restore.sh --archive gs://<bucket>/postgres/…/ovo-….tar.age --identity age-key.txt --yes
```

It verifies the checksums, `pg_restore --clean --if-exists --exit-on-error` into the **isolated**
target (it refuses the live `DATABASE_URL`), applies `scripts/postgres-restore-fence.sql` and prints
per-table row-count differences against the manifest. Then continue with steps 6-10 of
[backup-restore.md](backup-restore.md) (tombstones, reconciliation, team access) before any traffic.

To recover only the secrets (for example a lost `.env` on a rebuilt VM):
`scripts/backup/ovo-restore.sh --archive … --identity age-key.txt --extract-to /root/ovo-restore`
and copy the values you need from `compose.env` (mode 0600; delete the directory afterwards).

### Rebuilding the VM from nothing

1. New VM (see [compact-gcp.md](compact-gcp.md)), Docker, Caddy, `age`, the repository checkout.
2. Extract `compose.env` from the newest archive and install it as `infra/compose/.env` (mode 0600).
3. `docker compose … up -d --wait postgres` on the bundled profile, create an empty `ovo_restored`
   database, restore into it as above, then point `DATABASE_URL` at it (or rename it to `ovo` while
   nothing else is connected).
4. `scripts/deploy/deploy-compose.sh --images <pins>` with live flags still off, then the
   backup-restore.md steps, then `ovo-live.sh on`.
5. Restore the recordings mirror: `gcloud storage rsync --recursive gs://<bucket>/recordings <volume mountpoint>`.

## Monthly restore drill

```sh
scripts/backup/restore-drill.sh --identity age-key.txt
```

It takes the newest archive in the bucket, fails if it is older than 26 hours (`--max-age-hours`),
creates a scratch database on the bundled PostgreSQL (or `OVO_DRILL_SERVER_URL`), restores and fences
it with `ovo-restore.sh`, compares row counts, drops the scratch database (`--keep` to inspect it) and
prints `{"operation":"restore-drill", …, "restore_seconds": N}`. Record that line, the archive name and
the date in the drill log; `restore_seconds` is the measured database part of the RTO. The drill never
touches the live database. Run it in a quiet hour: it reads the archive over the network and loads
the host while it restores.

## When the heartbeat alert fires

1. `systemctl status ovo-backup.timer ovo-backup.service` and `journalctl -u ovo-backup -n 100`.
2. Typical causes: the bucket permission (`roles/storage.objectUser` for the VM service account),
   `age` missing, a full `/var/backups` disk, the postgres container down.
3. Fix, then `sudo systemctl start ovo-backup.service` and confirm the heartbeat.
