# Status fields the go-live scripts read

Every OVO status response names its progress `state`. Scripts written on 2026-10-07 read `status`
and got `undefined`; this page is the reference for the responses go-live polls.

## `GET /v1/agents/:agentId/releases/:releaseId/speech-clips`

Pre-render progress of a release's fixed lines (TTS-9). Defined by `SpeechClipStatus` in
`apps/api/src/speech-prerender.ts`; a test pins the field set.

| Field             | Meaning                                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| `state`           | `queued`, `running`, `done`, `failed` or `skipped` (the pre-render job); `disabled`, `unavailable` or `not-requested` |
| `total`           | Fixed lines in the release's inventory, on the speaker's post-filter text                                             |
| `ready`           | Fixed lines whose clip is stored                                                                                      |
| `failed`          | Fixed lines whose render failed after retries                                                                         |
| `pending`         | `total - ready - failed`                                                                                              |
| `perCall`         | Templated lines, rendered per call and never stored                                                                   |
| `inventorySha256` | Identifies the rendered inventory; changes when any fixed line's text changes                                         |
| `detail`          | The worker's note on a failed or skipped job                                                                          |
| `requestedAt`     | When the publish queued the job                                                                                       |
| `finishedAt`      | When a worker finished it                                                                                             |

There is no `status` field. Pre-render is complete at `state: "done"` with `pending: 0`. Workers
pre-render while `OVO_LIVE_DIAL_ENABLED=false` too (publish jobs and routed releases), so the clips
are ready before go-live; dialing stays off.

## `GET /v1/cost/price-catalog`

Each item carries its import state in this ledger as `state`: `not_imported`, `imported` or
`update_available` (then `storedVersion` names the newest stored version). `status` carries the
same value for clients written against it.

## `GET /v1/calls/:callId/cost`

`callId`, `sessionIds` (the worker's media sessions that metered the call; usage is keyed by them,
not by the call id), `currency` (`INR`), `estimatedPaise`, `reconciledPaise`, `totalPaise`,
`provisional` and `provisionalPriceCards`. Estimated charges are added at their exact value and
rounded to paise once for the whole call.

## `GET /v1/agents/:agentId/readiness`

`liveReady` is false whenever live cost admission would refuse the call: a referenced price-card
version the ledger does not hold (`Cost price version is unavailable: …`), a non-INR card without
an FX version (`Cost meter requires immutable FX: …`), an FX version that is missing or converts
another currency, a half-set or INR-with-FX reference, a selected meter without a price reference,
or a card priced for another model than the binding runs (`price_unknown_for_model: …`). Each
blocker starts with the refusal the worker logs.

## Recordings

A call recording is written only when the agent sets `recording: true` (default `false`). The
2026-10-07 CreditMantri calls had no recording artifact because their agent config set
`recording: false` (by design: `apps/worker/tests/session-recording.test.ts` pins that a release
without recording creates no artifact). Set it and re-release to record; on compose the worker's
recording backend is `OVO_RECORDINGS_BACKEND=filesystem`.
