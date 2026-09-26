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

### Checker note — 2026-09-26

The gateway needs storage and secrets definitions to compose its host ports, but its frozen package manifest does not declare those packages and the distribution catalog loads them only for API and worker roles. C2 therefore loads the existing `FIRST_PARTY` definitions through the gateway's declared distribution dependency and fails explicitly if either is absent. This keeps the single registration list and avoids an undeclared gateway import. The gateway startup test exercises both definitions through the real composition.

The checker previously authorized C2 to remove plugin-media's obsolete telephony-twilio manifest dependency and update `pnpm-lock.yaml` together; no plugin-media source imports that package. The same authorization permits narrowly scoped PCM16 capture changes in `packages/plugin-recordings/src/live-service.ts` and `packages/plugin-recordings/src/types.ts`, in addition to C2's owned capture and WAV paths. I1 inherits the legacy dependency removal and the recording package's touched types; O1 inherits the stale worker-loop gateway URL and disconnect arguments until its owned startup path is updated.

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

Run from the current C2 worktree with `export PATH=/opt/homebrew/opt/node@22/bin:$PATH`.

- `node scripts/lint.mjs --only packages/plugin-media apps/media-gateway apps/worker/src/media-runtime.ts apps/worker/src/session-handshake.ts apps/worker/src/worker-media-bootstrap.ts apps/worker/src/worker-media-server.ts apps/worker/tests/media-runtime.test.ts apps/worker/tests/lifecycle.integration.test.ts apps/worker/tests/input-enabled-session-lifecycle.test.ts apps/worker/tests/production-session-lifecycle.test.ts apps/worker/tests/real-gateway-first-call.test.ts apps/worker/tests/carrier-neutral-gateway.test.ts packages/plugin-recordings packages/distribution/src/profiles/gateway.ts` **paired with** `pnpm format:check`.
- `node scripts/typecheck-scope.mjs packages/plugin-media apps/media-gateway apps/worker/src/media-runtime.ts apps/worker/src/session-handshake.ts apps/worker/src/worker-media-bootstrap.ts apps/worker/src/worker-media-server.ts apps/worker/tests/media-runtime.test.ts apps/worker/tests/lifecycle.integration.test.ts apps/worker/tests/input-enabled-session-lifecycle.test.ts apps/worker/tests/production-session-lifecycle.test.ts apps/worker/tests/real-gateway-first-call.test.ts apps/worker/tests/carrier-neutral-gateway.test.ts packages/plugin-recordings packages/distribution/src/profiles/gateway.ts`; final whole-repository validation uses `pnpm typecheck`.
- `pnpm exec vitest run packages/plugin-media apps/media-gateway apps/worker/tests/media-runtime.test.ts apps/worker/tests/lifecycle.integration.test.ts apps/worker/tests/input-enabled-session-lifecycle.test.ts apps/worker/tests/production-session-lifecycle.test.ts apps/worker/tests/real-gateway-first-call.test.ts apps/worker/tests/carrier-neutral-gateway.test.ts packages/plugin-recordings --reporter=dot`.
- For the same scope against the disposable loopback database, prefix
  `OVO_TEST_POSTGRES_URL=<disposable-loopback-db>` and add `--no-file-parallelism`.
- Full bar: `pnpm lint`, `pnpm format:check`, `node scripts/check-duplication.mjs`,
  `pnpm typecheck`, `pnpm test`, `pnpm build`, and
  `OVO_TEST_POSTGRES_URL=<disposable-loopback-db> pnpm exec vitest run --no-file-parallelism --reporter=dot`.
- Recording database gate: `RECORDING_TEST_DATABASE_URL=<disposable-loopback-db> pnpm exec vitest run packages/plugin-recordings/tests/postgres-recordings.test.ts --no-file-parallelism --reporter=dot`.

## Builder review note — 2026-09-26: real callback and empty-frame closure paths

The URL-secret adapter now passes the serializer's authenticated request identity
as the host verifier's `r` field in memory, without adding a wire query parameter.
This fixes the documented Exotel `sid/rt/t` upgrade: the real host HMAC verifier
previously refused the valid token with `Unexpected server response: 401`.
Wrong session, binding, token and a conflicting supplied `r` remain refused. The
regression drives the production CarrierRouter over loopback WebSockets.

