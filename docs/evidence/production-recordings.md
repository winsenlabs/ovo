# Production recordings and exports evidence

Date: 2026-09-20. Scope: W17 engineering in `packages/plugin-recordings`. Status: local filesystem and disposable PostgreSQL verified; S3-compatible staging, long-call soak, and legal-retention certification remain external gates.

## Implemented production profile

### Live capture and alignment

- `LiveRecordingCapture` decorates the normalized 8 kHz G.711 mu-law media transport used by the voice session. It subscribes to inbound media, intercepts successfully sent outbound audio and playback marks, and subscribes to the existing speech-evidence stream either at startup or through `attachEvidence` after the session graph creates its scheduler.
- `createRecordingCapturePlugin(...)` is a session-scoped integration plugin. It requires `ovo.recordings-live` and provides the decorated `ovo.media.duplex` plus `ovo.recording-session`; the voice engine must consume this decorated media service rather than a second undecorated media plugin.
- Inbound timestamps retain provider media timestamps. Outbound timestamps are captured only after the worker media send resolves and are labeled `worker-send-resolved`.
- Carrier mark callbacks are labeled `carrier-mark-confirmed-not-human-heard`. They prove carrier playback progress/mark confirmation, not that a person heard or understood the audio.
- Queue bytes, individual media segments, timeline entries, and database result pages are bounded. Queue overflow stops capture and leaves a durable `partial` artifact rather than silently dropping bytes while claiming availability.

### Segments, manifests, and object integrity

- Production calls are not accumulated into the legacy 5 MiB fixture WAV buffer. Each inbound/outbound track is split into bounded objects (64 KiB–8 MiB; default 5 MiB) with sequence, timeline range, timestamp evidence, byte length, and SHA-256 metadata.
- Object upload completes before a segment becomes `available`. A failed upload produces a durable failed segment record and the recording becomes `partial`; it never becomes falsely available.
- Object keys include a random component so a duplicate/replayed sequence cannot overwrite and then delete an already indexed object.
- Reads verify recorded byte length and SHA-256. The filesystem and S3-compatible adapters bound both writes and reads.
- Final states distinguish `available`, `partial`, `failed`, and `expired`. Previously completed segments remain inspectable in a partial manifest.

### Durable PostgreSQL metadata

`PostgresRecordingRepository` owns versioned, checksum-verified, advisory-locked `ovo_recording_*` migrations for:

- artifacts;
- independently indexed inbound/outbound segments;
- timestamp-evidence timeline rows;
- durable tombstones and physical cleanup attempts; and
- asynchronous export jobs with idempotency keys, lease owner/epoch, checksums, and output metadata.

Manifest reads hold a PostgreSQL row share lock while reading the segment/timeline snapshot. Segment/timeline inserts also take an artifact share lock and recheck the tombstone after acquiring it; tombstoning takes an update lock. A deletion that has returned therefore cannot race with a later authorized manifest read or late segment metadata insertion.

### Retention and deletion

- `RecordingRetentionService.sweep` uses a `(expiresAt, artifactId)` cursor and a caller-bounded page of at most 100 records.
- Deletion first persists a tombstone and marks the artifact expired in the same database transaction. Reads and exports are denied immediately, including when physical object deletion fails.
- Pending/failed tombstones are durable and retryable. Cleanup records attempt count, bounded error text, and completion time.
- If an object upload finishes after tombstoning won the metadata race and immediate compensating deletion fails, the object key is durably added to `ovo_recording_cleanup_objects` and the tombstone is returned to `pending`; later cleanup cannot silently lose that object.
- Cleanup settlement is fenced by the tombstone attempt generation. Concurrent process workers or a late cleanup-object insertion invalidate stale settlement, so an older cleanup cannot mark a newly pending object complete.
- Cleanup removes segment and derived-export objects. Object deletion is idempotent; failed cleanup never removes the tombstone or restores read access.
- Expiry metadata alone is not claimed as physical deletion. Only a completed tombstone cleanup is physical-removal evidence.

### Redacted asynchronous exports and replay safety

- Export requests are idempotent per workspace and caller key.
- Workers claim queued or expired-lease jobs with PostgreSQL `FOR UPDATE SKIP LOCKED`, a lease owner, and a monotonically increasing lease epoch.
- Settlement requires the same owner/epoch and a nonexpired lease. Each attempt uses an epoch-specific object key, so a stale worker cannot delete a newer worker's output.
- PostgreSQL settlement checks lease expiry against `CURRENT_TIMESTAMP`, not a caller-supplied timestamp. Deadline cancellation leaves the job leased for durable reclaim and checks cancellation before object publication and settlement.
- Export reads verify byte length and SHA-256 and recheck access after the object read.
- Baseline email/phone patterns plus bounded operator-configured text patterns are replaced; unplayed agent text is omitted by default; arbitrary source event payloads are not exported.
- Every replay payload is fixed to synthetic transport, stubbed tools, no live connectors, and no production writes. `createSafeReplayBindings()` throws on dial and returns `replay_stubbed` for every tool invocation. The API does not accept a production connector override.

### Self-hosted object storage

- `S3RecordingBackend` uses the AWS SDK against AWS S3 or a fixed operator-provided S3-compatible endpoint such as MinIO. Endpoint, path style, and TLS mode are operator process configuration, not user-controlled request URLs. URL credentials, paths, queries, and fragments are rejected.
- Credentials come from the normal server-side AWS SDK provider chain; browser credentials and per-user object-store URLs are not accepted.
- Production filesystem use requires explicit `durableMounted: true` and `sharedAcrossWorkers: true`. Otherwise the production plugin rejects the configuration and S3-compatible storage is required.
- TLS should remain enabled outside an explicitly protected self-hosted network. No AWS or MinIO network request was made by these tests.

