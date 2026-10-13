# SIP gateway (Wave 11)

**State:** built and tested on loopback only. Nothing listens publicly, nothing dials, no trunk is
connected. Operator steps: [SIP trunk onboarding](../runbooks/sip-trunk-onboarding.md) and
[TCN over SIP](../runbooks/tcn-sip.md). Every variable: [environment reference](../env-reference.md#sip-gateway-and-sip-carriers-wave-11).

## Why it exists

Every OVO carrier before Wave 11 was "HTTP webhooks plus a WSS media stream". A SIP trunk (TCN,
an Indian trunk such as Exotel vSIP or Plivo Zentrunk, or any PBX) speaks SIP and RTP instead.
`apps/sip-gateway` terminates SIP and RTP itself and then talks to the **unchanged** media gateway
exactly as Twilio does: a signed admission request, a carrier media WebSocket, status and resume
callbacks. Workers see an ordinary `session.open` with `MULAW_8K`; `plugin-media` and
`session-host` did not change.

```
 Trunk / TCN SBC                      VM (asia-south1), compose project ovo-compact
  SIP udp/tcp :5060  ──────────►  sip-gateway  (network_mode: host; profile "sip"; 127.0.0.1 unless public)
  RTP udp 40000-40199 ◄───────►     ├ SIP core: parser, transactions, dialogs, digest, session timer
                                    ├ RTP core: port pool, jitter buffer, PLC, 20 ms pacer, RFC 4733, RTCP
                                    ├ bridge ── signed HTTP ─► http://127.0.0.1:4001/carriers/{sip|tcn}/{binding}/{inbound|status|resume}
                                    │        ── signed WS ───► ws://127.0.0.1:4001/carriers/{sip|tcn}/{binding}/media
                                    ├ control API  0.0.0.0:5090, called at http://172.29.240.1:5090 (bearer + source CIDRs)
                                    └ health       http://127.0.0.1:5091/health
                                                       │
                      media-gateway: plugin-carrier-sip / plugin-carrier-tcn (installed by the distribution)
                                     + host plugin providing Cap.sipTrunkVerifier
                                                       │ session.open{MULAW_8K} / media / mark / clear
                      worker-N:      host plugin providing Cap.sipTrunkControl
                                     TelephonyControl.dial / hangup / reconcile → control API
```

## Packages

| Package                                        | Kind                          | Role                                                                                                                                                                                                                          |
| ---------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/sip-carrier-kit`                     | kit                           | The `ovo-sip/1` wire schemas, request signer and verifier (WebCrypto), media serializer, carrier routes, control factory, capability builder and the control-API HTTP client. One source of truth for both sides of the wire. |
| `packages/plugin-carrier-sip`                  | vendor plugin, provider `sip` | Generic trunk. Outbound allowed by default (still gated by the trunk entry).                                                                                                                                                  |
| `packages/plugin-carrier-tcn`                  | vendor plugin, provider `tcn` | TCN delivery profile: outbound off by default, allow-listed metadata headers surfaced as `tcn.*` keys, no handoff.                                                                                                            |
| `apps/sip-gateway`                             | app                           | The SIP/RTP process. Imports the kit, `ovo-audio` (G.711) and node built-ins; names no vendor (provider-name gate).                                                                                                           |
| `apps/worker/src/sip-trunk-control.ts`         | host plugin                   | Provides `Cap.sipTrunkControl` (`OVO_SIP_CONTROL_URL` + bearer) when `OVO_SIP_ENABLED=true`.                                                                                                                                  |
| `apps/media-gateway/src/sip-trunk-verifier.ts` | host plugin                   | Provides `Cap.sipTrunkVerifier` from `OVO_SIP_GATEWAY_SECRET` (+ `_PREVIOUS`) when `OVO_SIP_ENABLED=true`.                                                                                                                    |

Carrier plugins never get sockets: `ctx.net` is https/wss only and blocks private ranges, so the
two carriers declare both capabilities as **optional** and resolve them per call with `ctx.maybe`.
Absent (api and dispatcher roles, or `OVO_SIP_ENABLED=false`), a dial is rejected non-retryably and
the carrier routes answer `503 {"error":"sip_trunk_unavailable"}`.

## Call paths

- **Inbound.** INVITE → source allow-list (before parsing) → number check → codec check →
  `POST inbound` (signed) → `InboundDecision`. On `connect` the sip-gateway opens the media
  WebSocket, sends `start{routeParams}`, then answers `200 OK` with SDP. RTP and WebSocket frames
  are bridged until either side sends BYE, then `stop` and status `completed`. `wait` decisions keep
  the caller ringing (180) and retry the decision's `retryUrl`, capped by
  `OVO_SIP_INBOUND_WAIT_MAX_MS`.
- **Outbound.** Worker `control.dial` → `Cap.sipTrunkControl` → `POST /v1/calls` → INVITE (digest
  answered when challenged) → `200` → ACK → WebSocket `start` with `DialRequest.media.routeParams`
  → status `in_progress`. The Call-ID is minted before the INVITE (`callIdTiming: 'at-dial'`).
- **Gateway restart.** The WebSocket drops without `terminate`; the sip-gateway keeps RTP alive,
  posts `resume`, receives a new grant and reconnects inside the worker's 30 s resume window. The
  caller hears silence, not a hangup.

## The `ovo-sip/1` contract

**Signing.** Every internal HTTP request and the WebSocket upgrade carry
`x-ovo-sip-version: 1`, `x-ovo-sip-timestamp` (epoch ms), `x-ovo-sip-nonce` (16 random bytes,
base64url) and `x-ovo-sip-signature: v1=<base64url HMAC-SHA256>`. The canonical string is
`v1`, the method, the **public** URL (`OVO_MEDIA_PUBLIC_BASE_URL` origin + exact path, no query;
`https` for HTTP, `wss` for upgrades), the timestamp, the nonce and the hex SHA-256 of the body,
joined by `\n`. The verifier accepts a 30 s clock skew, remembers nonces for 60 s (10 000 entries),
compares in constant time and accepts the previous key while rotating. Status and resume URLs keep
their url-secret query, which the plugins also verify. Bad signature `401`, bad body `400`.

**Routes** (`/carriers/{sip|tcn}/{bindingId}/{purpose}`):

| Purpose   | Body                                                                                                      | Reply                                                                                                                                                                     |
| --------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inbound` | `{v, callId, trunkId, from, to, receivedAt, headers, sip{requestUri, fromUri, pAssertedIdentity}, retry}` | The host's `InboundDecision` verbatim. `raw` carries `sip.callId`, `sip.trunkId` and `sip.header.<Name>`; TCN adds `tcn.<lower-kebab-name>` for its allow-listed headers. |
| `status`  | `{v, eventId, callId, dialRequestId?, state, occurredAt, sipCode, reason, payload}`                       | `{"result":"applied                                                                                                                                                       | duplicate | unmatched | correlation_conflict"}` |
| `resume`  | `{v, callId}`                                                                                             | A `StreamGrant` or `{"kind":"ended"}`                                                                                                                                     |
| `media`   | WebSocket upgrade, signed                                                                                 | text frames below                                                                                                                                                         |

`headers` holds only names listed in the trunk's `forwardHeaders` (at most 16, values truncated at
256 characters). The final `status` payload carries `endReason`, `durationMs`, `codec` and RTP
statistics (`packetsIn`, `packetsOut`, `lossPct`, `jitterMs`, `plcFrames`).

