# TCN over SIP

**Owner:** founder (the TCN conversation and contract), platform operator (OVO configuration).
**State:** plugin built 2026-10-13 on fixtures only. **Every SIP-level TCN fact is UNCONFIRMED**: TCN
publishes no document for "TCN delivers a call by SIP to a customer server" (research of
https://docs.tcn.com/ and https://github.com/tcncloud/api, retrieved 2026-10-13). Nothing has
received a call from TCN. Use this page to ask TCN the right questions and to know what OVO v1 does.

General trunk steps (binding, trunk file, network, go-live): [SIP trunk onboarding](sip-trunk-onboarding.md).

## 1. What OVO v1 does with TCN

The `@winsendotai/ovo-carrier-tcn` plugin (provider `tcn`, console label **TCN (SIP delivery)**) is a
SIP carrier profile on OVO's own sip-gateway. It assumes the model where **TCN sends an INVITE to our
SIP endpoint** (option A of the research).

| Area     | v1 behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inbound  | TCN's INVITE is admitted like any trunk call: allow-listed source, number in the trunk's `inbound.numbers`, PCMU/PCMA, then the agent bound to the number answers.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Metadata | The X- headers named in **both** the trunk's `forwardHeaders` and the binding's `metadataHeaders` (at most 16) reach the gateway's inbound admission as `tcn.<lower-kebab-name>` raw keys (for example `X-TCN-Call-Sid` → `tcn.x-tcn-call-sid`), next to `sip.header.<Name>` (proved on loopback by `tests/e2e/tcn-sip-path.test.ts`). v1 does not yet copy admission raw keys into the session or agent variables: the gateway's admission passes only Call-ID, from and to to operations. Header names TCN actually sends are **UNCONFIRMED** (question 12). Any other header is dropped. |
| Hangup   | BYE either way; a worker hangup goes through the control API.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Outbound | **Off.** A dial is refused with `outbound_disabled` (not retried) unless the binding sets `outboundEnabled: true` **and** the trunk entry has `outbound.enabled: true`. Whether TCN accepts calls _from_ us is UNCONFIRMED.                                                                                                                                                                                                                                                                                                                                                                 |
| Handoff  | **None** (`handoff: []`). Transfer back to a human needs either SIP REFER (UNCONFIRMED) or TCN's REST API (`CallerRequeue`, `TransferColdToOutbound`), which needs call correlation and a server-to-server grant TCN has not documented.                                                                                                                                                                                                                                                                                                                                                    |
| AMD      | None; TCN owns its dialler and AMD.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Region   | Binding field `region` (`us`, `ca`, `uk`, `sg`, `au`, `useast`, `eur`; default `sg`, TCN's India region, https://docs.tcn.com/virtual-agent-870220m0.md). Informational in v1.                                                                                                                                                                                                                                                                                                                                                                                                              |
| Price    | Meter `tcn.carrier.audio_seconds`, no catalog card: the per-minute price is in the TCN contract.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

Deferred to Wave 12, after TCN answers: the TCN REST client (`CallerRequeue`, `TransferColdToOutbound`,
`AgentDisconnect`, `SaveAgentCallResponses`, `getcalldata`; https://docs.tcn.com/callerrequeue-16537786e0.md,
https://docs.tcn.com/saveagentcallresponses-16537901e0.md, https://docs.tcn.com/getcalldata-16537920e0.md),
TCN outbound dialling, and TCN's documented **Virtual Agent** model. In that model the bot logs in as a
TCN agent and _dials TCN_ at `<dialUrl>@sg-webphone.tcnp3.com`, and TCN's ACD delivers callers into
that long-lived leg. It does not fit OVO's per-call `dial()`, so it is a separate design.

## 2. Binding fields

| Field                | Required | Notes                                                                                                                                                 |
| -------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trunkId`            | yes      | Lower-case letters, digits and `-`, at most 40; must equal the `id` of the entry in `sip-trunks.json`.                                                |
| `region`             | no       | Default `sg`.                                                                                                                                         |
| `metadataHeaders`    | no       | X- header names to surface as `tcn.*` keys, at most 16. Fill in after TCN answers question 12; the trunk entry's `forwardHeaders` must list them too. |
| `fromNumbers`, `cps` | no       | Only matter once outbound is approved.                                                                                                                |
| `outboundEnabled`    | no       | Default `false`.                                                                                                                                      |
| credential           | yes      | The API requires one: `{}`, or JSON `{"username","password"}` if TCN's side challenges our outbound INVITEs.                                          |

## 3. Questions for TCN (send before any engineering)

**Model and scope**

1. Which mechanism is "TCN delivers calls by SIP to our server"? (a) an agent or IVR transfer to a
   phone-book SIP URI entry; (b) an inbound DID / `routing_xml` routed to an external SIP URI; (c) a
   SIP trunk or "external queue" product; (d) the documented Virtual Agent model, where we dial
   `<dialUrl>@sg-webphone.tcnp3.com`. Please send the admin document for it.
2. Can a predictive/progressive campaign or IVR node deliver to the SIP destination with no human
   agent, or must an agent or ACD seat bridge it?
3. After handoff, does TCN stay in the media path (recording and reporting continue) or release
   the call?

**Signalling and network**

4. Transport (UDP, TCP or TLS) and the destination port you dial. Do you support `sips:` / TLS 1.2+?
5. The full list of TCN signalling and RTP source IP ranges for the India (sg) region and any
   failover region, and how changes are announced.
6. Auth to our endpoint: IP allow-list only, or will you answer a digest 401/407? Can you send a
   static credential?
7. SRTP (SDES or DTLS)? Your RTP port range? Symmetric RTP?
8. Codecs offered and their order (G.711 μ-law, A-law, G.729, Opus)? ptime? Is a single-codec
   answer (PCMU) accepted?
9. DTMF: RFC 4733 telephone-event (payload type), SIP INFO or in-band?
10. Session timers (RFC 4028) values; who refreshes, with UPDATE or re-INVITE; do you send OPTIONS
    keep-alives?
11. Hold: re-INVITE with `sendonly`/`inactive`, or music on hold from your side?

**Metadata**

12. Which X- headers can you send on the INVITE (call SID, campaign or hunt group, account number,
    journey or data-dip fields, recording id)? Per phone-book entry or hunt group? Size limits?
    User-to-User (UUI)?
13. Are `From` / `P-Asserted-Identity` the real caller ANI, and `To` / Request-URI our configured
    URI? Diversion or History-Info?

**Transfer back and call control**

14. To hand a call back to a human queue: SIP REFER (blind or attended, `Refer-To` format,
    `Replaces`), a 302, or only the REST API (`CallerRequeue` / `TransferColdToOutbound`)? With
    REST, which identifiers do we need, and how do they correlate with the SIP Call-ID?
15. Do you send BYE promptly on caller hangup? Which SIP responses do you treat as busy or failed,
    and do you retry or fail over?
16. Outbound: can we start a compliance-scrubbed dial through the API (`processmanualdialcall` →
    `manualdialstart`, or Exile `Dial`) and have the answered leg delivered to our SIP URI with no
    agent?

**APIs, events, accounts**

17. Is there a client-credentials or service-account OAuth grant for server-to-server use, or only
    user auth tokens? Rate limits?
18. Is `ResultsPushFeed` live in production, or should we use org push URLs or Synapse? Is there a
    real-time per-call event (ringing, answered, ended)?
19. How do we write a disposition back for a bot-handled call (`SaveAgentCallResponses`)? Mapping
    to TCN disposition keys?
20. Virtual Agent model: concurrency per org, licensing per virtual seat, `dialUrl` expiry.
21. A test org and a SIP test number in the sg/India region? A sample INVITE pcap?

## 4. When TCN answers

- Q4–Q11 fill the trunk entry (`transport`, CIDRs, `codecs`, `dtmf`) and the firewall rules of the
  onboarding runbook. Anything outside OVO's v1 SIP profile (TLS/SRTP, G.729, PRACK) blocks go-live.
- Q12 fills `forwardHeaders` and `metadataHeaders`; the `tcn.*` keys then reach the admission. Exposing them to agent variables needs the admission-to-session plumbing that v1 lacks.
- Q14, Q17 and Q19 decide the Wave 12 TCN REST client and whether `handoff` can become `['queue']`.
- Q1 = (d) means the Virtual Agent model: a new design, not a configuration change.