HTTP `CarrierHttpRequest.externalUrl` now retains the complete raw query string.
The spec's query-free `externalUrl` rule applies to **UpgradeRequest**; Twilio's
HTTP callback signature covers the full callback URL, including `r` and `t`.
Neither decoded query reconstruction nor proxy headers are used. The production
HTTP router test failed before this correction because its actual URL lacked
`?sid=A&t=T&raw=%2f+%20`. Independent C1 review reproduced the consequence with the
real Twilio status handler: stripped URL → 403, complete URL → 204 and one applied
event. WSS continues to expose both the exact bare `externalUrl` and the separate
full `url` as before.

`packages/plugin-media/tests/empty-termination.test.ts` drives the real
SessionBridge with a real loopback WebSocket and a close-stream serializer whose
`flush()` and `terminate()` return `[]`. The carrier receives no frames and closes
with code 1000 and `worker ended session: terminate`. Removing the production
close call fails with `expected 1 to be 3` (OPEN versus CLOSED). The production
closure logic already handled this case; this is regression proof, not a new
runtime fix. C3's checker-approved kit exception retains the requirement to close
the actual stream and only removes its nonempty termination-array requirement.

### Checkpoint measurements — 2026-09-26

This is an **In progress** checkpoint, not a green handover. All commands used Node 22.

- The exact scoped Vitest command above: **90 passed / 16 skipped**, exit 0.
- The same scope plus `apps/worker/tests/lifecycle.integration.test.ts`, with
  `OVO_TEST_POSTGRES_URL` pointing at our disposable loopback `postgres:17.6` and
  `--no-file-parallelism`: **103 passed / 4 skipped**, exit 0. The four remaining
  scoped skips require `RECORDING_TEST_DATABASE_URL`, not the standard Postgres variable.
- `pnpm exec vitest run --reporter=dot`: **1,188 passed / 143 skipped / 3 failed**, exit 1.
- `OVO_TEST_POSTGRES_URL=<disposable-loopback-db> pnpm exec vitest run --no-file-parallelism --reporter=dot`:
  **1,323 passed / 8 skipped / 3 failed**, exit 1. Both full runs total **1,334**;
  the additional 135 default skips are database-gated. Our container was removed afterward.
- `pnpm build`: exit 0 (three application bundles and production console build).
- The exact scoped lint command above: **EXIT 0** (7 gates); `pnpm format:check`:
  **EXIT 0**; `node scripts/check-duplication.mjs`: **EXIT 0** (764 source files,
  56 existing baseline pairs). No baseline changes were made in this checkpoint.
- Separately, `RECORDING_TEST_DATABASE_URL=<disposable-loopback-db> pnpm exec vitest
run packages/plugin-recordings/tests/postgres-recordings.test.ts --no-file-parallelism --reporter=dot`:
  **4 passed / 0 skipped / 0 failed**, exit 0. This used another disposable
  `postgres:17.6` container, removed after completion; it is additional evidence,
  not four tests added to the full-suite counts above.
- `node scripts/typecheck-scope.mjs packages/plugin-media`: exit 1; the 28 diagnostics
  are the missing `@types/ws` declarations and the consequent implicit-any errors.

The three full-suite failures are the pre-C2 harnesses
`apps/worker/tests/input-enabled-session-lifecycle.test.ts`,
`apps/worker/tests/production-session-lifecycle.test.ts`, and
`apps/worker/tests/real-gateway-first-call.test.ts`. The first two invoke the replaced
private open shape without a durable route (`undefined.sessionId`); the last passes
the replaced gateway options without ingresses (`options.ingresses is not iterable`).
Their narrow shared-file rewrite remains requested, together with the manifest/lock
exception for `@types/ws`. No compatibility bypass was added to production.

The owned Postgres resume fixture now signs the complete raw HTTP callback URL,
including `r` and `t`. The first serial run exposed its old query-stripping signature
as HTTP 401; the corrected fixture passes in both the focused and full serial runs.

Independent review of this checkpoint reran the router and empty-termination tests
(11 passed), the Postgres resume lifecycle (1 passed), and malformed/duplicate URL
probes. It found no blocker in the delta. The frozen fixture signer and verifier
each append `request.query` to `externalUrl`; with a full external URL they agree
on a doubled query. Consequently the Postgres test proves resume state and socket
behavior, not vendor signature fidelity. The exact raw router assertion and real
C1 Twilio handler proof establish the latter. I1 must correct that frozen fixture
helper and its consumers together.