**Media frames.** sip-gateway → gateway: `connected`, `start{callId, streamId, format, routeParams}`,
`media{seq, tsMs, payload}`, `dtmf{digit, durationMs}`, `mark{name}`, `cleared`, `stop{reason}`.
Gateway → sip-gateway: `media{payload}`, `mark{name}`, `clear`, `terminate`. Audio is always
μ-law 8 kHz on the WebSocket (A-law trunks are transcoded in the sip-gateway). `seq` is a per-call
counter that never resets across resumes; `tsMs` follows the 20 ms output clock, so PLC-filled
gaps stay continuous. Marks are reported when the pacer reaches them (`playbackEvidence:
'carrier-played'`); `clear` flushes queued audio and reports pending marks before `cleared`.

**Control API** (sip-gateway, called only through `Cap.sipTrunkControl`): `POST /v1/calls`,
`GET /v1/calls?requestId=`, `POST /v1/calls/hangup`, `POST /v1/calls/handoff` (v1 always
`handoff_unsupported`), `GET /v1/health`. Bearer token (constant-time), source loopback or inside
`OVO_SIP_CONTROL_SOURCE_CIDRS`. A dial is checked against the trunk entry (enabled, binding and
carrier match), the number policy (`from` in the trunk's and `OVO_PERMITTED_FROM_NUMBERS`, `to`
under `OVO_SIP_COUNTRY_ALLOWLIST`), the trunk's calls-per-second bucket and `OVO_SIP_MAX_CALLS`.

## Carrier capabilities

Both carriers: `MULAW_8K`, `carrier-played` evidence, `clear` with `clearFlushesMarkers`, DTMF,
no query on the media URL, Call-ID and stream parameters at dial, CANCEL before answer, no AMD,
`maxDuration` (BYE at `maxDurationSec`), reconcile by request id, REST hangup, `continuation:
'markup-after-stream'` (the resume route), `hmac-signature` webhook auth, 1 call per second
(the per-trunk buckets enforce the real limit). `handoff` is empty in v1 for both.

## What ships dark, and how

- Compose profile `sip`: `deploy-compose.sh` adds it, and the service, only when
  `OVO_SIP_ENABLED=true`, and recreates the sip-gateway only when its image changed (a restart drops
  live SIP calls).
- `OVO_SIP_PUBLIC_ENABLED=false` binds SIP and RTP to `127.0.0.1`. No GCP firewall rule exists for
  5060 or the RTP range.
- Caddy answers 404 for `/carriers/sip/*` and `/carriers/tcn/*` on the public origin.
- The image is in the bake group `sip`, outside `default`.
- No price card for `sip.carrier.audio_seconds` or `tcn.carrier.audio_seconds`: the per-minute
  price is in the trunk contract, so the release checklist shows them `missing` until the founder
  enters it.

## Not in v1

SIP REFER and B2BUA transfer, SRTP/TLS (5061), PRACK/100rel, AMD, `callback-offer` and announced
`wait` (no TTS in the sip-gateway), TCN REST control (requeue, transfers, dispositions) and the
TCN Virtual Agent model. See the [TCN runbook](../runbooks/tcn-sip.md) for what TCN must answer
first.
