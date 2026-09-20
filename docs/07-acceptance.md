# Acceptance criteria, verification and operations

## 1. Evidence format

For every criterion retain ID, work package, test/review, build/config digest, environment/profile/provider/language, sample size, observed result, owner and evidence link. All criteria below are launch requirements unless explicitly labelled proposed target or later scope. This document defines tests; it does not assert they have passed.

## 2. Product and frontend criteria

| ID | Given / when | Required result | Work packages |
|---|---|---|---|
| A01 | Fresh checkout is installed and built | Namespaced packages, documented commands, CI pass; applications private | W02 |
| A02 | Announcement agent has no LLM binding | It publishes/runs with valid message inputs; no LLM call occurs | W08, W14 |
| A03 | Required amount/date missing or invalid | Admission rejects with field error before dialing; no placeholder spoken | W08 |
| A04 | Announcement receives valid locale/timezone data | Approved values are spoken correctly in tested fixtures | W08 |
| A05 | FAQ bot has only STT/TTS and deterministic matcher | Supported questions answered; no generative or hidden semantic API request | W09 |
| A06 | FAQ score weak or two answers near-tied | Configured clarification/escalation; no forced nearest answer | W09 |
| A07 | FAQ answer needs account eligibility | Explicit tool/policy path or honest handoff; no generic approval | W09, W11 |
| A08 | Context-only bot lacks relevant supplied fact | Configured uncertainty response; no tool execution or invented confirmed fact | W10 |
| A09 | Supplied facts exceed model budget | Critical context is preserved through documented strategy or test/publication fails | W10 |
| A10 | Agent proposes unknown/invalid tool | Runtime rejects before external execution and records error | W10, W11 |
| A11 | Tool requires confirmation | External write waits for valid confirmation; processing speech is not consent | W11 |
| A12 | User configures tool-specific waiting phrase | Exactly one matching acknowledgment precedes spoken result | W11, W14 |
| A13 | Tool completes before phrase finishes | Operation runs concurrently; result waits; required acknowledgment retained | W11 |
| A14 | One operation calls three internal APIs | One initial acknowledgment, distinct correlated internal spans | W11, W15 |
| A15 | Caller interrupts while check is pending | Speech stops; appropriate tool cancellation/reconciliation; result not lost | W04, W11 |
| A16 | Operation exceeds progress threshold | Bounded configured progress speech, cancelled on completion | W11 |
| A17 | Builder changes processing text/language | New release uses change; active call keeps prior version | W12, W14 |
| A18 | Authorized operator configures each bot mode | Entire journey completed in frontend, no source or agent `.env` edits | W12–W14 |
| A19 | Secret submitted in frontend | Stored server-side encrypted; response contains reference/metadata only | W13 |
| A20 | Secret validated/rotated/retired | Redacted status and impact shown; new calls follow valid binding; no value reveal | W13, W14 |
| A21 | Browser/log/export/telemetry inspected | No plaintext credential survives outside the intended input/request/backend resolution path | W13, W20 |
| A22 | Two builders edit same draft | Conflict detected; no silent overwrite; released version unchanged | W12, W14 |
| A23 | Incompatible plugin/voice/provider selected | Publication blocked with specific capability/dependency error | W03, W14 |
| A24 | New plugin version published during call | Existing call pinned; new call uses selected release | W03, W12 |
| A25 | Plugin inspector component throws | Error contained; core call/navigation experience still usable | W14, W15 |
| A26 | Keyboard-only operator uses console | Required authoring/review actions accessible; focus/errors labelled | W14, W20 |

## 3. Runtime, durability and deployment criteria

