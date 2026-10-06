# Region and data residency (OPS-16)

**Owner:** founder (decisions), platform operator (configuration). **Status:** guidance. Nothing in this document has been measured on a live call unless it says so. Lines marked **[UNCONFIRMED]** come from vendor documentation or third-party reporting and have not been confirmed with the vendor in writing. Get a DPA or a written answer before you rely on them.

This document answers three questions for the collections deployment:

1. Where does a call's audio and text go, hop by hop?
2. Which placement keeps that path short and inside India?
3. What has to be on record for DPDP and TRAI purposes?

## 1. The call path today

The first live calls (Wave 1–4) ran on the Twilio US number:

```
Indian mobile ──PSTN──▶ Twilio (US number, US media region)
                         │  Media Streams WebSocket
                         ▼
              ovo-dev VM, GCP asia-south1 (Mumbai): gateway → worker
                         │
       ┌─────────────────┼──────────────────────────────┐
       ▼                 ▼                              ▼
  STT: ElevenLabs   LLM: OpenAI gpt-6-luna      TTS: ElevenLabs flash_v2_5
  Scribe (US host)  (US processing)             (US host)
                    Decision: Jev (api.typesafe.ai)
```

Each caller turn can cross India ↔ US several times. The call leg itself crosses once in each direction, because the number is American. Every STT, LLM and TTS round trip then leaves India from the Mumbai VM. Wave 2 measured AssemblyAI handshakes of 2–5 s from asia-south1. Wave 1 measured LLM turns of 2.5–4.7 s end of speech to first audio. Some of that time is distance. How much is unmeasured; see section 5.

## 2. Placement matrix

