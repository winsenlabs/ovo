# India outbound compliance (TRAI / RBI)

**Owner:** the workspace admin, with the customer's compliance officer. **This is not legal advice.** Every default below is a conservative engineering choice, cited to the rule (R#) or open question (Q#) of the compliance spec (`trai-spec.md`, 7 Oct 2026). The legal or founder decisions it depends on are listed in [Decision points](#decision-points); none of them blocks dialing, because each is a setting.

OVO is self-hosted software. The customer (the lender, utility or other business) is the **Sender** and Principal Entity under TCCCPR; its telco is the Originating Access Provider (OAP). OVO enforces what the customer configures and keeps the evidence. DLT registration, number-series allocation, A2P declaration filing and consent registration stay with the customer (Q6).

## What OVO enforces

A built-in rule pack, `IN-TCCCPR 2026.10.1`, sets the floors for every call to a `+91` number. Configuration can only narrow it: a window, cap or date that would widen a floor is refused when it is written (`policy_widens_floor`), never silently clamped. Numbers outside India get only the configured windows and caps, and the do-not-call list.

One evaluator decides every dial. It runs when a campaign is created, at admission, at the final authorization (inside the transaction that writes the attempt), for manual and test calls, and for redrives. Every decision is stored with its rule-pack version and a policy hash.

| Rule                                     | What happens                                                                                                                                                                                                                                                                                                                                                                            | Source          |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| Call category                            | Agents carry `compliance.category` (promotional, service, transactional). A `+91` call without one is refused (`category_missing`) and its campaign paused.                                                                                                                                                                                                                             | R2–R5, R9       |
| Caller-ID series                         | The caller number must be in the CLI registry, active, and in the category's series: 140 for promotional, 1600/1601 for service and transactional. A sender regulated by RBI, SEBI, IRDAI, PFRDA or Government must use 1600, utilities and logistics 1601. Refused by default; `enforcement.series = warn` dials and records a warning. Flagged or suspended numbers are never dialed. | R1–R5, R20      |
| Autodialler intimation / A2P declaration | Until `enforcement.a2pDeclarationRequiredFrom` (default 2026-11-17, may only move earlier) the written intimation to the OAP must be on file. From that date, the caller number must fall in an effective A2P declaration range.                                                                                                                                                        | R6, R7          |
| Calling windows                          | Every layer is judged in IST for `+91`: the floor (promotional 10:00–21:00), the purpose overlay (RBI recovery 08:00–19:00), the workspace default, the agent's hours and the campaign's hours. A campaign window can only narrow the agent's (this fixes the old bug where it replaced it). End times are exclusive.                                                                   | R15–R17, G4, G5 |
| Holiday blackout                         | Default `01-26`, `08-15`, `10-02` every year, for promotional and RBI recovery calls. Configurable (`blackout`).                                                                                                                                                                                                                                                                        | Q13             |
| Consent                                  | The campaign names a basis allowed for its category. Service defaults to an existing relationship (no row needed unless a revoked one is on record); explicit 7-day service consent expires after 7 days, inquiries after 7 days, applications after 3 months, transactional triggers after 30 minutes. Promotional needs registered explicit consent or a fresh DND scrub.             | R9–R12          |
| Opt-out                                  | An in-call opt-out (or a `do_not_call_requested` flow disposition) lists the number for every call (`optOutScope = all`), locks the entry for 90 days, and revokes the number's consents. Consent may not be re-recorded inside the lock unless the customer opts in themselves.                                                                                                        | R13, Q8         |
| DND / NCPR scrub                         | Promotional calls fail closed: no fresh `allowed` result from the configured provider means `preference_unverified`. A `fully_blocked` upload also lists the number for promotional calls (`ncpr`). Service calls under an existing relationship ignore DND; 7-day consent calls honour FULLY BLOCK.                                                                                    | R9, R14         |
| Per-recipient caps                       | Counted per number across every campaign and manual call, rolling (not calendar): see defaults below.                                                                                                                                                                                                                                                                                   | Q4, R17         |
| Retries                                  | Never after an opt-out, wrong number, refusal or dispute. Busy: 30 min then 2 h. No answer: 2 h, 4 h, next day. Voicemail: next day. Network failure: 15 min, twice. Answered with no agent: never. Only campaigns that allow more than one attempt per number retry.                                                                                                                   | spec 3.7        |
| Pacing                                   | Caller numbers outside 140/1600/1601 are held to 60 calls an hour and 300 a day (`pacing`), on top of the carrier's CPS.                                                                                                                                                                                                                                                                | R19, R20        |
| Abandoned/silent ratio                   | Over the last 24 hours per caller number: answered with no agent session (abandoned) at 3%, or ended within 3 s of the answer (silent) at 1%, pauses its campaigns. Needs 20 attempts before it trips.                                                                                                                                                                                  | R18, Q5         |
| Complaints                               | Customer complaints: acknowledge in 24 h, resolve in 7 days. Telco and regulator notices: answer in 5 business days. A customer complaint puts the number on the do-not-call list (source `complaint`, no lock; remove it after resolution if appropriate), and any open complaint refuses calls to the number.                                                                         | R21, R22, Q12   |
| Disclosures                              | Optional identity, AI and opt-out-hint lines, spoken before the recording line in that order. Off by default.                                                                                                                                                                                                                                                                           | R27, R28, Q9    |

