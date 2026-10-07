# Call recordings: enabling, retention and DPDP

## Why the live calls of 2026-10-07 left no recording

Every agent was published with `"recording": false` (the release's `config.recording`, and the
agent setup scripts). The worker records only when the release says so, so no artifact was made.
The recordings backend itself was configured (`OVO_RECORDINGS_BACKEND=filesystem` on the shared
`recordings-data` volume). Meanwhile the CreditMantri flow told every caller "this call is
recorded for quality purposes". Either set `recording: true` or change that line.

From Wave 7 every call's evidence has a `recording.status` event, so this is visible without
reading the release:

| `state`                 | Meaning                                                                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`                   | The release does not record.                                                                                                                         |
| `recording`             | Capture started; `artifactId` and `expiresAt` identify the artifact.                                                                                 |
| `available` / `partial` | At hang-up: what the artifact holds, with `inboundBytes`/`outboundBytes`. `partial` means audio was lost on the way (a failed upload, a full queue). |
| `unavailable`           | The recording store refused to start one (`error`); the call went on unrecorded.                                                                     |

## Enabling it for an agent

1. Set `"recording": true` in the agent config (in the console: Studio, "Request recording for
   new releases") and publish a release. Nothing else changes per agent; calls already on the
   line keep the release they started with.
2. Say so at the start of the call, before any account detail: `compliance.disclosure.text`
   (agent mode, spoken first and pre-rendered), or the flow's first line in flow mode. See the
   DPDP section for the wording decision.
3. The worker and API need the recordings store, already set in `infra/compose/compose.yaml`:
   `OVO_RECORDINGS_BACKEND=filesystem`, `OVO_RECORDINGS_DIRECTORY=/var/lib/ovo-recordings`
   (the shared `recordings-data` volume), `OVO_RECORDINGS_DURABLE_MOUNTED=true`,
   `OVO_RECORDINGS_SHARED_ACROSS_WORKERS=true`; or `s3` with `OVO_RECORDINGS_BUCKET` in an Indian
   region (`docs/residency.md`).

What is kept: two tracks, the caller as the carrier delivered them (`inbound`) and the agent's
audio as it was sent (`outbound`, including words later cut off by a barge-in), 8 kHz mu-law,
written in 256 KiB segments (about 33 s) with SHA-256 and timeline evidence in PostgreSQL
(`ovo_recording_*`). A worker that exits mid-call loses at most the last segment per track; six
hours after such a call started, the retention sweep settles its artifact as `partial` (playable)
or `failed` (nothing was written), so it does not stay `active` and unplayable.

To listen or export, as a workspace member:

- `GET /v1/calls/:callId/live-recordings` lists artifacts (viewer).
- `GET /v1/calls/:callId/live-recordings/:id/audio/inbound` or `/outbound` streams a WAV (viewer).
  The two tracks are separate; the outbound track is the agent's audio back to back, without the
  pauses between turns.
- `POST /v1/calls/:callId/live-recordings/:id/exports` builds a redacted transcript export.
- `DELETE /v1/calls/:callId/live-recordings/:id` (editor) deletes one now: access ends at once,
  the objects are removed by the next sweep.

A recording store that cannot start a recording (PostgreSQL or the object store down) does not
fail the call: the caller is answered, unrecorded, with `recording.status` `unavailable`. A worker
deployed without the recordings service at all still refuses calls for recording agents: that is
a deployment error.

## Retention

- `OVO_RECORDING_RETENTION_DAYS` (API and worker; default **30**, 1-365) fixes each recording's
  `expiresAt` when the call starts. Changing it affects new recordings only.
- The API and every worker run the retention sweep every 60 s: an expired recording is
  tombstoned (access ends in the same transaction) and its segment and export objects are
  deleted; failed deletions are retried. `POST /v1/recordings/retention/sweep` (admin) runs one now.
- Backups: `scripts/backup/ovo-backup.sh` mirrors the recordings volume to the offsite bucket with
  `--delete-unmatched-destination-objects`, so a recording deleted here is deleted there at the
  next backup; the bucket keeps the deleted version 30 more days (plus 14 days of soft delete)
  before it is gone (`infra/gcp/backup-lifecycle.json`). A deletion request is therefore complete
  offsite up to about 45 days later. Database archives are kept 35 days; one restored from before
  a deletion brings back the recording's row but not its audio.

## DPDP Act 2023 considerations

The customer (the lender) is the Data Fiduciary for its calls; an OVO installation processes on its
behalf. A call recording is personal data: the caller's voice, and usually their name, loan and
payment details. The DPDP Rules' notice and consent duties commence **13 May 2027**; TRAI and DoT
rules do not require announcing a recording (`trai-spec.md` R27). What the platform does now:

| Principle                     | Platform behaviour                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Notice before processing      | A recording disclosure line is spoken first when configured. Not enforced: an agent can record without one (see decision 3).                                                                                                                                                                                          |
| Purpose and data minimisation | Recording is off unless an agent turns it on. Transcript words in call evidence can be dropped per installation or per agent (`OVO_TELEMETRY_TRANSCRIPT_TEXT`, `OVO_TELEMETRY_TRANSCRIPT_TEXT_AGENTS`). Exports redact emails, phone numbers and configured patterns, and leave out agent text that was never played. |
| Storage limitation            | 30-day default, automatic deletion with physical removal, deletion on request.                                                                                                                                                                                                                                        |
| Erasure and access requests   | Delete per recording (`DELETE …/live-recordings/:id`); access via the WAV and export endpoints. There is no search by phone number: find the call first.                                                                                                                                                              |
| Security safeguards           | Role checks (viewer reads, editor deletes, admin sweeps), integrity hashes, audit rows for deletions and sweeps. No application-level encryption: rely on disk or bucket encryption at rest (GCP and S3 encrypt by default).                                                                                          |
| Residency                     | Audio stays on the VM disk or a bucket in India (`docs/residency.md`).                                                                                                                                                                                                                                                |

## Decision points (founder and legal)

The shipped defaults are the conservative ones; none blocks a deployment.

1. **Record by default?** Shipped: off; on per agent. Recording collections calls helps disputes and
   quality review, but every recording is personal data to protect and delete.
2. **Retention period.** Shipped: 30 days for audio. `trai-spec.md` suggests keeping complaint
   evidence for 2 years (the telcos' complaint window), which argues for longer; DPDP storage
   limitation argues for shorter. Options: keep audio 30-90 days and the call's metadata and
   outcome longer, or raise `OVO_RECORDING_RETENTION_DAYS` (maximum 365) for collections. A
   per-agent retention period needs the contracts change listed in the Wave 7 ops report.
3. **Disclosure.** Shipped: optional line. Before May 2027, decide the notice text (who records,
   why, how long, how to ask for deletion) and whether a recording agent without a disclosure line
   should be refused at publish (proposed as a publish warning in the Wave 7 ops report).
4. **A caller who objects to being recorded.** Not built: today the only choices are to continue
   recording or end the call. A "stop recording" intent would stop the capture and mark the
   artifact `partial`.
5. **Recording failure.** Shipped: the call continues unrecorded and says so in its evidence. If
   a customer's policy is "no recording, no call", that needs a per-agent switch.
6. **Sharing.** Whether recordings are produced to the customer's telco or a regulator on a
   complaint, and through what channel, is a process decision; the export endpoint is the
   mechanism.
