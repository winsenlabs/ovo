# sip-gateway

The OVO-owned SIP trunk gateway (Wave 11). It terminates SIP and RTP from a trunk and presents each
call to the unchanged media gateway as an ordinary carrier stream: signed admission over HTTP, a
signed carrier WebSocket with μ-law 8 kHz frames, status and resume callbacks. Workers dial out
through its control API. It ships dark: nothing starts unless `OVO_SIP_ENABLED=true` adds the
compose profile `sip`, and SIP/RTP bind `127.0.0.1` unless `OVO_SIP_PUBLIC_ENABLED=true`.

Design: `docs/architecture/sip-gateway.md` (W11 design sections 3 to 5). Onboarding a trunk:
`docs/runbooks/sip-trunk-onboarding.md`. Vendor presets live in the runbooks only; this service
never names a trunk vendor.

## What it does

| Path           | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inbound INVITE | Source allow-list before parsing (silent drop), per-source and per-trunk rate limits, `Require` → 420, session interval → 422, Request-URI number → 404, capacity → 503, SDP → 488; then 100/180, `POST /carriers/<carrierId>/<bindingId>/inbound`, `wait` retries (180 held, capped by `OVO_SIP_INBOUND_WAIT_MAX_MS`), media socket, 200 with SDP until the ACK. CANCEL → 487.                             |
| Outbound       | `POST /v1/calls` (control API) → INVITE to the trunk `outbound.proxy`, digest on 401/407 (MD5 or SHA-256, `qop=auth`, one round per nonce), CANCEL at the ring timeout or on host hangup, BYE at `maxDurationSec`. SIP finals map to `CallState` (486/600 busy; 408/480 and 487 after our ring-timeout CANCEL no_answer; 487 after a host hangup canceled; 5xx failed and retryable; other 4xx/6xx failed). |
| Media          | One `m=audio`, PCMU or PCMA (trunk order) plus telephone-event; A-law is transcoded so the worker only sees μ-law. 20 ms paced output, jitter buffer with silence concealment, RFC 4733 and INFO `dtmf-relay` digits, RTCP every 5 s, latching only to the signalled address or the trunk `mediaCidrs`, 30 s without RTP (not on hold) ends the call.                                                       |
| Playout        | `media` is reframed to 160 bytes; `mark` is echoed when the audio before it has been sent; `clear` drops audio and flushes pending marks, then `cleared`; `terminate` drains (at most 5 s) then BYE. More than 30 s queued ends the call.                                                                                                                                                                   |
| Resume         | If the media socket drops without `terminate`, RTP keeps flowing and the gateway posts `resume`, reconnecting with the new grant inside the worker's 30 s window; `seq` keeps counting.                                                                                                                                                                                                                     |
| Session timers | RFC 4028: `Supported: timer`, Min-SE 90, refresh at SE/2 when we refresh, BYE at SE − min(32, SE/3) when the other side does not.                                                                                                                                                                                                                                                                           |
| Drain          | SIGTERM: new INVITEs and OPTIONS get `503 Retry-After: 30`, live calls get `OVO_SIP_DRAIN_TIMEOUT_MS` (default 240 s), then BYE with `Reason: Q.850;cause=16`. A restart drops calls: deploys recreate it only when its image changed; a configuration, trunk-file or secret change needs `deploy-compose.sh --recreate-sip-gateway`.                                                                       |

