# Production media gateway and streaming session evidence

Status: implemented and locally verified protocol/runtime path; carrier and provider capability remain uncertified.

## Scope and topology

This slice implements the simplest operable self-hosted topology for one organization/installation:

- `apps/media-gateway` is the public Twilio Media Streams WebSocket endpoint and internal worker router.
- `packages/plugin-media` owns bounded WebSocket framing, Twilio-to-worker routing, durable call/stream ownership, worker authentication, and worker media sessions.
- `packages/plugin-voice` owns normalized streaming STT/TTS types, transcript turn policy, carrier-mark-aware speech output, and the scoped voice session engine.
- `workspaceId` remains an internal compatibility/security namespace. It is not a tenant-routing or tenant-provisioning mechanism.
- Worker `ownerId` and `ownerEpoch` fence multiple workers for one installation; they do not represent tenants.

No paid network or external provider call was made.

## Runnable gateway

`@winsendotai/ovo-media-gateway` builds to a Node executable. Production requires:

- `OVO_MEDIA_PUBLIC_BASE_URL`: exact externally visible HTTPS origin used for Twilio signature verification.
- `TWILIO_AUTH_TOKEN`: server-side Twilio signature secret.
- `OVO_MEDIA_WORKER_TOKEN`: internal route/worker authentication token.
- `DATABASE_URL`: required for the orchestration-owned durable session route and one-time handshake.

The app composes ordinary Cordis plugins for the injected orchestration route resolver and gateway. It requires PostgreSQL in every mode so local and production runs exercise the same durable session-route authority.

### Endpoints

- `GET /health`: readiness and active-session count; returns 503 during drain.
- `WS /worker`: authenticated worker WebSocket. The first bounded message must be `worker.hello` with the configured token.
- `WS /twilio/media`: signed Twilio Media Streams WebSocket.

The Twilio signature is validated against `OVO_MEDIA_PUBLIC_BASE_URL + request-target`, including the exact path and query string. Host and forwarding headers do not redefine the signed URL.

## Durable routing and ownership

The gateway does not own a second route table. Its injected `MediaRouteResolver` consumes the orchestration-owned `ovo_session_routes` record that is transactionally created with dial intent before carrier activity. `apps/media-gateway` uses `PostgresOrchestrationStore` directly.

The Twilio start frame must carry opaque `sessionId` and one-time `routeToken` custom parameters. The gateway atomically claims that token through `authenticateSessionRoute`, independently resolves the accepted `callSid`, and requires both durable views to match on session ID, worker ID, owner epoch, and generation. A token can win only once, including across gateway processes. Terminal routes are rejected. The gateway then routes only to the authenticated WebSocket for that exact worker and includes session ID, call SID, stream SID, owner epoch, and generation on every worker message; it never round-robins session state.

The worker/deployment integration hook is `WorkerGatewayClient` plus the shared orchestration route store. The worker transactionally creates the route before dial, puts the opaque session ID/token in TwiML, retains its durable epoch/generation lease, connects as the same worker ID, and creates one call-scoped composition when `session.open` arrives.

## Protocol, bounds, and lifecycle

Only Twilio mono `audio/x-mulaw` at 8 kHz is accepted. The gateway rejects unsupported formats, duplicate/out-of-order sequence numbers, oversized messages, oversized decoded audio frames, media before a matching start, and output from a worker that does not match all of call SID, stream SID, owner ID, and owner epoch.

Default bounds/deadlines:

| Control                  | Default |
| ------------------------ | ------: |
| WebSocket message        |  64 KiB |
| decoded audio frame      |   8 KiB |
| socket buffered bytes    | 256 KiB |
| pre-accept frames        |      25 |
| worker/carrier handshake |     5 s |
| media idle deadline      |    30 s |
| gateway drain deadline   |    30 s |

Worker or carrier backpressure beyond the bound cancels the session rather than growing memory or silently dropping critical media. Drain rejects new routes/upgrades, waits for current sessions to finish up to the deadline, then cancels the remainder. Carrier `stop`, socket loss, owner-worker loss, idle timeout, and explicit worker close all release route ownership and dispose the session.

The WebSocket server implements bounded RFC 6455 text/control framing directly, requires client masking, rejects fragmentation/unsupported opcodes, answers ping, and bounds 16/64-bit lengths before allocation.

## Streaming worker session