| Hop            | Today                                                             | India-resident option                                                                                                           | Effect                                                                                                                                                                | Code status                                                                                                                                                                                         |
| -------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phone number   | Twilio US number                                                  | **Plivo Indian DID** (India data-region account; 080/022 landline or 160-series BFSI)                                           | The PSTN leg stays domestic and the caller sees an Indian number. Plivo anchors the call in Mumbai.                                                                   | Done. The Plivo carrier plugin binds end to end; see [the Indian DID runbook](runbooks/indian-did.md). Exotel is held: its 16 kHz wire format and end handoff are unconfirmed.                      |
| Media gateway  | ovo-dev, asia-south1 (Mumbai)                                     | Same. asia-south2 (Delhi) for a second zone.                                                                                    | TRAI anchoring requires the platform that terminates the call's media to be in India. Plivo: "A platform deployment in another region cannot legally carry the call." | Done (deployment). `OVO_MEDIA_PUBLIC_BASE_URL` must point at the Indian VM.                                                                                                                         |
| STT            | ElevenLabs Scribe, `api.elevenlabs.io`                            | Scribe binding `region: in` (`api.in.residency.elevenlabs.io`); Sarvam Saaras (`api.sarvam.ai`)                                 | Shorter handshake. Audio stays in India.                                                                                                                              | `region: in` exists on the binding but **needs an ElevenLabs account provisioned for India residency** (enterprise). AssemblyAI offers US and EU only. Deepgram has no India option in this plugin. |
| TTS            | ElevenLabs, `api.elevenlabs.io`                                   | ElevenLabs binding `region: in-residency`; Sarvam Bulbul                                                                        | As for STT.                                                                                                                                                           | Binding field exists. Needs the same provisioning.                                                                                                                                                  |
| LLM            | OpenAI `api.openai.com` (gpt-6-luna)                              | None for processing. OpenAI India data residency stores data at rest in India but runs inference offshore **[UNCONFIRMED]**     | Text (the caller's words and the call facts after verification) is processed outside India.                                                                           | `in.api.openai.com` is not in the plugin's egress list. Add it only after the founder decides on storage-only residency.                                                                            |
| Decision (Jev) | `api.typesafe.ai`                                                 | Ask the Jev provider where it runs                                                                                              | Turn text and listen-set questions are processed there.                                                                                                               | Region unknown **[UNCONFIRMED]**.                                                                                                                                                                   |
| Recordings     | Worker filesystem on the VM (`OVO_RECORDINGS_BACKEND=filesystem`) | Same disk (Mumbai). Offsite backups to a GCS bucket in `asia-south1`, or a configurable dual-region `asia-south1`+`asia-south2` | Recordings stay in India.                                                                                                                                             | The backup tooling (deploy lane, OPS-12) must create its bucket in an Indian location. Never use a US or multi-region bucket.                                                                       |
| Database       | Postgres on the VM                                                | Same                                                                                                                            | Call records, transcripts (`OVO_TELEMETRY_TRANSCRIPT_TEXT=store`), outcomes and the ledger stay in India.                                                             | Done.                                                                                                                                                                                               |

**Recommended target:** a Plivo Indian DID, the Mumbai VM, Scribe and ElevenLabs TTS on their India residency hosts once the account is provisioned (Sarvam as the India-hosted fallback), with OpenAI and Jev as the only offshore processors. That gives the shortest media path and a single, documented offshore text flow. A us-east VM is the wrong direction: TRAI anchoring rules it out for an Indian DID, and the caller's PSTN leg would still be in India.

## 3. Processor residency record (DPDP)

Keep this table with the founder's DPDP records. Update it whenever a binding's provider or region changes. The **Data** column is what OVO sends, not everything the vendor might log.

| Processor             | Data OVO sends                                                                                                   | Where it is processed (default binding)     | India option                             | Retention control                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------ |
| Plivo (India account) | Call audio, both numbers, call events                                                                            | India (Mumbai anchor)                       | Default for Indian numbers               | Plivo console. OVO does not ask Plivo to record.                               |
| Twilio                | Call audio, both numbers, call events                                                                            | US                                          | None for a US number                     | Twilio console                                                                 |
| ElevenLabs Scribe     | Caller audio. Per-call keyterms (customer name and other variables an agent lists in `keytermVariables`, STT-11) | US (`api.elevenlabs.io`)                    | `region: in` (enterprise provisioning)   | Binding `enableLogging: false` asks for zero retention (enterprise plans only) |
| AssemblyAI            | Caller audio, per-call keyterms                                                                                  | US                                          | None (EU only)                           | Vendor account settings                                                        |
| Sarvam                | Caller audio / agent text                                                                                        | India **[UNCONFIRMED: confirm in the DPA]** | Default                                  | Vendor account settings                                                        |
| ElevenLabs TTS        | Agent text, including rendered call variables (names, amounts) for per-call clips (TTS-10)                       | US                                          | `region: in-residency`                   | Vendor account settings                                                        |
| OpenAI                | Caller words, history, agent context. Call facts only after the flow verifies identity (AGT-5)                   | US                                          | Storage-only residency **[UNCONFIRMED]** | `OVO_LLM_STORE` (default not stored)                                           |
| Jev (typesafe.ai)     | Caller reply, recent turns, the listen set's question and options                                                | **[UNCONFIRMED]**                           | **[UNCONFIRMED]**                        | Ask the provider                                                               |

Things that never leave the VM: recordings, the per-call clip audio (TTS-10 keeps it in memory only and never writes it to the durable cache), call records, the cost ledger and secrets.

## 4. TRAI and DoT rules that shape the deployment

- **Anchoring.** Both legs of an India call must originate and terminate in India. Plivo fails a violating call with hangup cause `violates_media_anchoring` (code 4590). OVO's Plivo stream terminates on the Mumbai VM, so it complies. A gateway outside India would not. (Plivo, ["Calling in India"](https://www.plivo.com/docs/voice-agents/sip-trunking/deploy/calling-in-india) and ["India calling"](https://www.plivo.com/docs/voice/concepts/india-calling), retrieved 2026-10-06.)
- **Number series.** Collections calls are service and transactional calls. Use an 080/022 landline-series number, or a 160-series number if the lender is a regulated BFSI entity. Never use a 140-series (promotional) number. Promotional content is prohibited on landline series.
- **Consent and cold calling.** Commercial calls need prior consent. The do-not-call list, calling-hours window and recording disclosure belong to the outbound lane. Confirm they are switched on before outbound dialling from an Indian DID.
- **Eligibility.** Only an Indian registered entity can rent Indian numbers. The Plivo organization must be created in the India data region, and that region cannot be changed later.

## 5. What to measure on the first Indian-DID call

Record these against the Twilio baseline (Wave 1: LLM turns 2.5–4.7 s, Jev-only turns 0.9–1.9 s from end of speech to first audio):

1. **`stt.ready`:** handshake time per provider host (`GET /v1/calls/:id/turns` and the `stt.preconnect` audit). Repeat with the Scribe `region: in` binding when it is provisioned.
2. **Media round trip:** carrier media in to the first agent audio out, on the same agent, with the Plivo DID and with the Twilio number.
3. **TTS first byte:** per host, global against India residency.
4. Whether any call ends with `violates_media_anchoring`. It should never happen on the Mumbai VM.

Put the numbers in this document, replacing "unmeasured" in section 1, and in the founder's DPDP record.