### Default caps

| Kind          | Attempts                                                  | Conversations | Gap  |
| ------------- | --------------------------------------------------------- | ------------- | ---- |
| Promotional   | 1 / 24 h, 2 / 7 d, 4 / 30 d                               | 1 / 7 d       | 24 h |
| Service       | 3 / 24 h, 10 / 7 d                                        | 1 / 24 h      | 2 h  |
| RBI recovery  | 3 / 24 h, 12 / 7 d (a floor while `recoveryCapsAreFloor`) | 1 / 24 h      | 2 h  |
| Transactional | 3 / 24 h                                                  | none          | none |

## Before the first `+91` call after this release

Nothing is dialed until the sender side is configured. As an admin, on **Operations › Compliance** (or `PUT /v1/operations/compliance/settings`):

1. Set the sender's legal name, DLT principal entity id and regulator (the regulator picks the series).
2. Record the autodialler intimation (date, telco, objective, document reference).
3. Register each caller number with its categories (`PUT /v1/operations/compliance/cli-numbers/:number`). The series is derived from the digits.
4. From 17 Nov 2026, record the A2P declaration ranges and their effective dates.
5. Give every agent a call category (and `purpose: rbi_recovery` for collections) and publish a new release. Campaigns created before this release keep their old checks; recreate them to apply the rule pack.
6. For internal test calls to your own phones, list them under **Test numbers**. They skip category, series, A2P, consent and DND checks, never the do-not-call list, caps or windows.

If your test caller number is a regular 10-digit or foreign number (for example a Twilio number), either list the destination phones as test numbers or set `enforcement.series = warn`. Both choices are recorded in every decision.

## Day-to-day

- **Refusals.** Each refusal returns a code (`category_missing`, `series_category_mismatch`, `outside_calling_hours`, `recipient_attempt_cap`, …) with an HTTP status: 422 for configuration, 409 for the recipient's state. A sender-level refusal (category, series, A2P, intimation, flagged CLI, ratio breaker) pauses the campaign with `driverError = compliance:<code>`; fix it and resume. A recipient-level refusal ends that contact as `suppressed` or `invalid` with a `complianceReason`; a deferral (window, caps, gap) requeues it for when it is next eligible.
- **Removing a do-not-call entry** is an admin action with a reason (`DELETE /v1/operations/suppressions/:number?reason=…`). An opt-out inside its 90-day lock returns `409 opt_out_locked`. Every removal and refused removal is in the audit log, keyed by a hash of the number.
- **DND scrub.** Upload results from your RTM or telco portal (`POST /v1/operations/compliance/preferences/upload`, or the console). They stay fresh for `scrub.maxAgeHours` (24 h). A vendor provider plugin implementing `PreferenceProvider` (contracts `preference-provider.ts`) can be passed to the operations service instead; none is shipped, because no vendor wire format has been confirmed.
- **Telco spam-flag notice.** Set the caller number to `flagged` in the registry; its campaigns pause. Open a complaint of kind `ai_flag_notice` or `oap_notice` to track the 5-business-day representation window.
- **Complaint about a number.** `GET /v1/operations/compliance/evidence?phoneNumber=…&date=…` returns every decision, attempt, consent, suppression, scrub result and complaint for that number within 7 days of the date.
- **Regulator export.** `GET /v1/operations/compliance/export?from=…&to=…` (admin) returns a ZIP of CSVs (decisions, attempts, consents, suppressions, preference checks, complaints, caller numbers, A2P declarations) with a `manifest.json` holding the rule pack, every policy hash in range and a SHA-256 per file. Which disclosure lines played is in each call's session events (`GET /v1/calls/:id/events`).

