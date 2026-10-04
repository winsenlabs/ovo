# Work unit C3-carrier-exotel: Exotel carrier plugin (Voicebot applet stream, PCM16 chunking rules, outbound and inbound media-url via streamForDial and admitInbound, close-stream termination with binding attestation, url-secret webhooks)

Wave: 2
Depends on: F1-contracts-runtime, F2-kits-gates, F3-host-seams, F4-apps-data-driven
Defects fixed: [21]

## Owned paths

- packages/plugin-carrier-exotel/**
- scripts/baselines/pending/C3.json

## Shared touchpoints (minimal edits allowed)

- none

## Specification

GOAL: add Exotel as a first-class carrier with no edits to shared code. Read docs/architecture/plugin-platform.md (revision 2): section 2.8 (contracts), section 4.10 (termination and correlation) and section 8.2 (Exotel, normative).

Official docs to follow and cite in the fixture headers:

- https://developer.exotel.com/docs/agentstream/stream-voicebot-applet
- https://support.exotel.com/support/solutions/articles/3000108630
- https://developer.exotel.com/docs/voice-v1/api-reference/connect-to-flow
- https://developer.exotel.com/docs/references/authentication
- https://developer.exotel.com/api/statuscallback

F3 created the skeleton packages/plugin-carrier-exotel with its catalog entry (roles api, worker, gateway, dispatcher) and dependencies. Fill it and remove the ovo.skeleton flag.

PACKAGE: one v2 plugin.

- id '@winsendotai/ovo-carrier-exotel', kind 'carrier', provider 'exotel', scope process.
- provides ['ovo.carrier.control', 'ovo.carrier.ingress'].
- bindingSchema: {accountSid, apiKey, region: 'sg' | 'in' (default 'in'), exophone, appId (the Voicebot flow app id), sampleRate: 8000 | 16000 (default 8000), allowedCidrs?: string[], cps?: number, streamEndTerminatesCall: const true (REQUIRED)}.
  - The last field is the operator's attestation that the Exotel flow is Voicebot → Hangup, so closing the stream ends the call. Its ui help says so. Compat code termination_unsupported enforces it too.
  - secretFields ['/credentialRef'] (the API token).
- capabilities:
  - media: formats [PCM16_8K, PCM16_16K], outboundChunk {minBytes: 3200, maxBytes: 102400, multipleOf: 320}, playbackEvidence 'carrier-processed', clear true, clearFlushesMarkers 'unknown', dtmf true, queryOnMediaUrl true;
  - control: callIdTiming 'at-dial', streamParams 'on-answer', streamCallIdMatchesDial 'unknown', cancelBeforeAnswer false, handoff ['end'], amd 'none', maxDuration true, reconcile 'by-call-id', hangup 'close-stream';
  - continuation 'none', webhookAuth 'url-secret', pacing {cps: 1}.
- meters [{key: 'exotel.carrier.audio_seconds', unit: 'audio_seconds', role: 'carrier'}].
- runtime.egressHosts ['api.exotel.com', 'api.in.exotel.com']; conformance ['carrier@1'].
- operatorUrls: media-url (the Voicebot applet's dynamic URL, including its binding-level t) and status, with help text.

MODULES (≤250 lines): serializer.ts, chunker.ts, signature.ts (basic auth and the CIDR check), routes.ts, control.ts, status-map.ts, plugin.ts, testing.ts, index.ts.

SERIALIZER (snake_case)

- decode:
  - connected;
  - start {stream_sid, start:{call_sid, account_sid, from, to, custom_parameters, media_format:{encoding, sample_rate:'8000' as a string, bit_rate}}} → format PCM16 at that rate, with routeParams {sid, rt} taken from custom_parameters or, failing that, from the upgrade URL query passed into createSession;
  - media {sequence_number, stream_sid, media:{chunk, timestamp, payload}} (base64 PCM16LE);
  - dtmf {dtmf:{digit, duration}};
  - mark {mark:{name}} → played;
  - stop {stop:{reason: 'stopped'|'callended'}} → stop 'stream-ended' or 'caller-hangup'.
- encode: {event:'media', stream_sid, media:{payload}}, {event:'mark', stream_sid, mark:{name}}, {event:'clear', stream_sid}.
- terminate() returns [] (nothing is documented); closing the socket ends the stream.
- Record the mark wording from the applet doc in the fixture header ('notification that a previously sent audio chunk has finished playing'). The classification stays conservative: 'carrier-processed', marked UNCONFIRMED. NEVER claim 'carrier-played'.
- chunker.ts, stateful per session:
  - emit only chunks that are multiples of 320 B, at least 3,200 B and at most 102,400 B;
  - carry the remainder;
  - before a mark and on flush(), pad the remainder with PCM silence up to a valid size;
  - clear discards the remainder.
  - The byte rules are what's enforced. The doc's '100 ms' figure is inconsistent, because 3,200 B is 200 ms at 8 kHz; record that in the fixture header.
- authenticateUpgrade: accept EITHER an Authorization: Basic header equal (constant-time) to the binding's apiKey:token, OR a valid per-call secret via ctx.verifyUrlSecret({purpose: 'media', bindingId, requestId: query.sid, token: query.t}). The media-url route issues that secret, and the dynamic URL cannot carry userinfo. If allowedCidrs is configured, the remote address (the x-forwarded-for first hop, else remoteAddress) must match either way. Otherwise → 401.

ROUTES

- media-url (GET or POST): the dynamic endpoint the Voicebot applet calls for BOTH inbound and outbound calls.
  - Verify the binding-level url-secret with host.verifyUrlSecret(req, {purpose: 'media-url'}).
  - Parse the call details: CallSid, From, To and CustomField. Which fields arrive is UNCONFIRMED; accept the documented ones and log unknown ones.
  - OUTBOUND if CustomField is present (it is our dialRequestId) or the CallSid matches a route: host.streamForDial({carrierId: 'exotel', bindingId, dialRequestId: CustomField, carrierCallId: CallSid}).
  - Otherwise INBOUND: host.admitInbound(...).
  - For a stream grant or a connect decision, respond application/json {"url": host.mediaUrl('exotel', bindingId, {query: {sid, rt, t}})}, where t = the per-call media secret for sid. Assert ≤3 query pairs and ≤256 characters.
  - For 'ended', 'unmatched' or other decisions, respond with JSON without a URL, with a documented error.
- status: form fields CallSid, Status, EventType, DateCreated, Legs[], ConversationDuration and CustomField. Verify the per-call url-secret (the r and t that the host put into callbacks.status), then status-map → host.applyCallEvent with dialRequestId = CustomField or r.

CONTROL (ctx.net.fetch, Basic apiKey:token)

- dial: POST https://{region host}/v1/Accounts/{accountSid}/Calls/connect.json with the form fields:
  - From = request.to (the customer number); CallerId = exophone;
  - Url = http://my.exotel.com/{accountSid}/exoml/start_voice/{appId};
  - TimeLimit = maxDurationSec; TimeOut = ringTimeoutSec ?? 45;
  - StatusCallback = callbacks.status; StatusCallbackEvents[0] = terminal; StatusCallbackEvents[1] = answered; CustomField = requestId.
  - Response Call.Sid → carrierCallId. Whether it equals start.call_sid is UNCONFIRMED, so the host alias rule and CustomField cover correlation.
  - Assert media.url is wss with no query.
  - A DialRequest with amd.mode other than 'off' → rejected, non-retryable.
  - Errors: 4xx → rejected; 408, 429, 5xx or timeout → unknown.
- reconcile: GET /v1/Accounts/{sid}/Calls/{callSid}.json → status map (live or ended).
- hangup → 'unsupported'. The host then terminates by closing the stream through the gateway (section 4.10). Whether a REST hangup exists is UNCONFIRMED; document it.
- handoff: 'end' only; any other target → rejected, non-retryable.

FIXTURES (tests/fixtures/*.jsonl, header {source, retrieved: '2026-09-22', verbatim, unconfirmed}):

- Copy frames field-for-field from the applet doc, and REST request and response examples from connect-to-flow.
- Mark UNCONFIRMED: mark semantics, mark echo on clear, call_sid vs Sid equality, the dynamic-URL request parameters, the inbound frame size and REST hangup.
- testing.ts exports fixtures (NetFixtureScripts for dial and reconcile with host api.in.exotel.com).

TESTS:

- tests/conformance.test.ts runs describeCarrier.
- Chunker: 1,000 B → one 960 B chunk + 40 B carried; 7×160 B → aligned output; a mark pads to ≥3,200 B; a >100 KB input splits.
- Decode of every event type; a 16 kHz start selects PCM16_16K.
- Upgrade: Basic auth accepted, a per-call t accepted, neither → 401, CIDR rejection.
- media-url: an outbound request with CustomField uses streamForDial; an inbound request uses admitInbound; the response respects 3 pairs and 256 characters; 'ended' gives no URL.
- The per-call url-secret is required on status.
- The dial form fields; an AMD request is rejected; hangup returns 'unsupported'.
- The bindingSchema rejects a missing or false streamEndTerminatesCall.
- A status mapping snapshot.

WAVE-2 RULES:

- You own only the paths listed; doc section 15.2 is frozen (distribution included: your catalog entry already exists).
- Do NOT run pnpm install.
- Contract gaps: use a local adapter and list it.
- Transitional violations go in scripts/baselines/pending/C3.json.
- Done = scoped lint, typecheck and tests green.

CONSTRAINTS:

- No vendor SDK; ctx.net only. Import only contracts, runtime, sdk, audio and plugin-kit.
- Never contact Exotel hosts in tests.
- Modules ≤300 lines. No git commits.

## Acceptance

- @winsendotai/ovo-carrier-exotel loads via the distribution catalog without the skeleton flag and passes describeCarrier, with doc-faithful fixtures carrying UNCONFIRMED annotations.
- Outbound audio chunks are always multiples of 320 B between 3,200 B and 100 KB, with remainder carry and silence padding before marks.
- The media-url route serves outbound calls through host.streamForDial and inbound calls through host.admitInbound, returning a wss URL within 3 query pairs and 256 characters. Upgrades accept Basic auth or the issued per-call t.
- Status callbacks require the per-call url-secret. The dial request matches connect-to-flow (From, CallerId, Url, TimeLimit, StatusCallbackEvents, CustomField). AMD requests are rejected.
- The capabilities declare amd 'none', playbackEvidence 'carrier-processed', hangup 'close-stream' and continuation 'none', and the bindingSchema requires streamEndTerminatesCall true.
- No shared-code files were edited. Scoped lint, typecheck and tests are green.

## Verify commands

- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && node scripts/lint.mjs --only packages/plugin-carrier-exotel`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && node scripts/typecheck-scope.mjs packages/plugin-carrier-exotel`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm exec vitest run packages/plugin-carrier-exotel packages/distribution --reporter=dot`
