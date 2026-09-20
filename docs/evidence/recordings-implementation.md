# Recording archive evidence

Date: 2026-09-20. Status: verified local files; AWS/carrier paths unverified.

## Implemented

- Ordinary Cordis recording-storage plugin, with local filesystem and real AWS S3 SDK backends.
- WAV envelope validation, actual format/sample-rate/channel checks, bounded 5 MiB payloads and computed duration.
- Workspace/call-scoped random identifiers, SHA-256 integrity, immutable source labels (`fixture` or `carrier`) and access-expiry metadata.
- Authenticated management routes and console playback use stored bytes; synthetic fixtures never become real-call evidence.
- Explicit deletion and expired-read denial. Access expiry is **not** proof of physical deletion. Production lifecycle/sweeper and legal retention verification remain open.
- Local storage refuses production mode. The S3 adapter uses server-side encryption and task credentials, not frontend AWS secrets.

## Local tests

`pnpm exec vitest run packages/plugin-recordings` passes four tests:

1. Parse actual PCM WAV data and reject truncation/inconsistent format.
2. Reopen filesystem storage and verify bytes, provenance and workspace isolation.
3. Detect corruption, deny expired access, and perform repeat-safe deletion.
4. Compose and dispose the archive as an ordinary plugin.

Audio in these tests is generated silence, not a human call. S3 bucket permissions, multi-task ingestion, crash/power-loss durability, legal retention, live carrier capture, transcript alignment and operator playback review are not certified by these tests.
