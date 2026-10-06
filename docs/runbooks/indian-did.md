# Indian DID: buy and wire an Indian number on Plivo

**Owner:** founder (the purchase, KYC and the first call), platform operator (OVO configuration). **State:** prepared 2026-10-06, **not executed**. Nothing here has dialled or received a real call. Every step that touches Plivo, the VM or a phone is the founder's to run. The engineering proof is on loopback: `pnpm test:live-path` runs `tests/e2e/plivo-indian-did.test.ts`, which follows steps 5–9 below against the in-process stack with fake providers.

**Why Plivo, not Exotel.** OVO's Exotel plugin is a held skeleton. The founder's 2026-10-02 hold needs a confirmed authenticated 16 kHz wire format and an owner-fenced end handoff before it is built. Exotel's docs still do not say whether `sample-rate=16000` counts toward the stream URL's three custom parameters. They also do not say whether a dynamic URL may carry Basic-auth userinfo. The Plivo plugin is complete and certified on fixtures, so Indian numbers go through Plivo. Section 7 lists what Exotel must confirm.

**Why an Indian DID at all.** The caller sees an Indian number. The PSTN leg stays domestic instead of reaching a US Twilio number. Plivo anchors the call in Mumbai, next to the asia-south1 VM. See [residency.md](../residency.md) for the full call path.

## 1. Prerequisites

| Requirement                                       | Detail                                                                                                                                                                                                                                         |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Indian registered entity                          | Only an Indian business can rent Indian numbers and use domestic routes.                                                                                                                                                                       |
| KYC document                                      | One sealed and signed copy of: a GST certificate (active GSTIN), a Certificate of Incorporation (CIN), or an Udyam registration certificate. Review takes about 15 minutes, and up to one business day for 080/022 numbers.                    |
| A Plivo organization in the **India data region** | Indian numbers are only offered to India data-region organizations, and the region **cannot be changed later**. An existing US-region account needs a new organization (organization switcher → Create New Organization → Data Region: India). |
| The OVO stack in India                            | Gateway and workers on the asia-south1 VM, with `OVO_MEDIA_PUBLIC_BASE_URL` set to its public HTTPS origin. TRAI anchoring forbids terminating the call's media outside India; Plivo fails such a call with `violates_media_anchoring` (4590). |
| Number series                                     | Collections are service and transactional calls. Use an **080/022 landline** number, or a **160-series** number if the lender is a regulated BFSI entity. Never use a 140-series (promotional) number.                                         |

Sources: Plivo ["Rent India numbers"](https://www.plivo.com/docs/numbers/rent-india-numbers), ["India calling"](https://www.plivo.com/docs/voice/concepts/india-calling) and ["Calling in India"](https://www.plivo.com/docs/voice-agents/sip-trunking/deploy/calling-in-india), all retrieved 2026-10-06.

## 2. Buy the number (Plivo console, founder)

1. In the India organization, open **Compliance → Create Application**. Choose India and the business type (Direct Brand), then upload the KYC document.
2. Once the application is approved, open **Phone Numbers → Buy Numbers**, choose India, the series (080 Bengaluru or 022 Mumbai), and **Voice**. The compliance application links automatically.
3. Note the number in E.164 (`+918069450000` is used as the example below), the organization's **Auth ID** (`MA…`) and its **Auth Token**. A subaccount's `SA…` Auth ID and token work too.

## 3. Credential and binding (OVO console)

1. **Credentials → New credential:** provider `plivo`, type `api-key`, environment `live`, value = the Plivo **Auth Token**. The token never goes into binding config.
2. **Provider bindings → New binding:** plugin **Plivo Voice** (`@winsendotai/ovo-carrier-plivo`), provider `plivo`, that credential, and:
   - **Auth ID:** the `MA…`/`SA…` id (letters and digits only; the form refuses anything else).
   - **Stream audio format:** keep `audio/x-mulaw;rate=8000`. Scribe, AssemblyAI and ElevenLabs `ulaw_8000` take it with no transcode. The dial-time per-call clip render (TTS-10) assumes mu-law, so a PCM binding loses the early opening.
   - **Outbound caller IDs:** `["+918069450000"]` if this binding will dial. Plivo requires the rented Indian number as caller ID for calls to Indian numbers.
   - Leave **Calls per second** at the default unless Plivo raised the account limit.

Equivalent API calls (operator session, over TLS):

```bash
curl -sS -X POST "$OVO_API/v1/credentials" -H 'content-type: application/json' -b "$COOKIE" \
  -d '{"label":"Plivo India","provider":"plivo","type":"api-key","environment":"live","value":"<AUTH TOKEN>"}'
curl -sS -X POST "$OVO_API/v1/provider-bindings" -H 'content-type: application/json' -b "$COOKIE" \
  -d '{"label":"Plivo India DID","provider":"plivo","pluginId":"@winsendotai/ovo-carrier-plivo",
       "environment":"live","credentialId":"<credential id>",
       "config":{"authId":"<MA… auth id>","contentType":"audio/x-mulaw;rate=8000","fromNumbers":["+918069450000"]}}'
```

## 4. Price card

The Plivo plugin meters `plivo.carrier.audio_seconds`. Create the card from the India organization's voice rate card (inbound per-minute rate for the series, converted to the card's unit), then add it to the agent's `costPolicy.priceCards`:

