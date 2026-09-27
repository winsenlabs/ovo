# Work unit C1-carrier-twilio: Twilio carrier plugin: media serializer, verbatim-wss upgrade signature (with published worked example), TwiML routes and resume, control v2 (reconcile live/ended, AMD, TimeLimit), handoff

Wave: 2
Depends on: F1-contracts-runtime, F2-kits-gates, F3-host-seams, F4-apps-data-driven
Defects fixed: [1, 26, 21]

## Owned paths

- packages/plugin-carrier-twilio/**
- packages/plugin-telephony-twilio/**
- scripts/baselines/pending/C1.json

## Shared touchpoints (minimal edits allowed)

- `pnpm-lock.yaml`: the checker authorized a single dependency from transitional `plugin-telephony-twilio` to the new `plugin-carrier-twilio` re-export façade, with the matching lockfile update.

## Checker note (2026-09-26)

The spec requires `plugin-telephony-twilio` to re-export legacy-compatible symbols from `plugin-carrier-twilio`, but the owned-paths list omits the lockfile and wave-2 rules otherwise forbid installation. The checker approved adding only this manifest dependency and the matching `pnpm-lock.yaml` entry, then running `pnpm install` and `pnpm install --frozen-lockfile --offline`. The dependency direction is one-way: the legacy façade may import the vendor plugin, but the vendor plugin may import only contracts, runtime, SDK, kits and third-party packages. I1 owns deletion of the façade and dependency. No architecture baseline exception is permitted for an edge out of `plugin-carrier-twilio`.

The frozen `CarrierIngress` contract has no fixture frame encoder, while D1 must exercise the selected carrier's real wire protocol without importing a vendor package. C1 exposes a per-session `createFixtureFrameEncoder()` structural extension on its provided ingress. D1 owns consuming it through the selected registry binding; I1 owns deciding whether this adapter becomes a shared contract. Each encoder retains its own stream ID, so concurrent fixture calls cannot mix frames.

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

## Checker resumption note — 2026-09-27

Batch B starts with C1 on current foundation; C3 remains held. Acceptance includes the real distribution selecting `Cap.carrierIngress` through `release.selections` and routing through C2 without Twilio-specific gateway code. Prove HTTPS raw-query fidelity with the genuine Twilio SDK validator used offline in tests: the exact external URL passes and the pre-C2 query-stripped URL fails the same signature. Production code still uses only host ports; no SDK client, real credentials, vendor endpoint, non-loopback test socket, paid/live/provider flag or actual call is permitted. Frozen conformance is unchanged and its doubled-query fixture remains a HARD I1 blocker.

The legacy façade may depend on/re-export the new vendor package; the vendor package must never depend on the legacy package or another plugin. The approved legacy manifest dependency and lockfile are shared touchpoints inherited by I1 for deletion with the façade. Confirm an offline frozen-lockfile install after the manifest update. Any vendor architecture violation stops rather than being baselined.

The frozen binding contract is not widened for resume URLs. Use an owned structural adapter carrying a validated host callback; report the remaining contract gap for I1. Every introduced optional field, capability guard and conditional requires absent and negative cases as well as positive cases, with behavioral true-negative evidence through existing production entry points. Board/docs commits remain separate from code commits.

## Builder review note — 2026-09-26: REST form and callback signatures

The spec's spaced `StatusCallbackEvent` string conflicts with the
[official Call REST representation](https://www.twilio.com/docs/voice/api/call-resource):
events are repeated form parameters. Both the v2 control and legacy adapter now
use one owned form encoder and emit four separate event fields. The real control
regressions failed on the prior code with one joined value instead of four values.
C1's owned conformance fixture is corrected to assert this wire representation.

**Corrected by the checker on 2026-09-27:** the earlier reading of the voice
callback documentation incorrectly treated omission of the HTTPS port as the only
valid signing form. The installed Twilio 5.10.4 validator accepts both port forms
and both legacy-querystring forms because backend signing is inconsistent. The
previous 200/403 test cemented the wrong rejection; the corrected expectation is
200 for both. WSS retains its separate exact-URL and trailing-slash behavior.

**Coverage correction:** the earlier “including long keys” claim was inaccurate.
The 128 committed HMAC vectors used 8–22-byte keys; none exercised the >64-byte
branch. The re-check adds independently checked 64-, 65-, and 80-byte keys (the last
is 40 Unicode characters). Their new proof is recorded below, separately from the
historical short-key measurements.

The production catalog regression composes the actual first-party export. Replacing
that export with `plugins = []` makes the bridge fallback fail for missing
`ovo.carrier.ingress`, rather than passing on an injected replacement definition.
The legacy request adapter also accepts the existing optional `workspaceId` field,
which the distribution bridge supplies; omitting it caused the full typecheck to
fail with TS2353 before the compatibility correction.

**Still open:** resume handoff reads `binding.config.resumeUrl`, but persisted
bindings deliberately disallow that property. A schema-valid production binding
returns `Twilio resume URL is unavailable`. The existing conformance setup injects
an invalid binding and does not prove production resume. A checker decision is
pending for an explicit host-built per-call resume URL seam through the frozen
contract and API handoff adapter. This unit remains in progress despite its green
checks; no reduced handoff capability is claimed as completion.

### Verification checkpoint

All commands used Node 22 on the rebased foundation head `f84ce3d`.

- Authorized `pnpm install`: EXIT 0; `pnpm install --frozen-lockfile --offline`: EXIT 0.
- `node scripts/lint.mjs --only packages/plugin-carrier-twilio packages/plugin-telephony-twilio`: EXIT 0 (7 gates; architecture zero baselined edges).
- `pnpm format:check`: EXIT 0; `node scripts/check-duplication.mjs`: EXIT 0 (770 source files, 59 existing pairs).
- Owned `pnpm exec prettier --check packages/plugin-carrier-twilio packages/plugin-telephony-twilio`: EXIT 0.
- `pnpm exec vitest run packages/plugin-carrier-twilio packages/plugin-telephony-twilio packages/distribution --reporter=dot`: EXIT 0, 81 passed. This is the exact command for that number.
- `pnpm exec vitest run --reporter=dot`: EXIT 0, 1,194 passed / 138 database-gated skips (1,332 total).
- `pnpm typecheck`: EXIT 0; `pnpm build`: EXIT 0 (three application bundles and the normal console production build).
- No storage implementation changed; no Postgres run is claimed for this checkpoint.

## Checker ruling applied — 2026-09-27

The resumption ruling supersedes the pending resume decision recorded above. The frozen `HandoffTarget` contract cannot carry the per-call host callback needed by the spec's resume handoff, and the persisted binding schema deliberately forbids `resumeUrl`. C1 now accepts an owned structural `TwilioHandoffTarget` (`HandoffTarget & { resumeUrl?: string }`); only its resume branch consumes the callback. It requires HTTPS without credentials or fragment, the matching `/carriers/twilio/:bindingId/resume` path and nonempty `r` and `t`. Missing/invalid callback refuses before any NetPort operation, even if a binding contains a hidden resumeUrl. No frozen contracts or API caller changed.

**Contract gaps:** `apps/api/src/carrier-handoff.ts` still supplies only `{kind:'resume'}`. I1 must formalize the callback context and wire this caller to its authenticated host URL builder; this unit does not claim that API resume handoff works before that integration. O2 inherits the requirement to preserve ledger and idempotency semantics. The existing stream-continuation HTTP route already uses `host.resumeStream` and `host.callbackUrl`, and returns Hangup for an ended route. D1's per-session fixture encoder remains a local ingress extension for I1's shared-contract decision.

The latest checker explicitly requires the genuine Twilio validator as an independent **test-only** oracle, superseding the spec's blanket “no SDK” wording for this proof. Only the legacy package's existing `twilio` dependency is imported by that test; production vendor sources import contracts/runtime and their own modules only. The SDK oracle invokes only the offline validateRequest and getExpectedTwilioSignature functions; production C1 constructs no SDK client. The saved 2026-09-26 published example is reused; no vendor documentation or endpoint was fetched this round. Explicit-port WSS behavior is still UNCONFIRMED. Frozen conformance stays byte-identical to foundation.

The restored WIP's regex decoder duplicated C2's new protocol check. C1 now decodes and checks canonical base64 by re-encoding, rejecting whitespace, unpadded and noncanonical encodings; no baseline or shared source changed. Route aliases that contradict each other, non-inbound/invalid DTMF, unsafe numeric fields and inherited object keys masquerading as call states also fail closed.

### Conditional and optional-input matrix

All cases below run in the normal Vitest suite, through the real distribution where practical, with synthetic credentials. The production socket proof uses C2 `MediaGateway`, `WorkerDialer`, `attachWorkerMediaServer`, and the real `WorkerMediaLink`; only external carrier and host storage ports are fixtures. No carrier identity is added to gateway source.

| Guard / input                          | Positive                                                                                   | Absent and negative                                                                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Carrier selection / ingress / duration | Real distribution, release.selections, FixtureNet dial, socket media                       | Pre-C1 lacks mounted route (404) and duration capability (false); wrong stream call identity refuses before worker admission                                              |
| HTTP signature / raw query             | Genuine SDK validates independently signed exact raw query; production gateway returns 204 | Missing/empty/wrong signature, same signature over stripped or doubled query fails; all routes refuse before host mutation                                                |
| WSS signature                          | Exact wss URL and trailing slash                                                           | Absent/wrong signature, https, changed host/port and query rejected                                                                                                       |
| URL secret                             | Host-generated token                                                                       | Absent/empty/incorrect t refuses status, AMD and resume                                                                                                                   |
| AMD / timeout                          | Detect and hangup-on-machine, explicit timeout                                             | AMD absent/off omits fields; enabled without callback refuses; timeout absent defaults 60                                                                                 |
| REST result / retry                    | Complete receipt; 429 retryable; terminal and live states                                  | 400/401 nonretryable; 408/500/503/transport unknown; null/array/malformed/missing/empty receipt unknown; absent identifier/unknown state pending; inherited keys rejected |
| Reconcile answered_by / hangup         | Human/machine; REST end and 20404 already ended                                            | Answer evidence absent remains absent; unknown maps unknown; request-id-only hangup unsupported; other errors throw                                                       |
| Resume handoff                         | Authenticated host callback, schema-valid binding, confirmed receipt                       | Callback absent/empty/wrong binding/path, missing token, wrong scheme, credentials or fragment rejected; hidden binding URL ignored                                       |
| Handoff phone/queue/end                | Conformance forms, XML escaped text                                                        | Empty/invalid number or queue refuses; empty end message emits no Say; missing handoff receipt unknown                                                                    |
| Admission fields / digits / body       | Complete inbound fields; Digits dispatches confirmation                                    | Digits absent/empty dispatches admission; each required field absent/oversized rejects; duplicate/invalid UTF-8/oversized body rejects                                    |
| Decisions / announcements              | Every decision renders; announced wait and human/busy/hangup messages                      | Optional messages/callerId/timeout absent omit markup; announce false suppresses text; missing connect resume uses host callback                                          |
| HTTP resume / event result             | Fresh grant with/without optional resume callback                                          | Ended route returns Hangup; unknown event state refuses; unmatched/conflict map 404/409; host-port exceptions return 503                                                  |
| Codec route / stream / sequence        | Canonical sid/rt and legacy aliases, timestamp strings, media/mark/clear/DTMF              | Route params absent/empty/conflicting reject; replay/cross-stream/unstarted frames refuse; outbound track produces no input; DTMF missing/invalid track or digit refuses  |
| Codec output / decoding                | 8 KiB chunks and real worker round trip                                                    | Empty audio/flush/termination emit zero frames, but worker termination closes socket; malformed/noncanonical base64 rejects                                               |

### Behavioral true negatives (2026-09-27)

Copied only the production proof and control matrix tests to the untouched foundation `353ba5d`, ran the three focused acceptance checks, then removed those temporary files. All three failed with value assertions: HTTP `expected 404 to be 204`; duration `expected false to be true`; resume expected confirmed, received rejected with `Twilio resume fallback URL is not configured`. No import/module failures. `/tmp/ovo-c1-pre-c1-proof.log` records the exact failures. Filter-excluded tests in these proof runs are not disabled tests and are not the full-suite skip counts.

The independent SDK assertion uses one Node-HMAC signature over a Twilio-shaped form and `https://voice.example.test/carriers/twilio/b1/status?r=dial-1&t=token&raw=%2f+%20&other=%2F`. Genuine `twilio.validateRequest` returns true for that exact URL, false for its query-stripped version, and false for the doubled-query version. It is separate from the frozen self-consistent conformance signer/verifier.

Each deliberate mutation below was restored in a finally block, then the positive suites rerun. All 16 mutation commands exited 1 with assertion failures, never module-resolution failures. Logs: `/tmp/ovo-c1-mutant-<name>.log`; machine-readable results `/tmp/ovo-c1-mutations.json`.

| Broken version / log suffix                               | Failure produced                                                                           |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| http-query-stripped: remove HTTP query before signing     | `expected 403 to be 204`                                                                   |
| hidden-binding-resume: source callback from binding again | `expected { Url: '', Method: 'POST' } to deeply equal …` (expected authenticated callback) |
| amd-never-enabled: suppress AMD fields                    | `expected null to be 'DetectMessageEnd'` (both enabled modes)                              |
| 429-not-retryable: force retryable false                  | received rejected/retryable false, expected true                                           |
| empty-receipt-accepted: permit an empty dial sid          | `expected 'accepted' to be 'unknown'`                                                      |
| inherited-call-state: remove own-property check           | `expected 204 to be 400` for constructor and **proto**                                     |
| signature-always-valid: bypass HMAC comparison            | `expected 200 to be 403` (absent, empty, wrong)                                            |
| url-secret-bypass: skip host URL authentication           | `expected 204 to be 403` (absent, empty, wrong)                                            |
| alias-conflict-accepted: remove alias consistency check   | `expected [Function] to throw an error`                                                    |
| dtmf-guard-removed: accept invalid DTMF track/digit       | `expected [Function] to throw an error`                                                    |
| noncanonical-base64: remove canonical encoding check      | `expected [Function] to throw an error`                                                    |
| terminal-reconciled-live: classify every state as live    | received live, expected ended for completed/busy/no_answer                                 |
| oversized-chunks: double output chunk limit               | `expected … to have a length of 3 but got 2`                                               |

Three additional mutations defend numeric parsing, XML escaping and the absent end message. `unsafe-frame-numbers` restores permissive Number coercion (blank numeric fields); `unescaped-markup` leaves `<` unescaped (expected the escaped parameter string); `empty-say` emits Say for an empty message (received `<Response><Say></Say><Hangup/></Response>`, expected `<Response><Hangup/></Response>`). Each exits 1 with a value/exception assertion. The final numeric proof orders chunk/timestamp before sequence so failure proves acceptance of invalid audio fields, rather than a different duplicate-sequence error.

The final missing-route test was first run against the working C1 implementation before adding its guard: an empty sid/rt map reached FixtureNet and returned unknown, failing the expected nonretryable rejection (`MISSING_ROUTE_TRUE_NEGATIVE_EXIT=1`; `/tmp/ovo-c1-missing-route-negative.log`). The fixed markup builder refuses missing/empty sid or rt before REST. The positive boundary test proves a 499-character name+value is accepted, a 500-character pair rejected, and XML-sensitive values escaped. Numeric fields include absent, blank, negative, fractional, nonnumeric and unsafe integers. Empty-array REST fixtures are explicitly wrapped as single table arguments so Vitest does not reinterpret them as zero-argument cases.

## C1 handover — Built – awaiting check (2026-09-27)

**Code `9207fc1` on `w2/C1`, unmerged**, based on the current Batch A foundation `353ba5d`. Restored WIP was consolidated into a code-only commit; this board/spec report is a separate documentation commit. No push or PR. C4 and S2 await C1's check/merge; C3 remains founder-held and every other paused branch is unchanged.

The production distribution now supplies Twilio control and ingress together, selected through release.selections. A FixtureNet dial produces TwiML for the actual C2 loopback gateway; the real worker link receives audio/DTMF, returns audio/mark/clear, receives playback evidence, and terminates the socket. HTTP callback signatures are independently proved with the genuine SDK validator. No Twilio-specific gateway source was added. The façade dependency points legacy → vendor only. Vendor production sources use contracts/runtime/local imports; the architecture gate reports **0 baselined edges**, and no baseline file changed.

### Measured green bar

All commands run from `/Users/tejassuds/work/ovo-w2-C1` with `export PATH=/opt/homebrew/opt/node@22/bin:$PATH`; actual Node version **v22.23.2**. These are the commands actually run, with literal exits. Gate components were invoked individually, including console E2E; an aggregate `pnpm check` or a network registry audit is not claimed for this offline carrier run.

| Command                                                                                                                                                                                         | Result                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `pnpm install --offline`                                                                                                                                                                        | `INSTALL_EXIT=0`                                                               |
| `pnpm install --frozen-lockfile --offline`                                                                                                                                                      | `FROZEN_OFFLINE_EXIT=0`                                                        |
| `node scripts/lint.mjs --only packages/plugin-carrier-twilio packages/plugin-telephony-twilio`                                                                                                  | `SCOPED_LINT_EXIT=0`, 7 gates, architecture 0 baselined edges                  |
| `pnpm format:check`                                                                                                                                                                             | `FORMAT_EXIT=0`                                                                |
| `node scripts/check-duplication.mjs`                                                                                                                                                            | `DUPLICATION_EXIT=0`, 834 source files, 54 existing pairs; baselines untouched |
| `pnpm exec prettier --check packages/plugin-carrier-twilio packages/plugin-telephony-twilio`                                                                                                    | `OWNED_FORMAT_EXIT=0`                                                          |
| `pnpm lint`                                                                                                                                                                                     | `FULL_LINT_EXIT=0`                                                             |
| `node scripts/typecheck-scope.mjs packages/plugin-carrier-twilio packages/plugin-telephony-twilio`                                                                                              | `SCOPED_TYPECHECK_EXIT=0`                                                      |
| `pnpm typecheck`                                                                                                                                                                                | `TYPECHECK_EXIT=0`                                                             |
| `pnpm exec vitest run packages/plugin-carrier-twilio packages/plugin-telephony-twilio packages/distribution --reporter=dot`                                                                     | `SCOPED_TEST_EXIT=0`, **155 passed**                                           |
| `pnpm exec vitest run --reporter=dot --reporter=json --outputFile=/tmp/ovo-c1-default.json`                                                                                                     | `DEFAULT_TEST_EXIT=0`, **1,676 passed / 153 skipped / 0 failed**               |
| `OVO_TEST_POSTGRES_URL=postgresql://postgres:fixture@127.0.0.1:32908/postgres pnpm exec vitest run --no-file-parallelism --reporter=dot --reporter=json --outputFile=/tmp/ovo-c1-postgres.json` | `POSTGRES_SERIAL_EXIT=0`, **1,821 passed / 8 skipped / 0 failed**, 185.07 s    |
| `pnpm build`                                                                                                                                                                                    | `BUILD_EXIT=0`, 3 app bundles and console production build                     |
| `pnpm test:console:e2e`                                                                                                                                                                         | `CONSOLE_E2E_EXIT=0`, **41 passed / 1 desktop visibility skip**                |

**1,676 + 153 = 1,829.** Separately, **1,821 + 8 = 1,829.** C1 adds 120 runtime tests to the foundation's 1,709 total, with no new skipped tests. 145 default skips activate under the main Postgres variable. The eight remaining are one `apps/api/tests/cost.test.ts` case gated by `LEDGER_TEST_DATABASE_URL`, four recording cases gated by `RECORDING_TEST_DATABASE_URL`, and three backup/restore cases gated by `OVO_BACKUP_DRILL_POSTGRES_URL`. No disabled tests. Playwright's single skip is the already-verified invisible desktop Menu trigger.

**Intermediate failure disclosed:** an overlapping verification run returned `POSTGRES_SERIAL_EXIT=1`, 1,820 passed / 8 skipped / 1 failed, solely at `scripts/tests/tools.test.ts` (“runs all seven gates and forwards --only”), which observed a child lint exit 1. The child output was not exposed by that assertion, so its cause is not claimed. Running its exact `node scripts/lint.mjs --only packages/audio` directly returned 0. With no concurrent build/test or repository edits, the full serial run above passed on the same product source. The failed run is preserved in `/tmp/ovo-c1-postgres-concurrent-failure.{log,json}`; no frozen script or unrelated source was changed to make it green.

Logs are `/tmp/ovo-c1-{install,frozen,lint,format,duplication,owned-format,full-lint,type-scope,typecheck,scope-final,default,postgres,build,e2e}.log`; the default/Postgres JSON reports record individual test results. The absent/negative matrix, three pre-C1 failures, 16 mutation failures and the missing-route before-fix failure are recorded above alongside the independently measured SDK/socket proof. No module-resolution failure is counted as evidence.

### Limits and cleanup

- **Contract gap retained for I1:** the API's resume handoff caller is not wired to the new per-call callback context; it fails closed until I1 fixes the contract/caller. Stream-continuation resume is tested through the gateway now. No hidden binding URL is used.
- The frozen conformance doubled-query reference driver remains HARD BLOCKING I1. Explicit-port WSS behavior is UNCONFIRMED; there is no live carrier or vendor-sandbox claim.
- Only synthetic credentials, FixtureNet and loopback sockets were used. No real credentials, vendor endpoint, live/provider/paid flags, actual call, AWS, push or PR was used.
- The owned `postgres:17.6` container `ovo-c1-verify-0927`, bound only to `127.0.0.1:32908`, was stopped and removed. C1's Playwright artifacts were removed. No other container/image was stopped, removed or pruned. Disk is 21 GiB free at cleanup; foundation plus C1 are the only two worktrees. Keep C1 for the checker, then remove it after merge.

## Checker turnaround — HTTPS signature compatibility (2026-09-27)

The checker rejected C1 solely for narrowing the SDK’s HTTPS signature variants.
`signature.ts` now tries no-port, with-port (including explicit default 443 when the
base omits a port), and the legacy-querystring version of each. This supersedes the
earlier port-stripping-only note. Raw externalUrl still arrives unchanged from C2;
only this carrier’s authentication layer constructs the SDK-compatible candidates.
The original raw-query HMAC proof remains valid. Legacy query reserialization is
an explicit additional accepted form, not a claim that every raw-query byte change
must fail. Each candidate still needs a valid full HMAC. WSS receives none of this
HTTPS normalization and still rejects query-bearing URLs, even when correctly signed.

The legacy conversion uses web primitives in the vendor plugin, with no Node import
or new dependency. Tests compare it against the installed SDK and node:querystring
for absent/empty queries, escaping and numeric key ordering, repeated/inherited keys,
malformed encodings, and the reference parser’s 1,000-pair limit. Wrong/empty tokens
fail for every case. The four HTTPS candidates are also driven independently through the real
distribution, release selection and C2 loopback gateway for both `:8443` and an
omitted public port (all four are distinct at `:8443`).

**Deliberate spec deviation — account SID syntax:** retain
`^AC[0-9a-fA-F]{32}$` rather than the spec’s lowercase-only hex suffix. This keeps the
binding schema consistent with the existing case-insensitive control validator and
legacy compatibility; it neither rewrites nor lowercases identifiers. The production
PluginRegistry test accepts lowercase and uppercase hexadecimal suffixes and rejects
absent, empty, nonhex and short values. This is a syntactic compatibility decision,
not a vendor-confirmation claim.

Additional requested cases run through the installed ingress/control: matching
canonical+legacy aliases; raw machine → machine and fax → unknown; callerId alone;
timeout alone; timeout 0 omitted; and announce:true without a message emits no Say.
The existing absent, contradictory and invalid cases remain. No shared production
file, frozen file, manifest, lockfile or baseline changes in this correction. I1
inherits these compatibility tests when deleting the legacy façade; the existing
resume-context and conformance-driver blockers remain unchanged.

### Re-check proof: independent oracle and deliberate breakages

Before the correction, the final `wire-regression.test.ts` and `signature-query.test.ts` were run with `signature.ts` restored verbatim from `9207fc1`. Result: **BEFORE_FIX_EXIT=1, 10 failed / 6 passed**. The port-signed inbound case reported `expected 403 to be 200`; the with-port and two legacy-query gateway cases reported `expected 403 to be 204`; all six SDK query-parity cases reported `expected false to be true`. The genuine SDK accepted each signature before the production assertion failed. The no-port gateway counterpart passed. This is a pre-repair behavioral proof, not a missing-module failure. Log: `/tmp/ovo-c1-recheck-before-final.log`.

With the fix restored, the SDK and independent Node HMAC agree. All four HTTPS candidates pass through the actual distribution, release selection and C2 gateway with one host event per request: eight successful loopback requests across `:8443` and omitted-port bases. All four candidates are distinct at `:8443`; the SDK's legacy default-port candidates coincide after URL normalization. Six additional query cases agree with the SDK and reject empty/wrong tokens. The original raw-query and real worker/media proofs remain in the unchanged `production-ingress.test.ts` and pass in the scoped/full runs.

Each mutation below was applied alone to production source, tested, and restored. **All 16 returned EXIT=1 with assertion failures**, then the restored scoped suite passed **177/177**. The extra cases for existing correct behavior are defended by mutations, not misrepresented as defects in the pre-repair code.

| Check                          | Deliberately broken production version                                                            | Observed assertion failure                                                                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No-port HTTPS candidate        | Delete just `withoutPort` from the candidate set                                                  | `expected 403 to be 204`                                                                                                                                                                                               |
| With-port HTTPS candidate      | Delete just `withPort`                                                                            | `expected 403 to be 204`                                                                                                                                                                                               |
| Legacy query without port      | Delete just `legacyQueryUrl(withoutPort)`                                                         | `expected 403 to be 204`                                                                                                                                                                                               |
| Legacy query with port         | Delete just `legacyQueryUrl(withPort)`                                                            | `expected 403 to be 204`                                                                                                                                                                                               |
| WSS query prohibition          | Remove `new URL(url).search` from the upgrade guard; request still has its correct exact-URL HMAC | `expected { ok: true, params: {} } to deeply equal { ok: false, status: 403 }`                                                                                                                                         |
| Equal canonical/legacy aliases | Reject co-presence regardless of `!==`                                                            | `expected [Function] to not throw an error`; received `CarrierProtocolError: Conflicting Twilio session route parameters`                                                                                              |
| Raw machine answer             | Remove `raw === 'machine'`                                                                        | Expected `answeredBy: 'machine'`, received `'unknown'`                                                                                                                                                                 |
| Fax answer                     | Map only fax to machine                                                                           | Expected `answeredBy: 'unknown'`, received `'machine'`                                                                                                                                                                 |
| callerId alone                 | Require timeout too before emitting callerId                                                      | Expected `<Dial callerId="+15550456">`, received `<Dial>`                                                                                                                                                              |
| Timeout alone                  | Require callerId too before emitting timeout                                                      | Expected `<Dial timeout="4">`, received `<Dial>`                                                                                                                                                                       |
| Zero timeout                   | Emit timeout whenever defined                                                                     | Expected `<Dial>`, received `<Dial timeout="0">`                                                                                                                                                                       |
| Announcement without message   | Drop the message-presence guard                                                                   | `expected 400 to be 200`                                                                                                                                                                                               |
| HMAC key boundary              | Skip hashing keys longer than 64 bytes                                                            | 65-byte: expected `BxgBfjymdUGCUOFm/m6rl6XyW/Y=`, received `Tei/CPsUXa0ixidIXGcmI2IuJm4=`; 80-byte: expected `J8dMy8hxwHoxpf1QBpgyreZLyb8=`, received `Eo89EYcsibTmgla2kK0GQqWT5wk=`; 64-byte counterpart still passes |
| Deliberate SID syntax          | Narrow only the installed schema to lowercase                                                     | Expected `{ ok: true }`, received `{ ok: false, errors: … }` for uppercase hex                                                                                                                                         |
| Legacy query encoding          | Substitute URLSearchParams serialization                                                          | `expected false to be true` against the SDK-signed legacy candidate                                                                                                                                                    |
| Reference query limit          | Remove the 1,000-pair cap                                                                         | `expected false to be true` for the 1,001-pair case                                                                                                                                                                    |

Exact mutation commands, filters and assertion summaries are in `/tmp/ovo-c1-recheck-mutations.json`; full outputs are `/tmp/ovo-c1-recheck-mutant-*.log`. No production mutation remains. Historical 16-mutation and pre-C1 proofs above remain valid and are not counted again as new tests.

### Re-check handover — Built – awaiting check

**Correction `fa9aa00` on `w2/C1`, unmerged.** Rebased onto foundation `b5ce7ab`
before the repair; the earlier C1 source commit is now `ced1e8e`. This report and
the board update are a separate documentation commit. The checker’s approval is
pending; C4 and S2 have not started. C3 and all other held heads remain paused.

Only `packages/plugin-carrier-twilio/src/signature.ts` changes in production in
this correction. Tests are in the two owned carrier packages. No frozen source,
gateway, other unit’s source, manifest, lockfile or baseline changed in this pass.
The architecture gate still reports **0 baselined edges**.

All following commands ran in `/Users/tejassuds/work/ovo-w2-C1` with
`export PATH=/opt/homebrew/opt/node@22/bin:$PATH` and **Node v22.23.2**. Commands
match the measured counts; no aggregate `pnpm check` or network registry audit is
claimed. Gate components include the standing console E2E obligation.

| Actual command                                                                                                                                                                                          | Measured result                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `node scripts/lint.mjs --only packages/plugin-carrier-twilio packages/plugin-telephony-twilio`                                                                                                          | `SCOPED_LINT_EXIT=0`, seven gates, 0 baselined architecture edges           |
| `pnpm format:check`                                                                                                                                                                                     | `FORMAT_EXIT=0`                                                             |
| `node scripts/check-duplication.mjs`                                                                                                                                                                    | `DUPLICATION_EXIT=0`, 834 source files / 54 existing baseline pairs         |
| `pnpm exec prettier --check packages/plugin-carrier-twilio packages/plugin-telephony-twilio`                                                                                                            | `OWNED_FORMAT_EXIT=0`                                                       |
| `pnpm lint`                                                                                                                                                                                             | `FULL_LINT_EXIT=0`, seven gates                                             |
| `node scripts/typecheck-scope.mjs packages/plugin-carrier-twilio packages/plugin-telephony-twilio`                                                                                                      | `SCOPED_TYPECHECK_EXIT=0`                                                   |
| `pnpm typecheck`                                                                                                                                                                                        | `TYPECHECK_EXIT=0`                                                          |
| `pnpm install --frozen-lockfile --offline`                                                                                                                                                              | `FROZEN_OFFLINE_EXIT=0`                                                     |
| `pnpm exec vitest run packages/plugin-carrier-twilio packages/plugin-telephony-twilio packages/distribution --reporter=dot`                                                                             | `SCOPED_TEST_EXIT=0`, 177 passed                                            |
| `pnpm exec vitest run --reporter=dot --reporter=json --outputFile=/tmp/ovo-c1-recheck-default.json`                                                                                                     | `DEFAULT_TEST_EXIT=0`, **1,698 passed / 153 skipped / 0 failed**, 52.16 s   |
| `OVO_TEST_POSTGRES_URL=postgresql://postgres:fixture@127.0.0.1:32909/postgres pnpm exec vitest run --no-file-parallelism --reporter=dot --reporter=json --outputFile=/tmp/ovo-c1-recheck-postgres.json` | `POSTGRES_SERIAL_EXIT=0`, **1,843 passed / 8 skipped / 0 failed**, 191.85 s |
| `pnpm build`                                                                                                                                                                                            | `BUILD_EXIT=0`, three app bundles and console production build              |
| `pnpm test:console:e2e`                                                                                                                                                                                 | `CONSOLE_E2E_EXIT=0`, **41 passed / 1 desktop visibility skip**             |

**1,698 + 153 = 1,851.** Separately, **1,843 + 8 = 1,851.** This repair adds
22 runtime test cases over the previous 1,829 total and adds no skips. All 153
default skips are database-gated; 145 activate in this serial run. The remaining
eight are one ledger case (`LEDGER_TEST_DATABASE_URL`), four recording cases
(`RECORDING_TEST_DATABASE_URL`), and three backup/restore cases
(`OVO_BACKUP_DRILL_POSTGRES_URL`). No disabled tests.

**Intermediate gate failure:** the first lint/format/duplication pass was **1/0/0**.
Two expanded tests exceeded 500 canonical lines (519 and 514). The new scenarios
were split into `inbound-optionals.test.ts` and `signature-query.test.ts`; no
baseline was added. Both original production-gateway tests remain unchanged.
The subsequent lint/format/duplication pass was **0/0/0**. There was no failure in
the complete default or Postgres run this round. Logs use the prefix
`/tmp/ovo-c1-recheck-`; before-fix and mutation failures are intentional proof.

**Cleanup and limits:** `ovo-c1-recheck-0927` used local `postgres:17.6`, published
only on `127.0.0.1:32909`, and was stopped and removed after the serial run. Own
Playwright artifacts were removed; no other containers or images were touched.
Disk was 20 GiB free at cleanup. Only foundation and C1 worktrees remain. All
carrier work used synthetic tokens, FixtureNet, offline SDK functions and loopback;
no real credentials, vendor requests, live/provider/paid flags, real calls, AWS,
push or PR. **Contract gaps:** I1 still owns the authenticated API resume context
and the frozen conformance doubled-query correction. WSS explicit-port behavior
remains vendor-unconfirmed. No operational claim is made beyond the offline proof.