Keep compliance records for at least two years (R22). Nothing in OVO deletes decisions, ledger rows, consents or complaints; deleting a campaign leaves them in place.

## Decision points

Each open question of the spec is a setting with a conservative default. Change one only with a written decision from legal or the founder.

| Q   | Question                                   | Default shipped                                                                          | Setting                                                 |
| --- | ------------------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Q1  | Promotional window 10:00 or 09:00?         | 10:00–21:00 (floor, code)                                                                | none: a code change with a version bump                 |
| Q2  | Third Amendment commencement date          | A2P required from 2026-11-17; can be set earlier                                         | `enforcement.a2pDeclarationRequiredFrom`                |
| Q3  | Is an AI agent a recovery agent under RBI? | Yes: `rbi_recovery` gets 08:00–19:00                                                     | agent `compliance.purpose`                              |
| Q4  | Hard caps for collections                  | 3 attempts and 1 conversation a day, as a floor                                          | `caps.rbi_recovery`, `enforcement.recoveryCapsAreFloor` |
| Q5  | Is an AI-answered call "abandoned"?        | No: the AI agent is the live agent; abandoned means no agent session on an answered call | `breaker.*`, `enforcement.abandonedBreaker`             |
| Q6  | Who is the Sender                          | The customer; OVO enforces configuration                                                 | contract language, not a setting                        |
| Q7  | Consent sourcing from CRF/DCA              | Operator-uploaded consent references only; in-call opt-outs are not forwarded to DLT     | —                                                       |
| Q8  | Scope of an in-call opt-out                | Every call from the org                                                                  | `optOutScope`                                           |
| Q9  | AI disclosure line                         | Off; the identity and AI lines are available per agent                                   | agent `compliance.disclosures`                          |
| Q10 | Recording notice before DPDP (May 2027)    | Existing recording line, off by default                                                  | agent `compliance.disclosure`                           |
| Q11 | Non-designated caller numbers              | Refused                                                                                  | `enforcement.series`                                    |
| Q12 | Complaint SLA                              | 24 h acknowledgement, 7-day resolution; 5 business days for notices                      | `complaintSla`                                          |
| Q13 | Holiday blackout                           | 26 Jan, 15 Aug, 2 Oct for promotional and recovery calls                                 | `blackout`                                              |

## Not covered yet

- **Speaking the identity and AI lines.** The agent contract carries them and the clip inventory lists them (`disclosureLines`), but the behaviour that speaks the opening disclosure (`packages/behaviors/src/disclosure.ts`) and the speech-cache inventory belong to another lane; until they adopt `disclosureLines`, only the recording line is spoken.
- **Carrier reasons on the status-callback path.** Busy and no-answer outcomes reported through the media gateway's status callback arrive without a reason, so they are retried with the no-answer backoff (the safer, longer one).
- **Content guard.** No check yet stops promotional wording inside a service call (R9 mixing rule); keep offers out of service agents' prompts and flows.
- **Encrypted numbers at rest.** Compliance tables store E.164 numbers in clear, like the existing contact and do-not-call tables; audit entries use hashes.
