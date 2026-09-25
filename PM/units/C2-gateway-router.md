# Work unit C2-gateway-router: Carrier-neutral media gateway router on ws, duration-budgeted pre-accept buffer, gateway-dials-worker on the shared port 4100, route start rules, terminate and drain, recordings format widening

Wave: 2
Depends on: F1-contracts-runtime, F2-kits-gates, F3-host-seams, F4-apps-data-driven
Defects fixed: [2, 23, 27, 1, 26]

## Owned paths

- packages/plugin-media/**
- apps/media-gateway/** (not package.json)
- apps/worker/src/media-runtime.ts
- apps/worker/src/session-handshake.ts
- apps/worker/src/worker-media-bootstrap.ts
- apps/worker/src/worker-media-server.ts
- apps/worker/tests/media-runtime.test.ts
- apps/worker/tests/lifecycle.integration.test.ts
- packages/plugin-recordings/src/capture.ts
- packages/plugin-recordings/src/capture-*.ts
- packages/plugin-recordings/src/wav.ts
- packages/plugin-recordings/tests/production-recordings.test.ts
- packages/plugin-recordings/tests/recordings.test.ts
- packages/plugin-recordings/tests/production-fixtures.ts
- packages/distribution/src/profiles/gateway.ts
- scripts/baselines/pending/C2.json

## Shared touchpoints (minimal edits allowed)

- apps/worker/tests/lifecycle.integration.test.ts: C2 owns it; O1 may make compile-only edits in separate hunks for signatures O1 changed

## Specification

GOAL: make packages/plugin-media and apps/media-gateway carrier-neutral routers that mount every installed carrier's ingress, so adding Exotel or Plivo needs no gateway edits. This unit also fixes:

- #2: the 25-frame (about 500 ms) pre-accept buffer dropped calls when worker setup was slower;
- #23: the gateway was forced to one replica, workers never reconnected, and a gateway deploy dropped every call;
- #27b: the hand-rolled WebSocket rejected fragmented frames;
- the router half of #1 (pass the verbatim external URL);
- the campaignAttemptStatus part of #26.
  Read docs/architecture/plugin-platform.md (revision 2): section 2.8, section 4.10 (termination, resume and correlation rules the router enforces) and section 5 (normative).

A. Router (packages/plugin-media; modules ≤250 lines: router.ts, upgrade.ts, session-bridge.ts, pre-accept.ts, worker-dialer.ts, protocol.ts, health.ts, drain.ts, plugin.ts)

- The gateway process composition requires the many-key 'ovo.carrier.ingress', and routes are built from ctx.all('ovo.carrier.ingress'):
  - GET /carriers/:carrierId/:bindingId/media (upgrade);
  - POST|GET /carriers/:carrierId/:bindingId/:purpose (routed by purpose);
  - every ingress.legacyPaths entry as an alias;
  - an unknown carrier or purpose → 404.
- UpgradeRequest.url is the full request URL INCLUDING its query (Exotel carries sid, rt and t there). externalUrl is the OVO_MEDIA_PUBLIC_BASE_URL origin (with an explicit non-default port only) plus the exact path, with NO query; the scheme is wss for upgrades and https for HTTP. Pass both verbatim to authenticateUpgrade, with ctx {bindingId, resolveBinding, verifyUrlSecret}, and pass CarrierHttpRequest {externalUrl, query, headers, rawBody, bindingId, remoteAddress} to route.handle.
- On a carrier 'start', in this order:
  1. authenticate the route token via sid and rt;
  2. REFUSE and close before any audio if the durable route is terminating or terminal;
  3. apply the carrier-call-id rule (start.carrierCallId must equal carrier_call_id or carrier_stream_call_id, or be bound via bindCarrierCallId when both are NULL; when the ids differ and the carrier's streamCallIdMatchesDial is not true, record the alias and an audit event);
  4. open the worker link.
- Remove every Twilio import and literal from plugin-media: gateway.ts lines 3-9, 103-115, 196 and 308-311; carrier-callback.ts (delete it); twilioAuthToken in gateway-types.ts and plugin.ts. This also removes the plugin-media → plugin-telephony-twilio edge.
- Keep sequencing, backpressure, idle timers, /health and epoch and generation fencing.
- Replace websocket-peer.ts with ws 8.21.3 (noServer true, maxPayload 1 MiB, perMessageDeflate false) for both the carrier-facing server and the gateway→worker client. The dependency is already declared.
- Pre-accept (#2):
  - buffer by duration and bytes: preAcceptBufferMs default 3000, measured as payload.length / bytesPerSecond(format), with a byte cap of min(2 × bytesPerSecond × 3, 196608);
  - never drop DTMF, start or played events;
  - config and env OVO_MEDIA_PRE_ACCEPT_MS, with maxPendingFrames and OVO_MEDIA_MAX_PENDING_FRAMES kept as deprecated aliases converted at 20 ms per frame.
- Worker command session.end{reason: 'terminate'} → send the serializer's terminate?() frames, then close the carrier socket. This is how close-stream carriers are ended (section 4.10).
- Drain on SIGTERM:
  - stop accepting upgrades and make /health return 503;
  - keep existing carrier sockets until they end or until OVO_MEDIA_DRAIN_TIMEOUT_MS passes (default: deregistration delay minus 30 s), then close them;
  - carriers with a continuation re-enter through /resume on a healthy gateway.

B. Topology (#23)

- For each carrier session, open ws://<route.workerEndpoint> with the header authorization: Bearer <OVO_MEDIA_WORKER_TOKEN>. Send session.open {protocol: 2, carrierId, bindingId, carrierCallId, streamId, format, playbackEvidence, clearFlushesMarkers, routeToken, ownerEpoch, generation}, then wait for session.accept or session.reject.
- Protocol v2 (protocol.ts):
  - gateway→worker: media.audio, media.played{name, evidence}, media.cleared, media.dtmf, call.answered-by{value}, session.close{reason};
  - worker→gateway: audio, mark, clear, session.end{reason}.
  - Accept the v1 names callSid and streamSid as aliases for one release.
- Delete packages/plugin-media/src/worker-client.ts, the persistent worker→gateway socket, and its 'drain on disconnect' behavior.
- New apps/worker/src/worker-media-server.ts:
  - attaches a ws upgrade handler for path /internal/media to the EXISTING worker health server on port 4100, which F4 passes into createProductionWorkerMediaRuntime({httpServer}). route.workerEndpoint is already ws://<ip>:4100/internal/media. Do NOT open another port and do NOT edit main.ts or worker-health.ts; O1 owns them.
  - checks the bearer token, then that sha256(routeToken) equals the route's handshake_token_hash with handshake_claimed_at set, and that sessionId, ownerEpoch and generation match the worker's active claimed route;
  - accepts BEFORE the STT connects; the engine ring-buffers audio.
- worker-media-bootstrap.ts: keep F4's exported signature exactly ({httpServer, ...} → {start, close, closeSession, terminate}). start() attaches the handler, terminate(sessionId, reason: EndReason) sends session.end{reason}, and onDisconnect no longer exists.
- apps/worker/src/media-runtime.ts implements MediaDuplex over the link, with rebind(newLink) for resume at generation+1: the engine keeps running and the socket is swapped. session-handshake.ts is updated to match (keep F4's TTL formula).
- Continuation: host.resumeStream (implemented in session-host by F3) already re-issues only for live, owned, connected routes. Your router passes resume requests through and rebinds on the worker side.

C. apps/media-gateway

- main.ts:
  - load distribution with role 'gateway'. profiles/gateway.ts (yours) owns the gateway infra rows: orchestration read and grant access, operations, secrets, and ovo.net via plugin-kit createNodeNet;
  - build CarrierHostPorts with session-host createCarrierHostPorts plus the operations and orchestration ports;
  - start the router;
  - remove TWILIO_* handling (env bindings come from distribution).
- New apps/media-gateway/src/inbound-admission.ts: the carrier-neutral admission state machine (reserve → wait → callback → human), extracted from inbound-webhook.ts. It returns the contracts InboundDecision via plugin-operations inboundDecisionFor(), which F3 added and O2 keeps stable; do not modify plugin-operations. Delete inbound-webhook.ts, since TwiML now lives in the Twilio plugin.
- inbound-status.ts and campaignAttemptStatus: never map 'completed' to succeeded when answeredBy is 'machine' or no session ever opened (#26).
- Rewrite apps/media-gateway/tests/inbound-webhook.test.ts as inbound-admission.test.ts, carrier-neutral.

D. Recordings format widening

- packages/plugin-recordings/src/capture.ts (301 canonical lines; split into capture-*.ts first) and wav.ts accept an AudioFormat (μ-law 8k, PCM16 8k and 16k) instead of a hard-coded μ-law 8k. The WAV encoder writes the correct headers per format.
- Keep the attachEvidence API that F4's worker recording-evidence shim uses.
- Recording stays gated by release.config.recording (HANDOFF).

E. Tests

- Rewrite packages/plugin-media/tests/gateway.integration.test.ts (430 lines) into files under 500 lines each, using the @winsendotai/ovo-conformance/drivers fixtureCarrierIngress and the raw RFC 6455 client. Cover:
  - routing by carrier and binding, and the legacy aliases;
  - externalUrl verbatim (no query; explicit port kept) and UpgradeRequest.url with its query;
  - fragmented frames and an interleaved ping mid-message; oversized fragments rejected;
  - 3 s pre-accept buffering, with DTMF never dropped;
  - a start refused for a terminating route;
  - the carrier-call-id alias rule;
  - the gateway dialing the worker endpoint on the health server's port, and a wrong token, hash or epoch rejected;
  - two gateway instances routing to one worker;
  - resume rebinds without restarting the engine;
  - session.end terminate closes the carrier socket after the terminate frames;
  - drain keeps sockets until the deadline;
  - a campaign attempt with a machine or no session is not succeeded.
- Update apps/worker/tests/media-runtime.test.ts. Keep lifecycle.integration.test.ts compiling and updated for the new topology (it is Postgres-gated and skipped here).

WAVE-2 RULES:

- You own only the paths listed; doc section 15.2 is frozen, including session-host, distribution (except profiles/gateway.ts), apps/worker/src/main.ts and worker-health.ts (O1), and every package.json.
- Do NOT run pnpm install.
- Contract gaps: use a local adapter and list it.
- Transitional violations go in scripts/baselines/pending/C2.json.
- Done = scoped lint, typecheck and tests green.

CONSTRAINTS:

- plugin-media may import contracts, runtime, sdk, plugin-kit, audio and ws, and the orchestration types re-exported from contracts. It must NOT import any carrier package.
- Preserve the HANDOFF rule that ownership loss drains and terminates the carrier leg, plus route-token and epoch fencing.
- Modules ≤300 lines.
- No live calls. No git commits.

## Acceptance

- plugin-media and apps/media-gateway contain no carrier-specific code or imports: the provider-names and architecture entries go stale, and the plugin-media → telephony-twilio edge is gone. Routes come from ctx.all('ovo.carrier.ingress').
- WebSockets use the ws library and accept fragmented frames and interleaved control frames (fixture test).
- The pre-accept buffer holds 3 s by duration and byte budget and never drops DTMF (#2).
- The gateway dials route.workerEndpoint per session. The worker's upgrade handler rides on the existing port-4100 health server and validates the bearer token, the route-token hash and the epoch. WorkerGatewayClient is deleted, and two gateways can serve one worker (#23).
- A start for a terminating route is refused before audio. The carrier-call-id alias rule is enforced. session.end terminate closes the carrier stream. Drain keeps sockets until the deadline. Resume rebinds without restarting the engine.
- Inbound admission is carrier-neutral via inboundDecisionFor (inbound-webhook.ts deleted), and a machine or no-session campaign attempt is not succeeded.
- Recording capture supports PCM16 and μ-law formats and still honours release.config.recording. Scoped lint, typecheck and tests are green.

## Verify commands

- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && node scripts/lint.mjs --only packages/plugin-media apps/media-gateway apps/worker/src/media-runtime.ts apps/worker/src/session-handshake.ts apps/worker/src/worker-media-bootstrap.ts apps/worker/src/worker-media-server.ts packages/plugin-recordings/src/capture.ts packages/plugin-recordings/src/wav.ts packages/distribution/src/profiles/gateway.ts`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && node scripts/typecheck-scope.mjs packages/plugin-media apps/media-gateway apps/worker/src/media-runtime.ts apps/worker/src/session-handshake.ts apps/worker/src/worker-media-bootstrap.ts apps/worker/src/worker-media-server.ts apps/worker/tests/media-runtime.test.ts apps/worker/tests/lifecycle.integration.test.ts packages/plugin-recordings packages/distribution/src/profiles/gateway.ts`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm exec vitest run packages/plugin-media apps/media-gateway apps/worker/tests/media-runtime.test.ts packages/plugin-recordings --reporter=dot`
