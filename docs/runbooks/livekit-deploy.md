# Room server (LiveKit) for the operator desk: deploy and go-live

**Owner:** founder (where it runs, DNS and certificate, the firewall, first real call), platform
operator (OVO configuration). **State:** prepared 2026-10-15, **not executed**. No firewall rule, DNS
record or deploy was made. Every command that changes the VM or GCP is listed for the founder to run.
The engineering proof is on loopback: the media-room conformance kit against an in-memory room and
against a real `livekit-server` on the build Mac, and `tests/e2e/human-room-path.test.ts` (a call, an
operator session accepting, a headless operator publishing a tone and receiving the caller's, in both
directions, on a real room server). A real browser on a real network was **not** exercised.

How it works: [human queues](../architecture/human-queues.md). Variables:
[environment reference](../env-reference.md#human-queues-and-the-room-server-wave-17).

## 1. Decisions the founder makes first

| Decision                                   | Why it matters                                                                                                                                                                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where the room server runs                 | It needs UDP and TCP reachable by operators' browsers and a stable address. **Not the Spot VM**: a preemption drops every live human call, and a Spot IP may change. Not Fargate: `enable_livekit` is refused by Terraform. Recommendation: the on-demand VM that will also host SIP. |
| A static external IP                       | ICE candidates advertise it (`OVO_LIVEKIT_NODE_IP`); operators behind a firewall allow-list it.                                                                                                                                                                                       |
| A host name and certificate for signalling | Browsers need `wss://`. Caddy gets the certificate itself when you add the site (`bootstrap-compose.sh --livekit-host`).                                                                                                                                                              |
| Whether operators sit behind strict NATs   | Then you need TURN (and a certificate for TURN over TLS). Office networks that block UDP need TCP 443/TURN-TLS. **UNCONFIRMED** for any given network until tested from it.                                                                                                           |
| Who may be an operator                     | Console users plus a profile; there is no separate role in R3.                                                                                                                                                                                                                        |

## 2. Configure (no traffic yet)

1. `scripts/bootstrap-compose.sh` already wrote `OVO_LIVEKIT_ENABLED=false`,
   `OVO_LIVEKIT_PUBLIC_ENABLED=false` and a generated `OVO_LIVEKIT_API_KEY` / `OVO_LIVEKIT_API_SECRET`.
2. For a **loopback rehearsal** set only `OVO_LIVEKIT_ENABLED=true` (and `OVO_HUMAN_QUEUE_ENABLED=true`
   with the two routing flags). `deploy-compose.sh` renders `infra/compose/livekit.yaml` from the
   environment (owner-only, git-ignored), adds the `livekit` profile and starts the server. Signalling
   binds `127.0.0.1` and the compose bridge, the only ICE candidate advertised is loopback, and no
   firewall rule exists: the API and workers use it, a browser on another machine cannot.
3. Verify from the VM: `curl -s http://127.0.0.1:7880/` prints `OK`, and
   `GET /v1/human-queues/status` shows `room.reachable: true`.
4. The image is pinned (`livekit/livekit-server:v1.13.9`, Apache-2.0) and pulled by `compose pull`; to
   change it set `OVO_LIVEKIT_IMAGE`. It is not built by `build-images.sh`.

## 3. Go live (public) - the founder's checklist

Do these in order; stop at the first failure.

1. **Static IP and DNS.** Reserve the static address (`gcloud compute addresses create …`), attach it
   to the VM, and point `rooms.example.com` at it.
2. **Signalling site.** `scripts/bootstrap-compose.sh --public-host voice.example.com --livekit-host rooms.example.com`
   (adds the proxied site and sets `OVO_LIVEKIT_PUBLIC_URL=wss://rooms.example.com`), install the
   Caddyfile as for the public origin and reload Caddy. TCP 443 is already open for Caddy.
3. **Environment.** In `.env`:
   `OVO_LIVEKIT_PUBLIC_ENABLED=true`, `OVO_LIVEKIT_NODE_IP=<the static IP>`. The renderer refuses
   to proceed without the IP. Optionally `OVO_LIVEKIT_BIND_IP`.
4. **Firewall, only now.** Allow from the operators' networks (or anywhere, if operators roam):
   **TCP 7881** and **UDP 7882** (the room server's ICE ports; one UDP port by design). Example:
   `gcloud compute firewall-rules create ovo-livekit --allow tcp:7881,udp:7882 --target-tags ovo-vm --source-ranges <operator CIDRs>`.
   Never open 7880: signalling goes through Caddy on 443.
5. **TURN (only if operators need it).** `OVO_LIVEKIT_TURN_ENABLED=true`, `OVO_LIVEKIT_TURN_DOMAIN`,
   `OVO_LIVEKIT_TURN_UDP_PORT` (3478) and, for TURN over TLS, `OVO_LIVEKIT_TURN_TLS_PORT` (5349) with a
   certificate for the TURN domain terminated in front of the server (`external_tls`). Open
   **UDP 3478** and **TCP 5349** (and the relay range the server logs at start) the same way.
   TURN relays media through your VM: it costs bandwidth and is a public service, so allow-list sources.
6. **Apply.** `scripts/deploy/deploy-compose.sh --images <pin file> --recreate-livekit` (the config and
   keys changed, the image did not). Live human calls drop at this moment; do it outside a shift.
7. **Check from an operator's network.** Open **Operator desk**, go Available, place a test call to a
   number bound to a managed queue, accept it, speak both ways. Check the server log for the
   operator's ICE candidate type (`host`/`srflx`/`relay`).
8. **Staff and turn on.** Add operator profiles, bind the queue in the routing point, publish.

## 4. Operate

- **Deploys.** A running room server is left alone unless its image changed or you pass
  `--recreate-livekit`. A restart drops live human calls (they end via `onOperatorLeave`).
- **Rotate the key pair.** Put the current pair in `OVO_LIVEKIT_API_KEY_PREVIOUS` /
  `OVO_LIVEKIT_API_SECRET_PREVIOUS`, set the new pair as current, deploy with `--recreate-livekit`
  (the server accepts either; tokens are minted with the new one), then clear the previous pair and
  recreate again once old tokens have expired (a few minutes).
- **Capacity.** One room per active human call, three participants at most; the server is sized by
  media bandwidth (about 50 kbit/s each way per call before overhead). The compose limits are 1 CPU
  and 1 GiB; raise them in a compose override for more than a few dozen concurrent calls. Capacity
  ceilings beyond that are **UNCONFIRMED**.
- **Logs.** `docker compose … logs livekit`. Rooms are deleted when a call ends; the API's reaper
  deletes the rooms of tickets that ended without their worker.
- **Turn it off.** `OVO_LIVEKIT_ENABLED=false`, redeploy (managed queues refuse and publish warns), then
  `docker compose --env-file infra/compose/.env -f infra/compose/compose.yaml --profile livekit stop livekit`.
  Remove the firewall rule.

## 5. Rollback

Set `OVO_LIVEKIT_PUBLIC_ENABLED=false`, deploy with `--recreate-livekit`, and delete the firewall rule.
The server returns to loopback; managed queues keep working only for sessions on that host. To stop
using it entirely, turn it off as above; callers who reach a managed queue then fall to the hold's
timeout chain. Migrations 013 and outcomes v4 stay (take a backup before the first deploy).