## Checker note — 2026-09-26: approved Batch A shared files

The original owned list excludes three worker lifecycle harnesses and every manifest,
although C2 replaces the entry points those harnesses exercise. The checker explicitly
authorized the minimum `@types/ws` development dependency in
`packages/plugin-media/package.json` and its matching `pnpm-lock.yaml` importer, plus
`apps/worker/tests/input-enabled-session-lifecycle.test.ts`,
`apps/worker/tests/production-session-lifecycle.test.ts`,
`apps/worker/tests/real-gateway-first-call.test.ts` and a new production regression.
The declaration version was already locked; no dependency version or unrelated importer
changed. The worktree's dependency store and workspace links are local (zero links
resolving into the foundation worktree), and the frozen offline install succeeds.

The two lifecycle harnesses now open the authenticated `/internal/media` transport and
retain their engine, STT, fencing, telemetry, completion and recording-disabled assertions.
The first-call harness now uses an installed fixture ingress with a non-Twilio carrier
identity, the actual health-server socket and delayed native engine composition. Its
injected SQL fixture is transport evidence only. The new
`apps/worker/tests/carrier-neutral-gateway.test.ts` separately uses real Postgres jobs,
worker slots, route-token claims and `media.opened` rows through MediaGateway and
WorkerMediaRuntime, with a deliberately small echo engine. These are complementary
proofs, not vendor protocol certification.

Worker code imports the identical `ws` constructor through a typed re-export in the
owned plugin-media root index. This local adapter uses the worker's existing declared
plugin-media dependency; it adds no worker manifest dependency, export-map change or
TypeScript alias. I1 inherits this adapter and the shared harnesses; D1 inherits the
worker production-lifecycle coverage. No persisted-value format changed in this round.

### Independent review repairs and true negatives

- Before admission, a bearer-authenticated oversized WebSocket frame crashed Node with
  `Unhandled 'error' event`, `RangeError: Max payload size exceeded` and
  `WS_ERR_UNSUPPORTED_MESSAGE_LENGTH`. The subprocess regression now observes a clean
  close with code 1009 and zero admission calls. An immediate peer error listener handles
  this path; a guarded WorkerMediaLink listener finalizes an active failed link once.
  The active real-socket test failed before the link listener with `Number of calls: 0`
  for route finalization. A superseded peer's error cannot finish the replacement link,
  and the real Postgres case verifies a malformed second peer leaves the live route alone.
- The actual inbound fixture handler authenticated binding A while the route selected B;
  the old host admitted it and returned 200/Connect. A NULL route with a different configured
  environment carrier had the same failure. Both regressions failed with
  `promise resolved "{ status: 200, …(2) }" instead of rejecting`. The host now rejects
  either identity mismatch before admission. A matching authenticated binding still admits;
  the existing Postgres missing/uninstalled/unavailable configuration refusal tests remain.
  The existing current-route validation read and operations' pinned wait state were not redesigned.
- An explicit `session.close` received after acceptance but during pending engine startup
  used to queue behind startup. The production socket regression failed with
  `expected "vi.fn()" to be called once, but got 0 times`. It now finalizes immediately,
  never records `media.opened`, and disposes a late returned engine once. Plain transport
  disconnects retain the existing resume window.
- The actual Postgres non-Twilio regression fails if the handshake comparison is changed
  back to a Twilio literal: `expected "vi.fn()" to be called once, but got 0 times`.
  Removing `recordSessionOpened` fails with `expected [] to deeply equal
[ { status: 'session_opened' } ]`. Both source mutants were restored immediately.
  These behavioral negatives supplement the three obsolete harness failures
  (`undefined.sessionId` twice and `options.ingresses is not iterable`), which alone
  would not prove production correctness.

The four worker-link scenarios were mechanically moved from the oversized owned
`apps/worker/tests/media-runtime.test.ts` into
`packages/plugin-media/tests/worker-media-runtime-link.test.ts`. Titles and assertions
are retained; the exact scoped commands above include both files. No baseline changed.

### Final Batch A measurements — 2026-09-26

All commands below used Node 22.23.2, the normal repository configuration and local
workspace dependencies. No aliases, baseline edits, live flags or carrier/provider calls
were used.