## Integration contract

Process composition imports `createProductionRecordingsPlugin` from `@winsendotai/ovo-plugin-recordings/production`. Its first argument is the strict root configuration `{databaseUrl,backend,bucket?,endpoint?,forcePathStyle?,directory?,durableMounted?,sharedAcrossWorkers?}`; backend-inapplicable and unknown fields are rejected. Its second argument supplies:

- `loadExportInput(recording, {signal})`, where `recording` is immutable metadata resolved by workspace and artifact inside the recording repository before loading. The loader receives the verified `callId`; it never treats an artifact ID as a call ID. The optional signal bounds supervised work.
- Optional `background` bounds may override the safe defaults; absence starts the worker with four export claims per tick, a 60-second lease, a 45-second deadline, and 20-record retention pages.

The process plugin caps its PostgreSQL pool at two connections, registers disposal immediately after allocation, and closes the pool if migration or object-backend construction fails. Its supervised worker starts after all services are provided, never overlaps ticks within the process, automatically runs durable export claims plus retention sweep/cleanup, and reports only bounded error classifications. Shutdown aborts the active tick, drains any detached export-input load, waits for active object compensation, and only then closes the backend and PostgreSQL pool.

The process plugin provides:

- `ovo.recordings-live` (`LiveRecordingService`);
- `ovo.recording-retention` (`RecordingRetentionService`);
- `ovo.recording-exports` (`RecordingExportService`); and
- `ovo.recordings-production` (`ProductionRecordingServices`, containing the repository, all three services, and the supervised worker for status/testing).

For a live session, compose `createRecordingCapturePlugin({media, workspaceId, callId, retentionDays, ...})` in place of the ordinary media provider. It provides the decorated `ovo.media.duplex` expected by the production voice bridge.

`registerRecordingLifecycleRoutes` accepts that service bundle as an optional dependency and returns explicit `503 recordings_unavailable` when it is absent. It preserves the legacy simulation-fixture WAV routes and adds authenticated production endpoints under `/v1/calls/:callId/live-recordings` for:

- lists, sanitized manifests, and authorized raw mu-law segment streaming;
- authorized per-track PCM16 WAV playback at `/audio/:track`, converted sequentially from bounded 8 kHz mu-law segments without a whole-call buffer. It advertises a manifest-derived content length, supports single HTTP byte ranges for browser seeking, propagates disconnect cancellation to filesystem/S3 reads, and labels partial tracks with an explicit gap count and `concatenated-available-segments` timeline semantics;
- explicitly non-waveform-synchronized transcript/timeline alignment;
- editor/admin tombstone deletion with audit;
- idempotent asynchronous export creation, status, authenticated integrity-checked download;
- a safe replay descriptor that requires synthetic transport, stubbed tools, no live connectors, and no production writes; and
- an admin-only bounded retention sweep that accepts no caller-provided clock.

`createRecordingExportInputLoader(store)` loads at most 100 pages of 100 durable call events using the repository-verified recording `callId`, strips arbitrary event payloads from the export, correlates persisted playback completion references, and leaves unplayed agent text excluded by the export policy. Production session integration must persist the actual transcript/playback events required by policy; the loader does not substitute empty fixture inputs.

No public object URL is required. This package intentionally leaves role checks and HTTP response streaming in the existing authenticated API layer.

## Verification

Focused local suite:

- Existing fixture archive/storage compatibility: 4 tests passed.
- Live capture, strict configuration, partial upload, checksum, deletion-failure tombstone (including a late-upload race), physical expiry cleanup, redaction, lease fencing, fixed replay behavior, and MinIO/filesystem policy: 10 tests passed.
- Supervised background processing: 4 tests passed, covering bounded/non-overlapping ticks, safe error reporting/persistence, timeout lease reclaim without late publication, shutdown drain, and aborted output compensation.
- Recording lifecycle API faults and authorization: 6 tests passed, covering explicit unconfigured behavior, bounded export event loading, call ownership, manifests/segments/alignment/replay, round-trip PCM-WAV playback and byte-range seek, honest partial/gap headers, inconsistent-manifest rejection, export redaction/status/download/integrity, roles/audit, tombstone playback revocation, tombstone-first failed deletion, and server-clock-only retention.
- Fresh disposable `postgres:17.6-alpine`: 4 PostgreSQL tests passed, including migrations, persisted manifests, server-clock lease fencing, immediate tombstone denial, export denial, physical cleanup, generation-fenced late-object indexing, bounded process-plugin pooling, and shutdown-before-pool disposal.
- All production TypeScript modules remain below 400 canonical nonblank lines and 24 KiB; the largest is approximately 315 canonical nonblank lines.
- Workspace TypeScript produced no `plugin-recordings` diagnostics. Concurrent unrelated API/operations work still had diagnostics at the time of the focused check.

## Honest external gates

Not certified here:

- AWS S3 or MinIO credentials/IAM/bucket-policy behavior;
- object-lock/legal-hold policy and jurisdiction-specific retention approval;
- long-call, process-crash, disk-full, and network-partition soak tests;
- carrier/provider clock drift or waveform-level inbound/outbound synchronization;
- human-heard or comprehension evidence;
- signed-download/CDN deployment (the intended default is the existing authenticated API stream);
- complete durable customer-transcript and agent-playback event attachment in the production worker export source;
- a live carrier recording or paid provider request.
