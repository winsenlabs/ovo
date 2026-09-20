# Next implementation and certification gates

This branch is a working local foundation, not completion of the full project. Keep every unfinished acceptance requirement in `acceptance.json`.

## Independent engineering work, not blocked by paid access

1. Connect approved provider/voice/tool compositions to the default management API for context and agent releases. All four behavior plugins exist; only announcement and FAQ publish by default. Route tool-dependent FAQ entries through shared execution; current matching safely clarifies instead of executing the check. Complete deterministic script-state graphs.
2. Evolve the control-store contract to asynchronous methods and implement the shared PostgreSQL control adapter. Do not use SQLite on Fargate.
3. Implement the live media/session gateway and streaming STT/TTS pipeline, including revised partial transcripts, VAD/backchannel rules and playback-aware history integration.
4. Join callback correlation, unknown-dial reconciliation, voice session completion and durable operation/event projections end to end.
5. Complete campaigns, suppression rechecks, pause/resume, inbound policy and transfer/handoff workflows.
6. Implement aggregate latency/cohort views, resumable event delivery and diagnosis workflows. Do not report simulator timings as production latency.
7. Complete recording alignment, exports, deletion/tombstone propagation and physical retention sweeps.
8. Join actual provider usage with price-card versions, reconciliation, cache accounting, spend enforcement and the INR scenario calculator.
9. Expand deterministic evaluation corpora, load/fault/restore drills and security/accessibility tests.

## Authorization or external evidence required

- Owned carrier number and explicit authorization for real outbound/inbound test calls.
- Selected provider credentials and authorized audio/language/latency fixtures.
- Target AWS account/region, deployment authorization, routing/IAM verification and Fargate scaling/drain trials.
- Human listening, operator workflow and accessibility reviews.
- Project license/distribution approval before any package publication.

No production launch should infer readiness from Terraform validation, an installed SDK, a passing simulator or a populated console form.