| ID | Given / when | Required result | Work packages |
|---|---|---|---|
| A27 | Same SQS job delivered to ten workers | One valid owner; no duplicate dial caused by duplicate delivery | W07 |
| A28 | Dial API times out after carrier acceptance | Reconcile status before retry; unknown outcome visible | W05, W07 |
| A29 | Tool write times out after external acceptance | Unknown/pending recorded; no blind retry or false success | W07, W11 |
| A30 | Database fails before write intent persistence | Tool side effect does not execute | W07, W11 |
| A31 | Caller repeatedly interrupts and old provider output arrives | Old response epochs never enter playback | W04 |
| A32 | Backchannel/background noise occurs | Tested turn policy distinguishes it from takeover; measured false-interrupt rate reported | W04, W06 |
| A33 | STT revises partial transcript | One accepted user turn; no repeated business action | W04, W06 |
| A34 | Provider is slow or unavailable | Bounded queues/deadlines and configured recovery; no infinite processing | W04, W06 |
| A35 | Session ends through concurrent signals | Cleanup exactly once; no leaked stream/timer/session object | W03, W04 |
| A36 | Framework/providers swapped | Behavior code unchanged; advertised contracts pass conformance suite | W03, W06 |
| A37 | Normal deployment drains active workers | No rollout-induced drops within certified drain window | W19 |
| A38 | Worker/EC2 host crashes | Sessions marked/reconciled; no claim of seamless audio recovery or automatic duplicate redial | W07, W19 |
| A39 | Single EC2 runs two calls | Separate workers/context/limits, no state/audio crossover | W19 |
| A40 | Fargate deployment inspected | All claimed application compute on Fargate; external managed services explicit | W19 |
| A41 | Inbound arrives without ready capacity | Defined overflow/wait/human/callback path, no unexplained silence | W16 |
| A42 | Suppression added after campaign enqueue | Admission/retry rechecks and prevents dial | W16 |
| A43 | Campaign paused | New dials stop within five seconds of acknowledged pause; active-call policy explicit | W16 |
| A44 | Transfer fails | Caller receives configured fallback; no false transfer-success status | W05, W16 |
| A45 | Callback duplicated/out of order | Idempotent projection; terminal state never regresses | W05, W07 |

## 4. Observability, safety and commercial criteria

| ID | Given / when | Required result | Work packages |
|---|---|---|---|
| A46 | Caller hears partial response then interrupts | Inspector distinguishes generated/sent/played evidence; context includes correct partial state | W04, W15 |
| A47 | Call recording unavailable | Disabled/finalizing/failed/expired distinct; transcript still usable | W17 |
| A48 | Aligned transcript clicked | Seek within ±250 ms of known alignment, or label estimate/unavailable | W15, W17 |
| A49 | Dashboard disconnects/reconnects | Calls continue; stale label; cursor/snapshot recovery without duplicate lines | W12, W15 |
| A50 | Slow turn inspected | Timeline exposes turn/STT/model/tool/TTS/playback spans without double-counting overlaps | W15 |
| A51 | Latency percentile/cohort selected | Underlying calls and sample count available; no averaging percentiles | W15 |
| A52 | Cross-workspace IDs/customer references supplied | Access denied server-side for APIs, streams, artifacts and plugin routes | W12, W20 |
| A53 | Malicious caller/tool content requests privilege change | No access grant, secret retrieval, arbitrary plugin install or unapproved operation | W11, W20 |
| A54 | HTTP tool points to metadata/private endpoint through redirect | Egress validation rejects unapproved destination | W11, W20 |
| A55 | Recorded call replayed | Stub tools and synthetic transport enforced; no customer dial/production mutation | W17, W20 |
| A56 | Retention/deletion job runs | Eligible originals, derived views and exports removed with audit; backup policy documented | W17 |
| A57 | Backup restored | Jobs reconciled before execution; deletion tombstones reapplied; restore evidence retained | W19 |
| A58 | Usage/cost fixtures reconciled | Raw units, price/FX versions and rounding explain totals including retries/transfers/overhead | W18 |
| A59 | Cached speech used | Generation cost/hits separate; no false claim carrier minutes are free | W18 |
| A60 | ₹10 scenario selected | Telephony/tax/FX/speech/cache/idle assumptions visible; margin scope explicit | W18 |
| A61 | Budget threshold reached | New admission follows configured reservation policy; active-call handling explicit | W16, W18 |
| A62 | Operator investigates seeded latency incident | At least 4/5 users identify cause and call evidence within two minutes | W15, W20 |

## 5. Proposed measurable quality gates

These are targets to verify, not promises already achieved. An engineering agent cannot silently lower targets or relabel fillers as answers. Where provider/carrier limitations make a target unattainable, provide measurements and an explicit product decision.

| Metric | Proposed target | Measurement |
|---|---|---|
| No-tool meaningful response | p50 ≤800 ms; p95 ≤1,500 ms | Annotated speech end to first meaningful audio at declared observation point |
| Cached scripted response | p95 ≤700 ms | Same basis, includes endpoint decision |
| Cached acknowledgment | p95 ≤500 ms | Accepted operation to outgoing first audio |
| Interruption stop | p95 ≤200 ms in controlled receiver test | Annotated takeover onset to last obsolete speech audio; carrier paths reported separately |
| Greeting | p95 ≤1,000 ms | Carrier connected to first outgoing audio with ready worker |
| Live UI event freshness | p95 ≤2 seconds | Backend ingestion to rendered event |
| Console useful content | p95 ≤2 seconds | Declared device/network and production-size dataset |
| Critical event persistence | p95 ≤1 second | Synchronous business intent must persist before side effect regardless |
| False early turn / missed turn | ≤5% / ≤2% on labelled set | Per supported language and noise condition |
| Human intelligibility/pacing | Median ≥4/5 over 50 calls | Retained rubric and reviewers; critical factual/action failures block |