```bash
curl -sS -X POST "$OVO_API/v1/cost/price-cards" -H 'content-type: application/json' -b "$COOKIE" \
  -d '{"id":"plivo-in-inbound","version":"2026-10","provider":"plivo","unit":"audio_seconds",
       "currency":"INR","minorUnitsPerBlock":"<paise per block>","blockQuantity":"60",
       "effectiveAt":"2026-10-01T00:00:00.000Z","provenance":"Plivo India rate card <date>"}'
```

Plivo bills answered calls only, with a 60-second minimum and its own billing increment. OVO meters actual audio seconds, so a short call's cost line can be lower than Plivo's invoice. Reconcile against the CDR's `billed_duration`.

## 5. Release the agent on Plivo

In Studio, set the agent's **carrier** slot to Plivo Voice with the binding from step 3. Keep the same STT, TTS, LLM and decision bindings, then publish. `GET /v1/agents/<id>/readiness` must report `liveReady: true` and no `liveBlockers`. A missing `plivo.carrier.audio_seconds` card shows up there.

## 6. Wire the Plivo application to OVO

1. `GET /v1/provider-bindings/<binding id>/carrier-urls` returns two signed, binding-scoped URLs:
   - **Plivo Answer URL** (`…/carriers/plivo/<binding>/inbound?…`)
   - **Plivo Hangup URL** (`…/carriers/plivo/<binding>/status?…`)
2. In the Plivo console, **Voice → Applications → Add New Application**. Paste the Answer URL with method **POST** and the Hangup URL with method **POST**. Paste both **verbatim**: the V3 signature covers the exact URL and query, and rebuilding either fails with 403.
3. **Phone Numbers → the DID → Application Type: XML Application →** the application from step 2.

OVO answers with a bidirectional `<Stream>` to `wss://<public origin>/carriers/plivo/<binding>/…`. It carries the route identity in `extraHeaders`, a signed stream-status callback and `keepCallAlive`. Plivo signs the WebSocket upgrade with V3, and the gateway checks it.

## 7. Inbound route

```bash
curl -sS -X PUT "$OVO_API/v1/operations/inbound/routes/%2B918069450000" -H 'content-type: application/json' -b "$COOKIE" \
  -d '{"expectedVersion":null,"releaseId":"<release id>","variables":{},"enabled":true,
       "carrierPluginId":"@winsendotai/ovo-carrier-plivo","carrierBindingId":"<binding id>"}'
```

Routes are matched on the exact E.164 number. Plivo callbacks may send the number without the `+` (`918069450000`). The Plivo plugin adds the `+` before admission. That fix is in place, has a regression test, and is a carrier conformance check.

## 8. Checks before the first call (no phone needed)

- `pnpm test:live-path` with `OVO_TEST_POSTGRES_URL` set: `plivo-indian-did.test.ts` passes.
- `GET /v1/operations/inbound/capacity` shows `readyProtected ≥ 1` once inbound admission is on.
- The binding, route and release IDs match. Only the DID points at the OVO application.

## 9. First call (founder)

Follow the go-live gates and the evidence and abort sections of [first-real-call.md](first-real-call.md) for the window, flags and evidence. Substitute the Plivo DID for the Twilio number and **Plivo CallUUID** for CallSid. In addition, check these:

1. The answer webhook returns 200 XML with `<Stream … contentType="audio/x-mulaw;rate=8000">`. Gateway logs show the upgrade accepted (no 403) and a `plivo_stream_status` `started` line.
2. The caller hears the greeting, and barge-in clears audio (`clearAudio`).
3. Hang up from the phone. The route settles `completed`, the call record is `completed`, and the end reason is not `error:*`.
4. The cost lines carry `plivo.carrier.audio_seconds`. Compare them with the Plivo CDR (`billed_duration`, `hangup_cause_name`).
5. Fill in section 5 of [residency.md](../residency.md) with the handshake and first-audio numbers, side by side with the Twilio baseline.

**Rollback:** in the Plivo console, set the number's application back to its previous value (or none). Disable the OVO route with its current `expectedVersion`. Do not delete the binding or the rows; they are evidence.

## 10. Outbound from the DID (after the inbound call works)

Outbound uses the same binding and `fromNumbers`. Plivo India allows Indian number → Indian destination only. Plivo machine detection (`amd`) is supported by the plugin. Before any campaign, confirm consent, the calling-hours window, the do-not-call list and the recording disclosure (outbound lane, Wave 5). Never cold call.

## 11. Still unconfirmed (check on the first call)

- Plivo callback number format for Indian DIDs: with or without `+`. Both are handled.
- The REST host for an India data-region organization. The plugin assumes `api.plivo.com`, the only host in its egress list. If dial, hangup or reconcile return 401/404 from the India organization, ask Plivo for the regional host and add it to the plugin.
- The WSS upgrade signature scheme, the inbound media frame size, and checkpoint behaviour after `clearAudio`. These were carried over from the Plivo plugin's own checker notes.

## 12. Exotel: what would unhold it

Ask Exotel support for written answers, then reopen unit C3. The WIP is on branch `w2/C3`, commit `eaeb03f`.

1. Does `?sample-rate=16000` count toward the Voicebot stream URL's limit of 3 custom parameters (256 characters)? OVO needs `sid`, `rt` and a per-call secret `t`.
2. Can the HTTPS endpoint that returns the WSS URL dynamically return one with `key:token@` userinfo (Basic auth), or is IP allow-listing the only alternative?
3. When the Voicebot applet's stream closes, does the flow continue to the next applet (Hangup) every time? This is what `streamEndTerminatesCall` attests. Is there a REST hangup for a call in a Voicebot applet?
4. Does `mark` mean the audio has played (carrier-played) or only been received?
