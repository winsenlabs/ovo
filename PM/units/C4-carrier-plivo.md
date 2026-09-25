# Work unit C4-carrier-plivo: Plivo carrier plugin (bidirectional Stream XML, playAudio/checkpoint/clearAudio, V3 signatures, answer_url via streamForDial, request_uuid correlation and cancel-before-answer, AMD)

Wave: 2
Depends on: F1-contracts-runtime, F2-kits-gates, F3-host-seams, F4-apps-data-driven
Defects fixed: [21, 26]

## Owned paths

- packages/plugin-carrier-plivo/**
- scripts/baselines/pending/C4.json

## Shared touchpoints (minimal edits allowed)

- none

## Specification

GOAL: add Plivo as a first-class carrier with no edits to shared code. Read docs/architecture/plugin-platform.md (revision 2): section 2.8, section 4.10 and section 8.3 (normative).

Official docs to follow and cite:

- https://www.plivo.com/docs/voice/xml/audio-streaming
- https://www.plivo.com/docs/voice-agents/audio-streaming/concepts/audio-streaming-guide
- https://www.plivo.com/docs/voice/concepts/signature-validation
- https://www.plivo.com/docs/voice/api/call/make-a-call
- https://www.plivo.com/docs/voice/concepts/machine-detection
- https://github.com/plivo/plivo-stream-sdk-java (message models)

F3 created the skeleton packages/plugin-carrier-plivo with its catalog entry and dependencies. Fill it and remove the ovo.skeleton flag.

PACKAGE: one v2 plugin.

- id '@winsendotai/ovo-carrier-plivo', kind 'carrier', provider 'plivo', scope process.
- provides ['ovo.carrier.control', 'ovo.carrier.ingress'].
- bindingSchema {authId, fromNumbers?: string[], contentType: 'audio/x-mulaw;rate=8000' (default) | 'audio/x-l16;rate=8000' | 'audio/x-l16;rate=16000', cps?: number}; secretFields ['/credentialRef'] (the auth token).
- capabilities:
  - media: formats [MULAW_8K, PCM16_8K, PCM16_16K], outboundChunk {minBytes: 1, maxBytes: 12000, multipleOf: 1} (so base64 stays ≤16 KB), playbackEvidence 'carrier-played', clear true, clearFlushesMarkers 'unknown', dtmf true, queryOnMediaUrl false;
  - control: callIdTiming 'after-answer', streamParams 'on-answer', streamCallIdMatchesDial true, cancelBeforeAnswer true, handoff ['phone','resume','end'], amd 'async', maxDuration true, reconcile 'by-request-id', hangup 'rest';
  - continuation 'markup-after-stream', webhookAuth 'hmac-signature', pacing {cps: 2}.
- meters [{key: 'plivo.carrier.audio_seconds', unit: 'audio_seconds', role: 'carrier'}].
- runtime.egressHosts ['api.plivo.com']; conformance ['carrier@1'].
- operatorUrls: inbound (the Plivo application's answer URL for inbound numbers) and status (hangup URL), with help text.

MODULES (≤250 lines): serializer.ts, signature.ts, markup.ts, routes.ts, control.ts, status-map.ts, extra-headers.ts, plugin.ts, testing.ts, index.ts.

SERIALIZER (camelCase)

- decode:
  - start {event:'start', sequenceNumber, start:{callId, streamId, accountId, tracks, mediaFormat:{encoding, sampleRate}}, extra_headers} → routeParams {sid, rt} decoded from the extra headers;
  - media {sequenceNumber, streamId, media:{track, timestamp, chunk, payload}};
  - dtmf {dtmf:{digit, track}};
  - playedStream {name} → played;
  - clearedAudio → cleared;
  - stop.
- encode: {event:'playAudio', media:{contentType, sampleRate, payload}}, {event:'checkpoint', streamId, name} and {event:'clearAudio', streamId}. terminate() returns [].
- extra-headers.ts: extraHeaders allow ≤512 B and [A-Za-z0-9] only. Encode sid and rt as base32 without padding, as key=value pairs joined per the XML doc. Test the size limit.

MARKUP: <Response><Stream bidirectional="true" keepCallAlive="true" contentType="…" statusCallbackUrl="…" extraHeaders="…">wss://host/carriers/plivo/<b>/media</Stream><Redirect method="POST">{resumeUrl from the grant}</Redirect></Response>.

- VERIFY every attribute name against the Stream XML reference, and record the verbatim source in the fixture header.
- Also render the other InboundDecision kinds: busy → <Hangup reason="busy"/>, wait, callback-offer, human → <Dial>, reject and hangup.

SIGNATURE V3 (signature.ts)

- Headers X-Plivo-Signature-V3, X-Plivo-Signature-V3-Nonce and X-Plivo-Signature-Ma-V3.
- base64 HMAC-SHA256(authToken, url + nonce), with the POST params sorted and concatenated as the doc specifies. The header may contain comma-separated signatures, and any match passes. Constant-time compare.
- Golden vectors are DERIVED from the doc's algorithm and examples and committed. The official SDK is not in the store; do not install it, and note in the fixture that the vectors are doc-derived.
- WebSocket upgrade: which URL Plivo signs is UNCONFIRMED. Try the verbatim wss externalUrl first, then its https form, and record the accepted variants in the fixture.

ROUTES (each verifies V3; 403 on failure):

- answer: this is the answer_url for OUTBOUND calls, and it equals callbacks.answer, which carries r = dialRequestId and t.
  - Read CallUUID and RequestUUID, then call host.streamForDial({carrierId: 'plivo', bindingId, dialRequestId: query.r, carrierCallId: CallUUID, carrierRequestId: RequestUUID}).
  - A stream grant → Stream markup; 'ended' or 'unmatched' → <Hangup/>.
- inbound (answer URL for inbound numbers): CallUUID, From and To → host.admitInbound → markup.
- status and hangup: CallUUID, RequestUUID, CallStatus, HangupCause, HangupSource, Machine and r → a NormalizedCallEvent (carrierCallId = CallUUID, carrierRequestId = RequestUUID, dialRequestId = r).
- amd (machine_detection_url): Machine true or false → answeredBy.
- resume: host.resumeStream({carrierId: 'plivo', bindingId, carrierCallId: CallUUID}) → markup, or <Hangup/>.
- stream-status: log and map. The event names are UNCONFIRMED.

CONTROL (ctx.net.fetch, Basic authId:token)

- dial: POST https://api.plivo.com/v1/Account/{authId}/Call/ with JSON:
  - from and to;
  - answer_url = callbacks.answer, answer_method 'POST';
  - hangup_url = callbacks.status;
  - ring_timeout, time_limit = maxDurationSec;
  - when amd is not 'off': machine_detection 'true' (or 'hangup' for hangup-on-machine), machine_detection_url = callbacks.amd, and machine_detection_time from amd.timeoutMs clamped to 2000–10000.
  - A 201 {request_uuid} response → accepted{carrierRequestId}, with no call id yet.
  - Assert media.url is wss with no query.
  - Errors: 4xx → rejected (retryable on 429); 5xx or timeout → unknown.
- reconcile by request id: GET /v1/Account/{authId}/Call/{request_uuid}/?status=queued (the queued-call lookup) while no call UUID is known. After that, GET the call by UUID. Tolerate 'pending', and map the call status to live or ended. The exact endpoint shapes must match the docs; mark them UNCONFIRMED in the fixture if the page cannot be retrieved. Do NOT use GET /Call/?request_uuid=…, which is probably not an API.
- hangup(q):
  - with carrierCallId → DELETE /v1/Account/{authId}/Call/{uuid}/ (204 → ended, 404 → already_ended);
  - with only carrierRequestId (before answer) → DELETE /v1/Account/{authId}/Request/{request_uuid}/ (204 → ended, 404 → already_ended).
- handoff: the transfer API (POST /v1/Account/{authId}/Call/{uuid}/ with legs and aleg_url) for phone or resume; end → hangup.

FIXTURES (tests/fixtures/*.jsonl, header {source, retrieved: '2026-09-22', verbatim, unconfirmed}):

- frames per the message models;
- the answer XML snapshot;
- V3 vectors: GET, POST, MA, multiple signatures, and stale-nonce and tampered negatives;
- dial request and response (request_uuid only);
- cancel and hangup responses.
- UNCONFIRMED: the signed URL on upgrade, the stream-status event names, checkpoint behaviour on clearAudio, the inbound frame size, and the queued-call and cancel endpoint shapes if not verified.
- testing.ts exports fixtures with host api.plivo.com.

TESTS:

- tests/conformance.test.ts runs describeCarrier.
- Serializer round-trip; playAudio chunks keep base64 ≤16 KB.
- checkpoint → playedStream → played; clearAudio → clearedAudio → cleared.
- extraHeaders encoding limits.
- V3 accept and reject vectors.
- The dial JSON has time_limit, machine_detection and answer_url = callbacks.answer; a request_uuid-only response is handled.
- The answer route calls streamForDial with r, CallUUID and RequestUUID, and returns <Hangup/> for 'ended'.
- reconcile tolerates after-answer call ids.
- hangup by call id (204/404) and cancel by request id before answer.
- A status mapping snapshot.

WAVE-2 RULES:

- You own only the paths listed; doc section 15.2 is frozen.
- Do NOT run pnpm install.
- Contract gaps: use a local adapter and list it.
- Transitional violations go in scripts/baselines/pending/C4.json.
- Done = scoped lint, typecheck and tests green.

CONSTRAINTS:

- No vendor SDK; ctx.net only. Import only contracts, runtime, sdk, audio and plugin-kit.
- Never contact Plivo in tests.
- Modules ≤300 lines. No git commits.

## Acceptance

- @winsendotai/ovo-carrier-plivo loads via the distribution catalog without the skeleton flag and passes describeCarrier, with doc-faithful fixtures and UNCONFIRMED annotations.
- playAudio, checkpoint and clearAudio are encoded per the docs. playedStream maps to played and clearedAudio to cleared. Evidence is carrier-played.
- V3 signature validation passes the golden vectors (including multiple signatures) and rejects tampered or stale ones.
- dial uses answer_url = callbacks.answer, and the answer route obtains stream parameters via host.streamForDial. A request_uuid-only response is handled, and reconcile uses the queued-call lookup and tolerates after-answer ids.
- hangup cancels a call before answer by request id and hangs up by call UUID after answer.
- The answer XML has a bidirectional, keepCallAlive stream plus a Redirect to resume. extraHeaders respect 512 B and alphanumeric only. Scoped lint, typecheck and tests are green.

## Verify commands

- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && node scripts/lint.mjs --only packages/plugin-carrier-plivo`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && node scripts/typecheck-scope.mjs packages/plugin-carrier-plivo`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm exec vitest run packages/plugin-carrier-plivo packages/distribution --reporter=dot`