Fargate reference load: 100 simultaneous sessions for 60 minutes after warmup; two-minute median with documented long-tail duration, 10% tool turns and 20% interrupted turns. EC2 load: at least two sessions and separately determined host capacity. Use at least 500 eligible turns and 100 interruptions per certified language/transport combination. Simulator throughput and live-provider quality are separate evidence.

Report failures, timeouts, sample counts, provider versions/regions, carrier/codec, worker size, model context/output, audio buffering, and warm/cold status. No promise of OpenAI Voice Mode equivalence; naturalness is evaluated with defined tests.

## 6. Evaluation corpus and release gate

At least 120 versioned scenarios: 30 announcement/FAQ/script, 20 supplied-context/tool cases, 20 interruption/turn cases, 15 ambiguity/noise/language, 15 security/policy and 20 infrastructure/provider failure. Each has input, expected transition/action, forbidden actions and objective assertions. Automated graders cannot replace deterministic side-effect and secret-isolation tests. Human review covers conversational quality.

Release requires all applicable A01–A72 criteria, measured performance gates, real carrier evidence, restore and rollout drills, frontend journeys, both deployment profiles and documentation. A restricted preview may have explicit limitations; it cannot claim full launch acceptance.

## 7. Operational runbooks required before launch

- Provider outage: detect, bound retries, avoid repeating partial speech, choose configured fallback or end, reconcile operations.
- Worker loss: revoke/fence ownership, query carrier and pending writes, end or recover supported connection, settle call state, avoid automatic redial.
- Credential incident: revoke/rotate, list impacted agents/calls, update bindings and audit; disclose effects on existing streams.
- Scale/deploy: stop admission, drain/protect workers, roll images, verify readiness and release routing, rollback new calls if necessary.
- Recording/export failure: keep accurate artifact state, retry safely, alert, respect retention and access.
- Backup restore: restore control records, reconcile external outcomes, reapply deletion state, reopen admission only after checks.
- Cost incident: pause new jobs at configured scope, inspect provider usage/reservations and late reconciliation, never hide unallocated cost.

Every runbook has trigger, owner, commands/dashboard path, expected signals, rollback/recovery and verification. Proposed operational goals: detect stale worker within 15 seconds; start reconciliation within 30 seconds; control-data RPO ≤5 minutes and RTO ≤60 minutes when supported by the chosen backup configuration. Measure these in drills and state that live audio recovery is separate.

## 8. Plugin-first and Fargate-specific acceptance

| ID | Given / when | Required result | Work packages |
|---|---|---|---|
| A63 | Dependency architecture checked in CI | Forbidden provider imports and privileged built-in registration fail; engine/policies use public contracts | W03 |
| A64 | External sample plugin installed through supported process | Settings and telemetry appear without editing core; lifecycle conformance passes | W03, W14 |
| A65 | Engine replaced and plugin dependency fails | Behavior code unchanged; valid replacement runs; invalid graph fails before admission with cleanup | W03 |
| A66 | Outbound worker service at zero receives eligible work | Independent demand signal wakes capacity; no dial before readiness; timestamps and cost retained | W07, W19 |
| A67 | Queue becomes empty with active calls | Scale-in does not terminate protected calls; idle capacity retires after settlement | W19 |
| A68 | Burst exceeds carrier/AWS/provider quota | Bounded capacity/admission, explicit queue state and limiting quota; no duplicate dial or scaling loop | W07, W19 |
| A69 | Metrics stale or startup slow | Defined fail-safe admission; no repeated double-counted scale-out; operator alert and decision reason | W15, W19 |
| A70 | Protection cannot establish or renew during rollout | New admission blocked where required; renewal failure visible; documented fallback and reconciliation | W19 |
| A71 | Operator reviews scaling incident | Counts, queue age, ready/startup state, protection, cap and decision reason are correlated in console | W15, W19 |
| A72 | Runtime/host selection proposed | DeepSeek/Pipecat/LiveKit source map, comparable TS spikes, SDK decision, license review and evidence-backed ADRs exist | W01, W03 |
