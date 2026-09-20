# Remaining verification and certification gates

OVO now contains the single-organization production implementation. This replaces the earlier foundation-only engineering backlog. Implementation is not production certification; `acceptance.json` retains all 75 requirements.

## Implemented local engineering

- All four behavior modes publish through the management API, with deterministic scripts and shared FAQ/tool execution.
- PostgreSQL provides shared asynchronous control storage, immutable release/provider/MCP snapshots, and durable runtime state.
- The media gateway joins Twilio routing, streaming Deepgram STT, OpenAI TTS/inference, playback context, and worker cleanup.
- Campaigns, suppression, inbound protected admission, bounded wait, consent-based callback, and handoff have durable implementations.
- Bounded telemetry, resumable events, latency/cohort queries, and infrastructure inspection connect to the console.
- Production recording capture honors release consent. Playback, export, tombstone retention, and restore safeguards have local implementations.
- Versioned price cards, FX, native usage, cache accounting, required meter coverage, reservations, and reconciliation connect to admission.
- Evaluations use immutable datasets and a 120-case deterministic corpus. Optional paid execution requires durable admin authorization and a server-only enable flag.
- Compose and Fargate profiles include API, console, gateway, dispatcher, and worker images.

## Final local verification in progress

1. Complete focused restore-quarantine and inbound ownership-renewal corrections from the integration review.
2. Run final integrated CI, disposable PostgreSQL, protocol lifecycle, restore, and browser verification.
3. Reconcile each acceptance criterion with current evidence. Preserve gaps rather than converting implementation presence into verification.

## Authorization or external evidence required

- An owned carrier number and explicit authorization for real outbound/inbound test calls.
- Selected provider credentials and authorized audio, language, latency, and billing fixtures.
- A target AWS account/region, deployment authorization, routing/IAM verification, and Fargate scaling/drain trials.
- Human listening, operator workflow, and accessibility reviews.
- Project license/distribution approval before package publication.

No launch decision should infer readiness from Terraform validation, an installed SDK, passing simulation, or a populated console form. Paid provider traffic, real calls, AWS provisioning, publication, and customer contact remain unauthorized in this task.
