# Work unit C6: Aloha carrier

Wave: 2 (founder-held)
Depends on: F1–F4, C2
Status: **Not started; vendor identity and documentation gates are open.**

## Owned paths

- `packages/plugin-carrier-aloha/**` (reserved name; confirm the vendor's
  spelling and package ID before creating code)
- `scripts/baselines/pending/C6.json` if an approved, temporary gate entry is needed

No shared manifest, lockfile, distribution, contract or host path is owned by C6.
List and approve those touchpoints only after the vendor contract is confirmed.

## Documentation gate

First confirm whether the founder's “Aloha” means [Alohaa](https://www.alohaa.ai/).
If it does, Alohaa's [Voice Streaming API](https://docs.alohaa.ai/alohaa-docs/api/voice-streaming-api)
documents a bidirectional WebSocket, 8 kHz G.711 μ-law frames, and a dial API.
It does not define a callback signature scheme or a complete authentication
contract for the inbound/upgrade path. Its published
[hangup endpoint](https://docs.alohaa.ai/alohaa-docs/api/call-hangup-api-number-masking)
explicitly applies to number-masking calls; it cannot be assumed to control
voice-stream calls. Obtain authoritative vendor confirmation of callback and
upgrade authentication plus dial/reconcile/hangup or transfer behavior before
implementing. If “Aloha” is another vendor, replace these candidate sources.

## Acceptance after the gate opens

Build one production `Cap.carrierIngress` selected through release selections
and C2's unchanged carrier-neutral gateway. Use synthetic credentials,
FixtureNet and loopback sockets for every proof. Compare authentication and
wire decisions with an official signer/validator or vendor-confirmed vectors;
cover absent and negative cases for each optional field and capability. Run the
normal full gate, including Postgres serial, before checker handoff. No real
credentials, vendor endpoint request, or actual call is authorized by this spec.

## Founder note (2026-09-30)

The founder split Aloha into C6 instead of bundling it with held Exotel C3.
The documentation gate keeps C6 held independently until vendor identity and
the missing contracts are confirmed.
