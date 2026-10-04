# C4 checker notes — 2026-09-26

## Rebased implementation checkpoint — 2026-09-28

C1 and C2 are now on the foundation under C4. The old Twilio-only gateway
default failure below is historical: the baseline C4 default suite passes.
The C2 raw-query adapter also landed, so V3 verification receives the
externally requested HTTPS URL including query and port.

The [Plivo PHP V3 reference](https://github.com/plivo/plivo-php/blob/master/src/Plivo/Util/v3SignatureValidation.php)
sorts query keys, repeated values and POST fields with `SORT_NATURAL`.
Lexical sorting in the restored WIP failed three independent numeric-key
HMAC checks, including the production HTTP verifier. The repaired signer
passes GET, POST, repeated-query, port and case-sensitive field vectors;
path, body, method, token and missing-header negatives fail closed. Removing
the WSS query guard accepts a valid no-query signature on `?edge=outside`;
the regression now rejects it. No Plivo SDK was installed or contacted.

The selected ingress now supplies a per-call Plivo frame encoder for D1
fixture replay. The production distribution test round-trips its frames
through the real Plivo serializer. A separate C4-owned synthetic alternate
carrier drives C2's `queryOnMediaUrl: true` branch through the production
gateway adapter; native Plivo stays `false`. The checker approved the reduced
reconciliation and transfer capabilities on 2026-09-29.

- **Reconciliation:** C4's spec calls `GET /Call/{request_uuid}/?status=queued` and `reconcile: 'by-request-id'`. [Plivo's Calls API](https://www.plivo.com/docs/voice/api/calls) documents `GET /Call/?status=queued` as a list of call UUIDs, `GET /Call/{call_uuid}/?status=live` for a live call, and `GET /Call/{call_uuid}/` for a CDR. It documents no request UUID lookup. C4 therefore advertises `by-call-id`, returns pending without a callback-provided CallUUID, and performs live then CDR lookup by CallUUID. CDR outcome uses `hangup_cause_name`; `call_state` is explicitly legacy. The checker approved this reduced capability on 2026-09-29. C2 preserves callback correlation; I1 owns the final integration.
- **Handoff:** C4 requires phone, resume, and end; [Plivo transfer](https://www.plivo.com/docs/voice/api/calls) requires a URL that serves transfer XML as `aleg_url`, while `TelephonyControl.handoff` supplies only the target and request id. C4 advertises and implements end; phone and resume reject without a network call. The checker approved end-only on 2026-09-29. A host-owned transfer URL seam would need a separate shared-contract decision, owned by F1/C2. Never construct a callback secret or transfer XML URL in this plugin.
- **Webhook V3:** The design describes URL + nonce, while [Plivo's official PHP SDK](https://github.com/plivo/plivo-php/blob/master/src/Plivo/Util/v3SignatureValidation.php) signs the SDK-constructed URL, a dot, and nonce. It also has POST query and body canonicalization. Independent golden fixtures follow the SDK. The host must pass the exact external URL, including query and port; a reconstructed URL fails closed. C2 now preserves the raw HTTP query in its owned gateway adapter; that fix must land before C4 integration. WSS still uses its separate no-query signature URL.
- **`extraHeaders`:** The [Stream XML reference](https://www.plivo.com/docs/voice/xml/audio-streaming) shows comma-separated pairs, while the [streaming guide](https://www.plivo.com/docs/voice-agents/audio-streaming/concepts/audio-streaming-guide) uses semicolons. C4 emits commas as directed by the spec's XML source and accepts either delimiter on received start frames.
- **Manifest (corrected 2026-09-26):** Design §15.2 freezes manifests outside a unit's owned paths. C4 owns `packages/plugin-carrier-plivo/**`, so removing its own `ovo.skeleton` flag is authorized by the spec and needs no shared exception. The flag is now removed; dependency and lockfile contents are unchanged.
- **Gateway integration:** With Plivo's control present, the distribution has two carrier controls. The gateway deliberately selects no environment carrier when no binding names one. The foundation's `apps/media-gateway/tests/inbound-carrier-installation.test.ts` still expects Twilio as the sole default; C2 owns that test and has already updated the expectation on its active branch. C4 leaves it untouched and will recheck after C2 merges.

## Builder review — 2026-09-26

The independent review found two owned defects and reproduced both before repair.

- Stream markup used the real host grant's call-status URL for Stream events.
  The new `stream-status.test.ts` follows the URL rendered from a real host grant
  into the signed production handler for answer, inbound and resume. Before the
  route enrichment all three failed with `Stream callback routed to status: expected
400 to be 204`; after it, all three pass. The plugin asks the host for a signed
  `stream-status` callback URL and preserves every other grant field.
- The serializer discarded stream identity before normalization. After starting
  stream-A it accepted stream-B audio, DTMF, playback receipts, clear and stop
  events. `stream-identity.test.ts` first accepts a matching frame, then rejects
  mismatched/missing IDs; its five identity cases failed against the old source
  with `expected [Function] to throw an error`. Six additional cases exposed
  outbound, invalid and missing media/DTMF tracks with the same assertion.
  All eleven now pass. Runtime errors identify `Plivo frame streamId does not match
the established stream`, `Plivo media track must be inbound`, or `Plivo DTMF track
must be inbound`. The checks run before any normalized event can escape.

The real distribution catalog test also passes with this carrier installed. The
independent reviewer reran all package tests (43 passed), scoped typecheck/lint,
owned Prettier and full format:check, all exit 0. The unit remains In progress for
the reconciliation, handoff and nonce decisions above; this is not a green handover.

### Final checkpoint measurements — 2026-09-29

These measurements are on C4's rebased tree with both approval-condition tests.
The earlier 2026-09-26 default failure was resolved when C2 landed beneath C4.

- `node scripts/lint.mjs --only packages/plugin-carrier-plivo apps/worker/tests/f4-carrier-settlement.test.ts`: **EXIT 0**, seven gates. `pnpm lint`: **EXIT 0**, seven gates. `pnpm format:check`: **EXIT 0**. `node scripts/check-duplication.mjs`: **EXIT 0**, 842 source files and 54 existing baseline pairs. No baseline was added.
- `pnpm typecheck`: **EXIT 0**. `pnpm build`: **EXIT 0**, including the application bundles and console production build. `pnpm audit --audit-level moderate`: **EXIT 0**, no known vulnerabilities.
- `pnpm exec vitest run --reporter=dot`: **1,749 passed / 153 skipped / 0 failed**, **EXIT 0**. `OVO_TEST_POSTGRES_URL=… RECORDING_TEST_DATABASE_URL=… pnpm exec vitest run --no-file-parallelism --reporter=dot` against a disposable loopback `postgres:17.6`: **1,898 passed / 4 skipped / 0 failed**, **EXIT 0**. Both runs total **1,902** cases; the extra default-run skips are database-gated. The owned container was removed.
- `pnpm test:console:e2e`: **41 passed / 1 skipped**, **EXIT 0**. The skip is the desktop-only mobile-menu visibility case.
- Removing the Plivo missing-UUID guard changes the new test's result to `accepted` and fails its `unknown` value assertion. Bypassing the worker's no-correlation live-result guard makes its new settlement test reject with `Carrier accepted without a correlation id` instead of resolving to `reconcile_required`. Both broken-source runs exited 1; source was restored before the green bar.

## Carry-forwards

| Owner | Item                                                                                                                                                                                                                                                      |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C2    | Preserve the final externally requested URL through carrier HTTP ingress and verify it before C4 V3; do not remove or reorder query pairs.                                                                                                                |
| F1/C2 | Decide and expose a host-owned `aleg_url` for phone/resume transfer if those handoffs remain required.                                                                                                                                                    |
| C2    | Keep request UUID to CallUUID correlation via answer/status callbacks; the documented Plivo API has no direct request UUID lookup.                                                                                                                        |
| I1    | Sandbox-confirm the WSS upgrade signature scheme, checkpoint behavior after clearAudio, inbound frame size, and Plivo's request cancellation response; nonce freshness requires a replay mechanism because the V3 nonce contains no documented timestamp. |
