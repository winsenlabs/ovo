# Work unit C1-carrier-twilio: Twilio carrier plugin: media serializer, verbatim-wss upgrade signature (with published worked example), TwiML routes and resume, control v2 (reconcile live/ended, AMD, TimeLimit), handoff

Wave: 2
Depends on: F1-contracts-runtime, F2-kits-gates, F3-host-seams, F4-apps-data-driven
Defects fixed: [1, 26, 21]

## Owned paths

- packages/plugin-carrier-twilio/**
- packages/plugin-telephony-twilio/**
- scripts/baselines/pending/C1.json

## Shared touchpoints (minimal edits allowed)

- none

## Specification

GOAL: move every Twilio specific into one carrier plugin package that implements the carrier contracts. This fixes:

- #1: the outbound <Stream> URL was built as https://, and the upgrade signature was checked against a rebuilt https URL with ?edge=, while Twilio signs the exact wss:// URL;
- #26 for Twilio: reconcile treated busy, no-answer and completed as accepted; there was no answering-machine detection and no max duration.
  Read docs/architecture/plugin-platform.md (revision 2): section 2.8 (contracts), section 4.10 (termination, resume, correlation), section 5.1 (router) and section 8.1.

F3 created the skeleton packages/plugin-carrier-twilio with its catalog entry (roles api, worker, gateway, dispatcher) and dependencies. Fill it and remove the ovo.skeleton flag. The distribution legacy bridge with the same id '@winsendotai/ovo-carrier-twilio' is superseded automatically by the loader's same-id rule. Do NOT edit distribution; I1 deletes the bridge.

PACKAGE: one v2 plugin.

- id '@winsendotai/ovo-carrier-twilio', kind 'carrier', provider 'twilio', scope process.
- provides ['ovo.carrier.control', 'ovo.carrier.ingress'].
- bindingSchema {accountSid: string matching ^AC[0-9a-f]{32}$, fromNumbers?: string[], cps?: number}; secretFields ['/credentialRef'] (the auth token lives in the credential).
- capabilities:
  - media: formats [MULAW_8K], playbackEvidence 'carrier-played', clear true, clearFlushesMarkers true, dtmf true, queryOnMediaUrl false;
  - control: callIdTiming 'at-dial', streamParams 'at-dial', streamCallIdMatchesDial true, cancelBeforeAnswer false, handoff ['phone','queue','resume','end'], amd 'async', maxDuration true, reconcile 'by-call-id', hangup 'rest';
  - continuation 'markup-after-stream', webhookAuth 'hmac-signature', pacing {cps: 1}.
- meters [{key: 'twilio.carrier.audio_seconds', unit: 'audio_seconds', role: 'carrier'}].
- runtime.egressHosts ['api.twilio.com']; conformance ['carrier@1'].
- operatorUrls: inbound (the number's Voice URL) and status (the number's status callback), with help text.

MODULES (≤250 lines):

- serializer.ts: MediaSerializer and MediaCodecSession. Port the parse and encode logic from packages/plugin-telephony-twilio/src/media.ts and packages/plugin-media/src/gateway.ts (parseTwilioMediaMessage, twilioMedia, twilioMark, twilioClear).
  - decode:
    - connected;
    - start: streamSid, callSid, accountSid, tracks, mediaFormat, and customParameters → routeParams {sid, rt}, also accepting the v1 names sessionId and routeToken;
    - media: base64 payload, the string timestamp converted to a number, sequence;
    - dtmf (inbound_track);
    - mark → played;
    - stop.
  - encode: media {event, streamSid, media:{payload}} chunked at ≤8 KiB; mark; clear.
  - terminate() returns [].
- signature.ts: validateTwilioSignature(authToken, url, params).
  - base64 HMAC-SHA1 over url + sorted(key+value) of the POST params, compared in constant time.
  - authenticateUpgrade computes over req.externalUrl EXACTLY (the wss URL the host wrote into the TwiML; no query; a port only when the public base has one), with empty params, retrying once with a trailing '/'. The binding comes from ctx.resolveBinding(bindingId).
- markup.ts: TwiML builders.
  - connect: <Connect><Stream url="…"><Parameter name="sid" …/><Parameter name="rt" …/></Stream></Connect> followed by <Redirect method="POST">{resume URL}</Redirect>. The Stream url has NO query, each name+value is under 500 characters, and values are XML-escaped.
  - Also busy, wait, callback-offer, human (<Dial>), reject and hangup, ported from apps/media-gateway/src/inbound-webhook.ts and rendered from the contracts InboundDecision.
- routes.ts (CarrierHttpRoutes). Each one verifies X-Twilio-Signature over req.externalUrl plus the form params, and answers 403 on failure.
  - inbound: CallSid, AccountSid, From, To and Direction → host.admitInbound → markup.
  - status: CallSid, CallStatus, SequenceNumber, AnsweredBy and r (the dial request id) from the query → status-map → host.applyCallEvent.
  - amd: AnsweredBy → answeredBy (human; machine_* → machine; otherwise unknown).
  - resume: host.resumeStream({carrierId, bindingId, carrierCallId: CallSid}) → connect markup from the grant, or <Hangup/> when 'ended'.
  - Port the status parsing from packages/plugin-media/src/carrier-callback.ts.
- status-map.ts: queued → queued; initiated and ringing → ringing; in-progress → in_progress; completed, busy, no-answer (→ no_answer), failed, canceled.
- control.ts: CarrierControlFactory.create(ResolvedBinding) → TelephonyControl v2, using ctx.net.fetch (captured at apply) and Basic auth accountSid:secret.
  - dial: POST https://api.twilio.com/2010-04-01/Accounts/{sid}/Calls.json with the form fields:
    - To and From;
    - Twiml = connect markup built from DialRequest media.url, routeParams and callbacks.resume;
    - StatusCallback = callbacks.status, StatusCallbackEvent 'initiated ringing answered completed', StatusCallbackMethod POST;
    - TimeLimit = maxDurationSec; Timeout = ringTimeoutSec ?? 60;
    - when amd.mode is not 'off': MachineDetection=DetectMessageEnd, AsyncAmd=true, AsyncAmdStatusCallback = callbacks.amd.
    - Twilio inlines the TwiML, so callbacks.answer is unused.
    - Assert media.url starts with 'wss://' and has no query; otherwise return rejected with retryable false (#1).
    - The response sid becomes carrierCallId.
    - Errors: 4xx → rejected (retryable only on 429); 408, 5xx or timeout → unknown.
  - reconcile: GET Calls/{sid}.json → live{state} for queued, ringing and in-progress; ended{state, answeredBy} for completed, busy, no-answer, failed and canceled (#26).
  - hangup({carrierCallId}): POST Calls/{sid}.json with Status=completed; a 404 or code 20404 → 'already_ended'. A request-id-only query → 'unsupported'.
  - handoff: POST Calls/{sid}.json with Twiml=<Response><Dial>…</Dial></Response> for phone or queue; resume → redirect to the resume URL; end → <Say>message</Say><Hangup/>. Port the logic from packages/plugin-operations/src/twilio-handoff.ts; do NOT import it.
- plugin.ts: legacyPaths {'/twilio/media': media on binding 'env', '/twilio/status': status/env, '/twilio/inbound': inbound/env}.
- testing.ts: exports fixtures (NetFixtureScripts for the dial, reconcile, hangup and handoff REST calls, with host 'api.twilio.com').
- index.ts: exports plugins and fixtures.

FIXTURES (tests/fixtures/*.jsonl). The header cites https://www.twilio.com/docs/voice/media-streams/websocket-messages, https://www.twilio.com/docs/voice/twiml/stream, https://www.twilio.com/docs/usage/security and https://www.twilio.com/docs/voice/api/call-resource, retrieved 2026-09-22.

- Frames copied field-for-field from the docs: connected {protocol:'Call'}; start with tracks, mediaFormat and customParameters; media with timestamp as a string; dtmf with track inbound_track; mark echo; stop.
- Golden signature vectors, committed as JSON:
  - positive: the wss URL and its trailing-slash variant;
  - negative: the https URL with ?edge=…, a changed host, a changed port, reordered params and a tampered body.
- ALSO Twilio's published worked example (URL, params, auth token and expected signature) copied VERBATIM from https://www.twilio.com/docs/usage/security. If the page cannot be retrieved from this environment, say so in the fixture header and mark it UNCONFIRMED; never invent the expected value.
- Note in the header that port handling in the WSS signature is UNCONFIRMED.

TESTS:

- tests/conformance.test.ts runs describeCarrier.
- Serializer round-trip and chunking.
- Upgrade authentication over the verbatim wss URL, including the trailing-slash retry, rejection of the https/?edge variant, and the published example.
- dial rejects an https or query-bearing media URL (#1).
- The dial form includes TimeLimit, Timeout, the AMD params and StatusCallbackEvent.
- The reconcile mapping table (#26); hangup already-ended; the handoff forms.
- The inbound and status routes answer 403 on a bad signature.
- The resume route returns <Hangup/> when the host says 'ended'.

FAÇADE: packages/plugin-telephony-twilio becomes a re-export façade of the new package's legacy-compatible symbols (TwilioTelephonyControl, the parse and encode helpers, twilioTelephonyPlugin), so anything still compiling against it keeps working until I1 deletes it. Keep its existing tests passing, or move them into the new package. The legacy kind is not edge-checked.

WAVE-2 RULES:

- You own only the paths listed; doc section 15.2 is frozen.
- Do NOT run pnpm install.
- Contract gaps: use a local adapter and list it.
- Transitional duplication goes in scripts/baselines/pending/C1.json with a reason and removeBy 'I1'.
- Done = scoped lint, typecheck and tests green.

CONSTRAINTS:

- No twilio SDK; use ctx.net only. The architecture gate forbids node:https and ws in vendor plugins.
- Import only contracts, runtime, sdk, audio and plugin-kit.
- Never contact api.twilio.com in tests (FixtureNet).
- Modules ≤300 lines. No git commits.

## Acceptance

- @winsendotai/ovo-carrier-twilio provides both ovo.carrier.control and ovo.carrier.ingress, supersedes the legacy bridge in the loaded catalog, drops the skeleton flag, and passes describeCarrier.
- Upgrade authentication accepts the signature over the verbatim wss:// URL and its trailing-slash variant, and rejects the https/?edge=… variant. The published worked example is included verbatim, or marked UNCONFIRMED if it could not be retrieved.
- dial rejects a non-wss or query-bearing media URL as non-retryable. The dial form has TimeLimit, Timeout, the async AMD parameters and status callbacks.
- reconcile maps busy, no-answer and completed to ended{state}, never accepted.
- The TwiML connect markup has no query on <Stream url> and includes a <Redirect> to the resume route. The resume route uses host.resumeStream and returns <Hangup/> when it says 'ended'.
- plugin-telephony-twilio is a façade, and no Twilio SDK is imported. Scoped lint, typecheck and tests are green.

## Verify commands

- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && node scripts/lint.mjs --only packages/plugin-carrier-twilio packages/plugin-telephony-twilio`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && node scripts/typecheck-scope.mjs packages/plugin-carrier-twilio packages/plugin-telephony-twilio`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm exec vitest run packages/plugin-carrier-twilio packages/plugin-telephony-twilio packages/distribution --reporter=dot`