Not in v1: REFER and phone handoff (`/v1/calls/handoff` answers `handoff_unsupported`), PRACK/100rel
(we never send it and answer `Require: 100rel` with 420), SRTP/TLS, ICE, IPv6, offerless INVITEs,
early media, AMD, sending large requests over TCP automatically (the trunk's `transport` decides),
and retrying an outbound 422 with a larger Session-Expires.

## Configuration

Every variable is in `docs/env-reference.md`. Boot fails closed (zod) when any is invalid.

| Variable                                                                          | Default                                                    | Notes                                                                                                                                               |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OVO_SIP_PUBLIC_ENABLED`                                                          | `false`                                                    | `false` binds SIP and RTP to `127.0.0.1` whatever `OVO_SIP_BIND_IP` says.                                                                           |
| `OVO_SIP_BIND_IP` / `OVO_SIP_PUBLIC_IP`                                           | `0.0.0.0` / empty                                          | Used only when public; the public IP is required then and is what Via, Contact and SDP advertise.                                                   |
| `OVO_SIP_PORT`, `OVO_SIP_TRANSPORTS`                                              | `5060`, `udp,tcp`                                          |                                                                                                                                                     |
| `OVO_SIP_RTP_PORT_MIN` / `_MAX`                                                   | `40000` / `40199`                                          | Even RTP port, RTCP on the next odd port; released pairs rest 10 s.                                                                                 |
| `OVO_SIP_TRUNKS_FILE`                                                             | `/etc/ovo/sip-trunks.json`                                 | See below.                                                                                                                                          |
| `OVO_SIP_MAX_CALLS`                                                               | `4`                                                        | Concurrent dialogs, inbound and outbound together.                                                                                                  |
| `OVO_SIP_COUNTRY_ALLOWLIST`                                                       | `+91`                                                      | E.164 prefixes an outbound `to` must start with.                                                                                                    |
| `OVO_PERMITTED_FROM_NUMBERS`                                                      | empty                                                      | An outbound `from` must be here **and** in the trunk's `outbound.fromNumbers`; empty refuses every dial.                                            |
| `OVO_SIP_CONTROL_LISTEN`, `OVO_SIP_CONTROL_SOURCE_CIDRS`, `OVO_SIP_CONTROL_TOKEN` | `127.0.0.1:5090`, `172.29.240.0/24`, required (≥ 16 chars) | Bearer plus source check (loopback always allowed).                                                                                                 |
| `OVO_SIP_GATEWAY_SECRET`                                                          | required                                                   | base64, ≥ 32 bytes; signs every request to the media gateway. The gateway's verifier also accepts `OVO_SIP_GATEWAY_SECRET_PREVIOUS` while rotating. |
| `OVO_SIP_MEDIA_INTERNAL_URL`, `OVO_MEDIA_PUBLIC_BASE_URL`                         | `http://127.0.0.1:4001`, required                          | Requests go to the loopback origin but are signed for the public URL the gateway reconstructs.                                                      |
| `OVO_SIP_HEALTH_LISTEN`, `OVO_HEALTH_TOKEN`                                       | `127.0.0.1:5091`, empty                                    | `GET /health` → `{ready, draining}`; `?verbose=1` with the bearer token adds counters.                                                              |
| `OVO_SIP_DRAIN_TIMEOUT_MS`, `OVO_SIP_INBOUND_WAIT_MAX_MS`                         | `240000`, `45000`                                          |                                                                                                                                                     |

### Trunk file

Non-secret, validated at boot (`src/config/trunks.ts`). Example with documentation addresses:
`infra/compose/sip-trunks.example.json`; the real file is git-ignored.

```json
{
  "version": 1,
  "trunks": [
    {
      "id": "trunk-a",
      "carrierId": "sip",
      "bindingId": "<OVO provider binding id>",
      "transport": "udp",
      "signallingCidrs": ["203.0.113.0/28"],
      "mediaCidrs": ["203.0.113.0/26"],
      "codecs": ["PCMU", "PCMA"],
      "dtmf": "rfc4733",
      "numberFormat": { "country": "IN" },
      "forwardHeaders": [],
      "inviteRatePerSecond": 5,
      "maxConcurrent": 2,
      "optionsPingSeconds": 30,
      "inbound": { "enabled": true, "numbers": ["+918000000000"] },
      "outbound": {
        "enabled": false,
        "proxy": "sip:203.0.113.2:5060;transport=udp",
        "fromNumbers": [],
        "auth": "ip"
      }
    }
  ]
}
```

- `carrierId` / `bindingId` name the OVO carrier route (`/carriers/<carrierId>/<bindingId>/…`).
- `signallingCidrs` is the allow-list; anything else is dropped before parsing. A literal-IP
  `outbound.proxy` must sit inside it, or its responses would be dropped.
- `numberFormat.country` `IN` accepts `+91…`, `91…`, `0…` and 10-digit national numbers;
  `E164` accepts strict E.164 only.
- `forwardHeaders` lists `X-` headers copied (at most 16, values cut at 256 characters) into the
  admission request, surfacing as `sip.header.<Name>` on the call.
- `auth: "digest"` needs the binding secret `{"username","password"}`; the worker passes it per
  dial and the gateway never stores it.

## Control API

`Authorization: Bearer $OVO_SIP_CONTROL_TOKEN`, JSON. Shapes: `packages/sip-carrier-kit/src/wire.ts`.

| Request                    | Answer                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /v1/calls`           | `accepted` with the Call-ID at once, or `rejected` (`422` non-retryable: `unknown_trunk`, `outbound_disabled`, `binding_mismatch`, `from_not_permitted`, `destination_not_permitted`, `media_url_has_query`, `credentials_required`, `invalid_request`; `503` retryable: `draining`, `at_capacity`, `rate_limited`). A repeated `requestId` returns the same call. |
| `GET /v1/calls?requestId=` | `pending`, `live` (`queued`/`ringing`/`in_progress`), `ended` (final state) or `rejected` `unknown_request`; kept one hour.                                                                                                                                                                                                                                        |
| `POST /v1/calls/hangup`    | CANCEL before answer, BYE after: `ended` or `already_ended`.                                                                                                                                                                                                                                                                                                       |
| `POST /v1/calls/handoff`   | `rejected` `handoff_unsupported` (v1).                                                                                                                                                                                                                                                                                                                             |
| `GET /v1/health`           | `{ready, draining, calls, trunks}` with each trunk `up`/`down`/`unknown` from OPTIONS pings.                                                                                                                                                                                                                                                                       |

## Logs and health

JSON logs with `service: sip-gateway`: `sip.invite`, `sip.admission`, `sip.answered`, `sip.ended`
(cause, SIP code, Q.850 cause, duration, codec, RTP stats), `sip.outbound`, `sip.drop` (aggregated
per source every 10 s), `sip.trunk`, `sip.resume`, `sip.drain`. Numbers appear as their last four
digits; SDP, `Authorization` and digest values are never logged. The final status callback carries
`endReason`, `durationMs`, `codec` and `rtp {packetsIn, packetsOut, lossPct, jitterMs, plcFrames}`.

## Tests

- `pnpm vitest run apps/sip-gateway` — unit tests and in-process calls over real loopback sockets
  against a fake media gateway that verifies every ovo-sip/1 signature.
- `apps/sip-gateway/scripts/sipp.sh` — the 20 SIPp scenarios of W11 §17.3 on loopback (gateway on
  `127.0.0.1:15060` and `:15160`, RTP `41000-41299`), gated by `OVO_TEST_SIPP`. Needs
  `brew install sipp`; prints `skipped: sipp missing` otherwise.

## UNCONFIRMED (settle at trunk onboarding)

- The number formats real trunks put in the Request-URI, From and P-Asserted-Identity.
- Whether a trunk requires 100rel/PRACK, uses REFER, or sends large INVITEs that need TCP.
- Trunk session-timer values, OPTIONS behaviour and the source addresses of signalling and media.
- The RFC 3398 Q.850 to SIP mapping: causes are logged only, never used for decisions.
- Whether the compose bridge address (`172.29.240.1:5090`) can be bound from a host-network
  container (fallback: `0.0.0.0:5090` behind the bearer token and source CIDRs).
- Static external IP behaviour across Spot preemption, and DoT rules for SIP interconnect in India
  (founder decisions before go-live).