| Command                                                                                                    | Result                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile --offline`                                                                 | EXIT 0; only the approved plugin-media importer differs in the lockfile                                                                      |
| Exact scoped lint command in Verify commands, paired with `pnpm format:check`                              | EXIT 0 / EXIT 0                                                                                                                              |
| `node scripts/check-duplication.mjs`                                                                       | EXIT 0; no baseline changes                                                                                                                  |
| `pnpm check`                                                                                               | EXIT 0: all seven lint gates, full formatting, full typecheck, full tests, three app bundles, console production build, audit and Playwright |
| Full Vitest within `pnpm check` (`pnpm test`)                                                              | **1,319 passed / 144 skipped / 0 failed**                                                                                                    |
| `OVO_TEST_POSTGRES_URL=<disposable-loopback-db> pnpm exec vitest run --no-file-parallelism --reporter=dot` | **1,455 passed / 8 skipped / 0 failed**, EXIT 0                                                                                              |
| Exact scoped Vitest command in Verify commands                                                             | **99 passed / 18 skipped / 0 failed**, EXIT 0                                                                                                |
| Same scoped command with `OVO_TEST_POSTGRES_URL` and `--no-file-parallelism`                               | **113 passed / 4 skipped / 0 failed**, EXIT 0                                                                                                |
| Dedicated recording database command in Verify commands                                                    | **4 passed / 0 skipped / 0 failed**, EXIT 0                                                                                                  |
| Playwright within `pnpm check`                                                                             | **41 passed / 1 skipped**; the skip is the desktop-hidden mobile menu                                                                        |

Skip arithmetic: **1,319 + 144 = 1,455 + 8 = 1,463**. The extra 136 default
skips are database-gated tests, not disabled tests. The scoped totals are likewise
**99 + 18 = 113 + 4 = 117**; the four remaining scoped skips use the separate recording
database variable and passed in the dedicated run. That dedicated run is additional
evidence and is not added to the full-suite counts.

The complete Postgres run preceded the final mechanical lifecycle-fixture extraction;
the exact scoped Postgres run above passed afterward. The final `pnpm check` ran after
that extraction. The large lifecycle scenario now reuses the existing raw WebSocket
fixture, with generic queue/protection fixtures extracted into plugin-media's owned tests.
All assertions remain. Both worker test files now meet the 500 canonical-line gate.

Independent review reproduced the three owned blockers before repair, then ran
inbound-binding, worker-errors, worker-upgrade, carrier-neutral-gateway and media-runtime:
**27 passed / 1 Postgres-gated skip**, EXIT 0. This was before the mechanical split of
four link scenarios; a current reproducer adds
`packages/plugin-media/tests/worker-media-runtime-link.test.ts` to that same list.
The independent source review found no remaining blocker in those deltas.

C4's foundation Twilio-only gateway expectation is discharged by the non-Twilio
production gateway tests and the actual Postgres test described above. I1 inherits
these regressions. The production fix does not depend on a carrier-specific exception.
The disposable `ovo-pg-c2-builder` container was removed after these checks.

### Final-commit Postgres confirmation — 2026-09-26

The full Postgres serial suite was rerun on the clean, exact final code commit
`45c410adc80498cbb0d1f2c9ae4995e339331177`, after the mechanical fixture extraction:

```sh
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
OVO_TEST_POSTGRES_URL=postgres://postgres:ovo@127.0.0.1:32900/ovo pnpm exec vitest run --no-file-parallelism --reporter=dot --reporter=json --outputFile=/tmp/c2-45c410a-postgres.json
```

**EXIT 0: 1,455 passed / 8 skipped / 0 failed; 1,463 total.** Console output was
captured in `/tmp/c2-45c410a-postgres.log`; the JSON report confirms every skip:
one API ledger test requires `LEDGER_TEST_DATABASE_URL`, four recording tests
require `RECORDING_TEST_DATABASE_URL`, and three restore-drill tests require
`OVO_BACKUP_DRILL_POSTGRES_URL`. All eight are database-gated; none is disabled.
The own disposable `postgres:17.6` container `ovo-pg-c2-final` was removed afterward.

The eight paused heads were checked before and after the run and are unchanged:
C1 `382d690`, C3 `eaeb03f`, C4 `45ef2df`, E3 `e4e821d`, M1 `dc9f471`,
O1 `1e49894`, O2 `cd77047`, S2 `00c80ec`. This follow-up changes documentation only.
