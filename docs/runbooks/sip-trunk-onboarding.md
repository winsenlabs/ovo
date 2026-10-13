# SIP trunk onboarding

**Owner:** founder (trunk contract, static IP, firewall, legal sign-off, first call), platform
operator (OVO configuration). **State:** prepared 2026-10-13, **not executed**. Nothing here has
received or placed a real SIP call. Every command that changes the VM, GCP or a trunk is listed for
the founder to run; none was run. The engineering proof is on loopback: SIPp scenarios against a
natively run sip-gateway (`pnpm test:sip` on the mini) and `tests/e2e/sip-path.test.ts` (SIPp →
sip-gateway → a real `startGateway()` with Postgres → a fixture worker).

How it works: [SIP gateway architecture](../architecture/sip-gateway.md). TCN specifics:
[TCN over SIP](tcn-sip.md). Variables: [environment reference](../env-reference.md#sip-gateway-and-sip-carriers-wave-11).

## 1. Decisions the founder makes first

| Decision                                                                  | Why it matters                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which trunk: TCN direct, or an Indian trunk (Exotel vSIP, Plivo Zentrunk) | Indian PSTN media must stay in India. Plivo fails calls whose legs leave India (`violates_media_anchoring`, https://www.plivo.com/docs/voice/concepts/india-calling). The VM is in asia-south1.                                                                                                |
| Reserve a static external IP                                              | Trunks allow-list by IP (Exotel accepts IP whitelisting only, static public IP, no CG-NAT: https://support.exotel.com/support/solutions/articles/3000132409). GCP does one-to-one NAT for the NIC's external IP (https://docs.cloud.google.com/vpc/docs/ip-addresses).                         |
| Move SIP off the Spot VM                                                  | Spot can be preempted at any time with about 30 s notice (https://docs.cloud.google.com/compute/docs/instances/spot). Every preemption drops every live SIP call. Whether a static IP stays attached across preemption is **UNCONFIRMED**. Recommendation: an on-demand VM before SIP go-live. |
| Open the firewall, and to which CIDRs                                     | Only the trunk's signalling and media CIDRs, only after the trunk sends them.                                                                                                                                                                                                                  |
| DoT / legal sign-off for SIP interconnect in India                        | The DoT rules for SIP/PSTN interconnect could not be retrieved (official PDF returned 403): **UNCONFIRMED**. Do not go live without sign-off.                                                                                                                                                  |
| The trunk's per-minute price                                              | No price card exists for `sip.carrier.audio_seconds` / `tcn.carrier.audio_seconds`: the price is in the trunk contract. The release checklist shows them `missing` until it is entered as a price card.                                                                                        |

## 2. What to collect from the trunk

Signalling transport and port (UDP/TCP; Exotel Mumbai uses TCP 5070), signalling and RTP source
CIDRs, auth model (IP allow-list or digest; OVO answers digest as a client but never challenges an
incoming trunk), codecs and their order (PCMU/PCMA only), DTMF mode (RFC 4733 or INFO
`dtmf-relay`), session-timer values, whether they send re-INVITE for hold, the number format they
put in the Request-URI and From (`+91…`, `91…`, `0…` or 10 digits; OVO normalises `IN` numbers,
**UNCONFIRMED** per trunk), the X- headers they can send, their calls-per-second limit (Exotel's
default is 200 per minute), and a sample INVITE (pcap or ladder diagram).

## 3. Configure OVO (no traffic yet)

1. **Binding.** In the console create a provider binding for **SIP trunk (OVO sip-gateway)**
   (`@winsendotai/ovo-carrier-sip`, provider `sip`) or **TCN (SIP delivery)**
   (`@winsendotai/ovo-carrier-tcn`, provider `tcn`) with a `trunkId` such as `in-trunk`. Every
   binding needs a credential (the API requires one). A trunk that challenges our outbound
   INVITEs gets the JSON `{"username":"…","password":"…"}`; an IP-authenticated trunk gets `{}`.
   The sip-gateway never stores it: the worker passes it per dial. Open item: the sip-carrier-kit still refuses `{}` on a dial ("needs username and password"), so outbound on an IP-authenticated trunk waits for the kit to read `{}` as no credentials; inbound never reads the credential.
2. **Trunk file.** Copy `infra/compose/sip-trunks.example.json` to `infra/compose/sip-trunks.json`
   (git-ignored) and fill one entry per trunk: `id` = the binding's `trunkId`, `carrierId` (`sip` or
   `tcn`), `bindingId` = the binding's id, `transport`, `signallingCidrs`, `mediaCidrs`, `codecs`,
   `dtmf`, `numberFormat.country`, `forwardHeaders` (X- headers to pass to the agent), the inbound
   `numbers`, and `outbound` (`enabled: false` until outbound is approved). The sip-gateway refuses
   to start on any invalid entry.
3. **Environment.** `scripts/bootstrap-compose.sh` already wrote `OVO_SIP_ENABLED=false`,
   `OVO_SIP_PUBLIC_ENABLED=false`, `OVO_SIP_CONTROL_TOKEN` and `OVO_SIP_GATEWAY_SECRET`. For a
   loopback-only rehearsal set only `OVO_SIP_ENABLED=true`: the sip-gateway starts, SIP and RTP stay
   on `127.0.0.1`, Caddy still refuses `/carriers/sip|tcn/*`.
4. **Image.** On the build machine: `scripts/deploy/build-images.sh --registry … --push --sip`
   (adds `OVO_SIP_GATEWAY_IMAGE` to the pin file). Then on the VM:
   `scripts/deploy/deploy-compose.sh --images <pin file>`. With `OVO_SIP_ENABLED=true` it adds the
   `sip` compose profile and starts the sip-gateway after the gateway; later deploys recreate it only
   when its image changed, because a restart drops live SIP calls (SIGTERM: new INVITEs get
   `503 Retry-After: 30`, live calls get up to 240 s).
5. **Control-port check (once per host).** The control API listens on `0.0.0.0:5090` and the
   workers call it at the compose bridge gateway, `http://172.29.240.1:5090`. Binding the bridge
   address itself from a host-network container is **UNCONFIRMED**: Wave 11 checked it on the build
   Mac (2026-10-13), where a private address binds only when an interface holds it (`172.29.240.1`
   gave `EADDRNOTAVAIL`, the Mac's LAN address and `0.0.0.0` bound) and Docker's bridge lives in a
   VM, so the Linux behaviour stays open and compose takes the all-interfaces fallback. That is
   safe because there is no firewall rule for 5090 (GCP's implied deny-ingress applies,
   https://docs.cloud.google.com/firewall/docs/firewalls) and the control API still requires the
   bearer token and a source inside `OVO_SIP_CONTROL_SOURCE_CIDRS` (or loopback), which also turns
   away other VMs in the VPC. After step 4, on the VM,
   `docker compose … exec worker-1 node -e "fetch('http://172.29.240.1:5090/v1/health',{headers:{authorization:'Bearer '+process.env.OVO_SIP_CONTROL_TOKEN}}).then(r=>console.log(r.status))"`
   must print `200`. Optional hardening once that works: `OVO_SIP_CONTROL_LISTEN=172.29.240.1:5090`
   in `.env`, redeploy, and repeat the check (revert if the sip-gateway logs `EADDRNOTAVAIL`).
   Never add a firewall rule for 5090.
6. **Turning SIP off again.** Set `OVO_SIP_ENABLED=false` and redeploy (workers refuse sip/tcn
   dials, the gateway answers 503), then stop the service explicitly:
   `docker compose --env-file infra/compose/.env -f infra/compose/compose.yaml --profile sip stop sip-gateway`.
   A deploy with the flag off never touches it.

## 4. Network (founder; documented, not run)

Only after the trunk's CIDRs are known, with the VM tagged `ovo-sip`:

```bash
gcloud compute addresses create ovo-sip --region=asia-south1        # static external IP
# attach it to the VM's NIC (console: VM → Edit → Network interfaces → External IPv4 → ovo-sip)
gcloud compute instances add-tags <vm> --zone=<zone> --tags=ovo-sip
gcloud compute firewall-rules create ovo-sip-signalling --direction=INGRESS --action=ALLOW \
  --rules=udp:5060,tcp:5060 --source-ranges=<trunk signalling CIDRs> --target-tags=ovo-sip
gcloud compute firewall-rules create ovo-sip-rtp --direction=INGRESS --action=ALLOW \
  --rules=udp:40000-40199 --source-ranges=<trunk media CIDRs> --target-tags=ovo-sip
```

Outbound SIP to a trunk (for example TCP 5070) and the trunk's RTP range are egress and need no rule;
GCP firewall rules are stateful. Then in `.env`: `OVO_SIP_PUBLIC_IP=<static IP>` and, last,
`OVO_SIP_PUBLIC_ENABLED=true`. The sip-gateway refuses to start public without `OVO_SIP_PUBLIC_IP`.
Defence in depth stays on regardless: a pre-parse source allow-list (unknown sources are dropped
silently), per-source and per-trunk rate limits, RTP latching restricted to signalled or trunk media
addresses, and `OVO_SIP_MAX_CALLS`.

## 5. Go-live checklist

- [ ] Founder decisions in section 1 recorded (trunk, static IP, on-demand VM, firewall CIDRs, legal sign-off).
- [ ] Trunk interop sheet and a sample INVITE received; number formats checked against section 2.
- [ ] Binding, credential (if digest) and `sip-trunks.json` entry created; the sip-gateway starts with them.
- [ ] Control-port check of section 3 step 5 passed (workers get `200` from `/v1/health`).
- [ ] `pnpm test:sip` green on the mini for the release revision.
- [ ] Price card for the trunk's carrier meter entered; the release checklist no longer shows it `missing`.
- [ ] Static IP attached, firewall rules created with the trunk's CIDRs only, `OVO_SIP_PUBLIC_IP` set.
- [ ] `OVO_SIP_PUBLIC_ENABLED=true` deployed; trunk OPTIONS pings answered (`/health?verbose=1` shows the trunk `up`).
- [ ] One inbound test call from an owned phone; the call appears with `endReason` and RTP statistics in its final status event.
- [ ] Outbound stays `enabled: false` in the trunk file until separately approved; then one owned-number test.

## 6. Rolling back

Set `OVO_SIP_PUBLIC_ENABLED=false` (loopback again) or `OVO_SIP_ENABLED=false` and redeploy; delete
the two firewall rules. The other carriers are unaffected: the sip-gateway is a separate process
and the gateway only gains two routes that answer 503 without it.
