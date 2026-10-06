# Compact install on one GCP VM: Spot, restarts, alerting and the carrier fallback

**Trigger:** running OVO's Compose profile on a single Compute Engine VM (ovo-dev, asia-south1).
**Owner:** the founder. **Signals:** the Cloud Monitoring uptime alert, the external probe, the
backup heartbeat, `scripts/ops/verify-live.sh`.

One VM is one failure domain: a host failure or preemption drops every live call. This runbook makes
that failure **loud and graceful** (callers hear a message, the founder gets an alert, the stack comes
back by itself where GCP allows it); it does not make the profile highly available.

## Spot or on-demand

|                           | Spot VM                                                                             | On-demand VM                                        |
| ------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------- |
| Price                     | ~60-90% cheaper                                                                     | list price                                          |
| Stops when                | GCP needs the capacity, with **~30 s notice**, at any hour                          | host failure only; live-migrated for maintenance    |
| Live calls at that moment | cut (the drain needs up to 240 s)                                                   | live migration keeps them; a host failure cuts them |
| Comes back                | not by itself: a stopped Spot VM stays stopped (unless in a managed instance group) | `--restart-on-failure` restarts it on another host  |

**Recommendation:** on-demand (an `e2-standard-4` in asia-south1) for any customer-facing number.
Spot is fine for development and demos. If Spot must carry a real number, put it in a single-instance
managed instance group with autohealing on the `/ovo-gateway-health` check, accept that every
preemption cuts the calls in progress, and keep the steps below.

Switching an existing VM from Spot to on-demand needs it stopped:
`gcloud compute instances set-scheduling ovo-dev --zone <z> --provisioning-model=STANDARD --restart-on-failure --maintenance-policy=MIGRATE`
after `gcloud compute instances stop` (do it in a quiet window with `ovo-live.sh off` first; confirm the
flags with `gcloud compute instances set-scheduling --help` on your gcloud version).

## What is in place after setup

Run once, reading the printed plan before adding `--apply` (go-live.md step 2):

```sh
sudo scripts/ops/install-host-units.sh --apply
scripts/ops/gcp-monitoring-setup.sh --project <p> --zone <z> --instance ovo-dev \
  --host <voice host> --notification-channel <channel id> [--on-demand] --apply
```

- **Container restarts:** every service has `restart: unless-stopped`, so a crashed process restarts.
- **Boot:** `ovo-compose.service` runs `docker compose up -d --no-build --wait` at boot and
  `docker compose stop` at shutdown, which gives the gateway and workers their 300 s drain.
  `/etc/docker/daemon.json` sets `live-restore`, so restarting the Docker daemon itself (for example an
  apt upgrade) does not stop the containers.
- **Host failure:** with `--on-demand`, `restart-on-failure` brings the VM back on another host.
- **Preemption:** the instance's `shutdown-script` runs `scripts/ops/preemption-shutdown.sh`. On a
  real preemption (the metadata server says `preempted=TRUE`) it runs `ovo-live.sh off`, which points
  the number at the fallback TwiML within the 30 s notice. It needs no Compose service: it runs
  with the host's `node`, or else in a `node:24.8.0-bookworm-slim` container, which
  `install-host-units.sh` pulls ahead of time when the host has no `node`. An ordinary shutdown
  leaves the number alone and drains instead.
- **Carrier fallback:** `ovo-live.sh on` sets the number's Voice **fallback** URL to the TwiML Bin
  (`OVO_OPS_FALLBACK_URL`). Twilio requests it whenever the primary URL errors or times out, so a
  dead VM produces a short message ("unable to take your call, please call again"), not silence.
  Paste `infra/twilio/fallback-twiml.xml` into the TwiML Bin and adjust the wording.
- **Uptime alert:** a Cloud Monitoring HTTPS uptime check on `https://<host>/ovo-gateway-health`
  every minute from every region, with an alert policy that fires after a failing minute
  (`infra/gcp/uptime-alert-policy.json`) to the notification channel.
- **Second opinion:** `scripts/ops/uptime-probe.sh` from another machine (the Mac mini:
  `*/1 * * * * OVO_OPS_ALERT_WEBHOOK_URL=… /path/ovo/scripts/ops/uptime-probe.sh --url https://<host>/ovo-gateway-health >> /var/log/ovo/uptime-probe.log 2>&1`,
  or `install-host-units.sh --probe-host <host> --apply` on a Linux box). It posts one DOWN message
  after two failed minutes and one RECOVERED message, to a Slack-compatible webhook.
- **Daily disk snapshots** at 02:30 IST, kept 14 days, plus the nightly offsite backup
  ([offsite-backups.md](offsite-backups.md)) and its heartbeat.
- **Logs** are bounded: containers 5 × 20 MiB each, the journal 1 GiB, `/var/log/ovo/*.log` 14 days.

## When the uptime alert fires

1. Callers already hear the fallback message (the Voice fallback URL). Nothing to do for them.
2. `gcloud compute instances describe ovo-dev --zone <z> --format='value(status,scheduling.provisioningModel)'`.
   `TERMINATED` on a Spot VM means preemption: `gcloud compute instances start ovo-dev --zone <z>`.
   (A start can fail while Spot capacity is short; try another zone's snapshot-based VM or wait.)
3. On the VM: `systemctl status ovo-compose`, `docker compose --env-file infra/compose/.env -f infra/compose/compose.yaml ps`,
   then `scripts/ops/verify-live.sh`.
4. After a preemption the number points at the fallback (the shutdown script switched it). When
   `verify-live.sh` passes except `carrier-number`, run `scripts/deploy/ovo-live.sh on`.
5. If the stack is healthy but the public check fails, look at Caddy (`journalctl -u caddy`) and the
   certificate; `verify-live.sh` names the failing hop (`public-tls`, `wss-upgrade`).
6. Reconcile calls that were live at the failure: their workers died with them. See
   [worker-loss-reconciliation.md](worker-loss-reconciliation.md).

## Limits

- No second host: an outage lasts until the VM is back (minutes for a restart, longer for a Spot
  stock-out).
- The preemption script runs only if GCE delivers the shutdown signal; on an abrupt host failure the
  Voice fallback URL is what callers get.
- None of the GCP commands above were run while writing this; they are printed for review first.