Normalized provider ports live in `packages/plugin-voice/src/provider-types.ts` so provider plugins can import them without a media/provider cycle:

- `StreamingStt` / `StreamingSttSession`
- `TranscriptRevision`
- `StreamingTts`
- `VoiceMediaTransport`

Service keys align with the provider package: `ovo.stt` and `ovo.tts-streaming`. The call composition selects:

1. one `ovo.media.duplex` session plugin;
2. one normalized streaming TTS plugin;
3. media speech output;
4. the bounded speech scheduler;
5. one behavior plugin;
6. one normalized streaming STT plugin;
7. the voice session engine.

`VoiceSessionEngine`:

- feeds bounded 8 kHz mu-law frames to the call-scoped STT session;
- ignores stale transcript revisions and accepts only one final, endpointed revision per text;
- distinguishes configured short backchannels from meaningful speech-start barge-in;
- cancels behavior and interrupts the speech epoch on meaningful barge-in;
- obtains the next scheduler epoch, calls `behavior.beginTurn(epoch)` before `respond`, and never accepts a caller-supplied epoch;
- calls `behavior.onPlayback(receipt)` after speech settles, allowing script state to commit only on matching completed playback;
- calls `behavior.cancel()` on interruption and hangup;
- routes DTMF through `respond(digit, { inputEvent: "dtmf" })`;
- finishes/closes STT, disposes speech, closes media, and removes listeners on hangup/disposal.

## Playback evidence

`StreamingMediaSpeechOutput` streams normalized mu-law TTS bytes to the worker media transport, sends a unique epoch-qualified Twilio mark, and returns `completed/confirmed` only after that exact mark comes back from Twilio. `clear` first removes the pending mark and settles it `interrupted/estimated`; a late old mark is ignored and cannot confirm a newer or identical response.

Context and agent behaviors consume the optional inference stream and deterministically segment completed sentences or bounded 240-character chunks. `VoiceSessionEngine` begins scheduler playback before inference completion, permits at most two unconfirmed segments ahead by default (configurable from one to eight), and stops both provider iteration and queued playback on barge-in. Only matching completed segment receipts enter conversation history; interrupted or superseded output contributes a single interruption marker and never raw unplayed text. Tool calls remain schema-only at the inference boundary and execute only through shared `Execution`; a provider response that mixes streamed speech with a tool selection is rejected before any tool side effect.

Scheduler history now distinguishes:

`generated -> queued -> started -> sent/estimated -> acknowledged/confirmed -> completed/confirmed`

Interrupted/failed/dropped paths remain terminally distinct. Generated text is never recorded as played merely because synthesis began.

## Local verification

Focused tests execute an actual loopback HTTP/WebSocket gateway with no external traffic:

- exact Twilio public-URL signature acceptance and mismatched-URL rejection;
- authenticated worker WebSocket registration;
- one-time session-token claim plus accepted call resolution to the durable owner identity;
- 8 kHz mu-law inbound/outbound frames;
- Twilio mark acknowledgement and clear;
- carrier stop propagation;
- ten competing one-time route authentications with one winner;
- bounded pre-accept backpressure cancellation;
- streaming TTS bytes through the scheduler;
- confirmed playback only after matching mark;
- clear/interruption followed by ignored late mark;
- partial/final revision handling, scheduler-owned epochs, DTMF, disposal;
- an ordinary scoped plugin composition for behavior, media, STT, TTS, scheduler, and session engine.

New production-media suites: 2 files, 8 tests passed. Combined voice/media package run: 3 files, 13 tests passed. The final whole-workspace run passed 200 tests with 43 explicitly skipped database-gated tests. Scoped TypeScript, gateway build, formatting, and owned module-size checks passed.

## Uncertified gates

This is an executable production-shaped gateway/session core, not carrier certification. The following remain explicitly unverified:

- real Twilio owned-number inbound/outbound calls and Twilio edge/proxy behavior;
- real Deepgram streaming endpoint/VAD events, reconnects, usage, and language quality;
- real OpenAI TTS byte format, latency, cancellation billing, and usage reconciliation;
- human-perceived interruption quality, packet loss/jitter, long calls, and load/soak targets;
- PostgreSQL failover and multi-process route races against a deployed database;
- transfer capability and live recording alignment.

W04, W05, and W06 therefore remain in progress. No carrier, STT, TTS, language, latency, or production-readiness capability is certified by these local fixtures.
