# Work unit C5: TCN carrier

Wave: 2 (founder-held)
Depends on: F1–F4, C2
Status: **Not started; vendor documentation gate is open.**

## Owned paths

- `packages/plugin-carrier-tcn/**`
- `scripts/baselines/pending/C5.json` if an approved, temporary gate entry is needed

No shared manifest, lockfile, distribution, contract or host path is owned by C5.
List and approve those touchpoints only after the vendor contract is confirmed.

## Documentation gate

Before implementation, obtain an authoritative TCN integration specification
covering all three: bidirectional media wire format (including codec, rate,
framing, and control events), authentication and signature verification for
callbacks and WebSocket upgrades, and dial/reconcile/hangup or transfer APIs.
Record the exact source, version and known ambiguities here. A TCN
[API overview](https://www.tcn.com/operator/integration-and-automation/)
confirms APIs and webhooks exist, but does not establish those wire details.
Publicly indexed [TCN API docs](https://docs.tcn.com/) have not provided a
confirmed media/signing/call-control contract for this unit. Do not infer one
from marketing pages or another carrier's protocol.

## Acceptance after the gate opens

Build one production `Cap.carrierIngress` selected through release selections
and C2's unchanged carrier-neutral gateway. Use synthetic credentials,
FixtureNet and loopback sockets for every proof. Compare authentication and
wire decisions with an official signer/validator or vendor-confirmed vectors;
cover absent and negative cases for each optional field and capability. Run the
normal full gate, including Postgres serial, before checker handoff. No real
credentials, vendor endpoint request, or actual call is authorized by this spec.

## Founder note (2026-09-30)

The founder split TCN into C5 instead of bundling it with held Exotel C3.
The documentation gate keeps C5 held independently until the required vendor
details are confirmed.
