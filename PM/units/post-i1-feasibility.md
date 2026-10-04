# Can the CreditMantri POC be built on OVO, and can calls be tested inside OVO?

Evidence markers: **[V]** verified in code/docs this session · **[S]** stated in one of the three specs, not yet built · **[A]** assumption, explicitly not knowable without a real call or vendor confirmation.

---

## 1. Can it be built? **Partially — the conversation brain, yes; the collections product, no.**

With OVO as it stands plus P1 + P2 + P3 + P4, the POC's _routing and audio model_ becomes expressible. Its _business behaviour_ does not. Still missing afterwards, each named:

- **SMS egress, the pay link, and the paid-state callback.** `grep -i '\bsms\b' packages/contracts/src` returns nothing **[V]**. 8 of 34 POC nodes emit SMS; P2 defers it to an unwritten "effects unit" (gap 5) **[S]**, P3/P4 never touch it. No message-template contract, no delivery record, no `sms` usage unit, no payment-event webhook.
- **The business disposition log.** 19 of 34 POC nodes write one. `CallOutcome` has no slot for `promise_to_pay:tomorrow` **[V]**. Same unwritten unit.
- **Node-entry effects at all.** `IntentScriptNode` is `.strict()` with no `sms`/`log`/`verified` **[V]**. P2 implements only the verification latch, via a sidecar.
- **The tier-1 regex tier.** P2 §D is explicit: the POC's `YES`/`SPEAKING` families, `link_check`, `wrapup` and `repeat` rules are **not expressible**; tier 1 shrinks to `ASK` options plus `classifyConfirmation` **[S]**. Turns that cost the POC 0 ms will cost a decision round trip.
- **Both speculation mechanisms** (decision-on-partials; parallel LLM with abort) and the accounting for aborted inference. P2 §F argues correctly that a `Behavior` never sees interim transcripts, so this is an engine unit **nobody has specced** **[S]**.
- **The filler clip and the two-phase turn.** OVO's `ProcessingSpeech` is bound to tool execution only. No spec builds it, so a tier-3 fallback is **silent** for the whole LLM round trip where the POC covers it with a pre-rendered filler. This is the most audible regression.
- **Typed slots.** `IntentDefinition.slots` is names only **[V]**. `ptp_when` survives as a `CLASSIFY` step; "₹4,500 on the 14th" does not.
- **Model-chosen resume.** P2 pins static `fallback.resumeAt` and refuses the POC's per-reply choice **[S]** — defensible, but a behaviour change.
- **A `route` producer.** P3/P4 define and render the event; P2 keeps the trace in-package (gap 11) and hands the `BehaviorEvent`/`VoiceEvent` widening to "the console unit" **[S]**. After all three units the console's tier column still reads `—`. The one thing you asked to see is not wired by anyone.
- **Clip-to-node addressing.** P3 binds by rendered-text identity and forbids a `clipId` on nodes **[S]**; P2 sentence-splits one `prompt` string. The seam where those two must agree byte-for-byte is owned by neither spec.
- Also absent: DTMF in the intent graph; a wall-clock graph timeout; graph reachability was lost vs `script.ts:49-57` (P2 restores it in the compiler) **[V]**; Hindi Devanagari/romanised and Tamil `சரி/seri/போதும்` plus the `SPEAKING` family in `CONFIRM_YES/NO`; mic input in the console; a durable clip tier; an ElevenLabs plugin at all **[V]**.

So: build these three and you have a POC-shaped _conversation_ on production rails. You do not have a collections POC, because nothing that moves money is specced.

## 2. What OVO gives the POC that it has nothing of

Real outbound dial with carrier control and carrier-call-id CAS binding; Twilio/Plivo/Exotel plugins **[V]** — the POC has no carrier and its ₹0.60/min line is a placeholder. Barge-in (`TurnDecision 'interrupt'`, target p95 ≤200 ms) **[V]**, which the POC's README disclaims. **Playback-gated state advance** (`onPlayback`, `completed` + matching epoch) — the POC advances on an HTTP response and trusts the browser to play; this is the single largest correctness upgrade. Durable call rows, event log, aligned transcripts, recordings and retention, against the POC's in-process `Map`. Workspace scoping, a secret store, SSRF and egress validation. Immutable versioned releases with compat/admission gates. Pricing with integer-rational arithmetic, versioned rate cards, FX provenance and budget reservation **[V]**, against the POC's floats from `.env`. DNC/suppression enforcement, where the POC logs the request and does nothing. The four-layer fixture isolation **[V]**. Latency attribution cohorted p50/p95/p99. A compliance-grade `disclosure` speech kind that cannot be barged over or transcribed **[V]** — the POC has mic gating but no such primitive. And Sarvam: 23 Indic STT languages, 11 TTS, μ-law 8 k native **[V]**, versus the POC's two.

## 3. What the POC has that OVO still would not

The filler/two-phase turn. Speculation on partials and the abort-accounted parallel LLM. The regex tier. SMS, the pay page, the paid-state poll. The disposition log. Client-side pre-decode of all 47 clips into RAM on a scheduled `AudioContext` clock with a 180 ms inter-clip gap — the POC's "~15 ms" is a _browser_ number and does not transfer to a carrier leg. The adaptive noise floor (EWMA, `max(fixed, floor×2.5)`) and the 1500 ms partial-stall failsafe — OVO has fixed-threshold VAD plus provider/vad-timeout strategies, and neither refinement is in any spec. `gen-map.js` graph→docs generation. Deterministic case selection by contact-name hash. Two closures worth crediting: **spoken-form rendering** (P3 Part B.1 ports `lib/format.js` into contracts) **[S]**, and the **cache-miss counterfactual** (P3 Part D, as an event, correctly not a meter) **[S]**. Per-language persona/voice inside one agent closes by decision, not by build: P3's locale refine enforces one language per agent, matching your "each bot is one language".

## 4. Latency — the question that decides viability

**Known [V].** OVO has never placed a real call (`PM/units/README.md:184`); `PM/HANDOFF.md:91` keeps it forbidden pending your authorization. There is therefore **not one measured end-to-end number on a phone line**. The `docs/07-acceptance.md` §5 figures are labelled "targets to verify, not promises already achieved": cached scripted p95 ≤700 ms, no-tool p50 ≤800/p95 ≤1,500, greeting p95 ≤1,000, barge-in p95 ≤200. The prepared runbook is **Twilio inbound only**, Deepgram `nova-3` + OpenAI TTS; Exotel/TCN/Alohaa explicitly hold Indian-carrier rollout. CM is **outbound, Indian, partly Tamil** — none of that is on the authorized path. Twilio media is μ-law 8 kHz mono, enforced (`media.ts:68`); the POC measured a **16 kHz browser mic on localhost**. `plugin-stt-deepgram` declares `languages: ['en','en-IN','hi','multi']` — **no Tamil** — with `ttfsP99Ms: 350`; Sarvam declares `ta-IN` with `ttfsP99Ms: 1000`. Both are declared plugin constants, not measurements. Deepgram and AssemblyAI declare `forceEndpoint: true`, Sarvam only when `endpointing: 'manual'` — so OVO owns the mechanism behind the POC's 300 ms manual-commit win, but on the only Tamil-capable provider it is binding-conditional with a 3× declared TTFS.

**Assumed, and must not be repeated as fact [A].** That the POC's ~700 ms STT finalisation transfers. It will not be comparable: different provider (ElevenLabs `scribe_v2_realtime`, which OVO has no plugin for), different sample rate, different codec, plus a carrier leg the POC has no term for. Anyone who puts 720 ms in an OVO deck is inventing it.

**Must be measured, in this order.** (1) Carrier media RTT and jitter, outbound, on the chosen Indian carrier. (2) STT finalisation **per provider, per language, at μ-law 8 kHz**, `forceEndpoint` on and off — reported with WER, because 8 kHz WER is the input to the calibration cohort. (3) The clip-hit path: `turn.stopped` → playback-confirmed first audio, which is the only thing P3 can legitimately claim a ~15 ms-class figure for, and even then it is bytes-to-carrier, not bytes-to-ear. (4) Decision round trip — Jev hosted, Laya in-VPC; P1's `p99LatencyMs` is a _declared manifest field_. (5) Tier-3 total **with no filler**, because that is what OVO will actually do. Structural point: strip the regex tier and speculation and the latency _distribution_ shifts even if every component matches — free turns become paid round trips, and slow turns become silent ones.

## 5. Build order

**Gate 0 — the first real call.** `README.md:184` makes it the entry condition for all post-I1 work; the runbook is prepared and unexecuted. Building four units against an unmeasured media path is the mistake to avoid.

**Gate 1 — P1's calibration entry criterion (EC1–EC6).** Blocks P1 §C/§D and hence P2's tier 2. The corpus should be 8 kHz carrier audio, which makes Gate 1 downstream of Gate 0.

**Start now, no dependencies, parallel:** P4 Part E (E.1–E.6) — six verified live console bugs, ~a day, and it is the cheapest real value in the set; P3 Part B (pinned cache tier + `spoken-form.ts`); P1 STEP 0 (doc-only wire spike); P2 STEP 0 (expressibility spike).

**After Gate 1, parallel:** P1 §C then §D; **P2 tiers 1 and 3** (P2 §E explicitly degrades to `decision_absent`, so this does not wait on P1); P3 Part C (boot warm + pre-dial); P4 Part G (interactive turns — independent of P1–P3).

**Last:** P2 tier 2 (needs P1); P4 Part F (needs P2 **plus** the unspecced `route` producer and union widening — add that to a spec before starting). **Then** the three unwritten units: effects/SMS/disposition, the speculation engine unit, filler + two-phase turn.

Hard serializations: Gate 0 → Gate 1 → P1 §C/§D → P2 tier 2 → P4 Part F. Everything else fans out.

## 6. Risks, ranked

1. **Calibration across languages.** It gates everything because the middle tier _is_ the architecture, and the middle tier is only sound if confidence is calibrated. The POC ships `JEV_MIN_CONFIDENCE = 0.55` as a constant with no evidence. Uncalibrated confidence does not fail loudly — it routes a Tamil caller into the **wrong branch** with high confidence instead of falling back, on a regulated collections call. EC5's stop condition (a failing language ships without a threshold, or does not ship) is the right instinct; honour it. And the corpus must be carrier-grade 8 kHz, so this risk sits downstream of Gate 0.
2. **Zero measured carrier-path latency.** Every number in the pitch is a target. One real outbound Indian call can invalidate the premise and is cheap to run.
3. **Provider substitution invalidates the POC's numbers and its voices.** No ElevenLabs plugin; Deepgram has no Tamil; Sarvam's declared TTFS p99 is 1,000 ms. If Tamil finalisation lands near a second at 8 kHz, 720 ms is gone regardless of anything OVO does. Needs vendor confirmation, not estimation.
4. **Losing the regex tier and speculation** removes the two mechanisms that made the POC _feel_ fast, and neither is in any spec. The thing these units build is not the thing you demoed.
5. **The P2/P3 rendered-text-identity seam is unowned.** P3's whole economy assumes byte-identical text; one normalization difference and every pre-render is wasted spend and every reply waits on TTS. P3's test 3 pins the invariant inside P3 only.
6. **No `route` producer after all three units** — your "which tier answered" is undelivered.
7. **Sidecar creep.** `IntentPolicy`'s 12 fields stand in for 14 contract gaps. Honestly flagged as a stopgap; stopgaps that ship become the schema. Decide now whether `intent-script.ts` gets widened next.
8. **No SMS/pay-link/disposition = a collections _conversation_ demo, not a collections POC.** If the CM pitch includes "we sent the link and they paid", that is unbuilt and unspecced.
9. **Operational:** process-local clip cache (N workers × generic set per deploy; a re-queued contact loses its clips); Postgres-only cost ledger; Exotel has **no fixture frame encoder** **[V]**, so Indian-carrier test calls fail `fixture_unavailable` while Twilio works.

## 7. What you must do that no amount of building substitutes for

1. **Authorize and execute the first real call** (prepared, Twilio inbound, forbidden pending you). Then authorize a **second**: outbound, Indian carrier, en-IN and ta-IN. The runbook does not cover that and the product is that.
2. **Choose the provider stack**, and accept it is not the POC's. ElevenLabs and `scribe_v2_realtime` do not exist in OVO. Sarvam vs Deepgram-plus-something, per language, with the latency that follows.
3. **Own the calibration corpus** — ≥300 labelled real-STT utterances per language is a data decision (whose voices, whose consent, which recordings) no builder can make for you. And own EC5: which languages ship with a threshold, which route to the LLM unconditionally, which do not ship.
4. **Settle P2 contract gap 10** — static `resumeAt` vs model-chosen resume. P2 chose static for sound safety reasons; it is a product behaviour change and it is yours.
5. **Decide H.2** (real provider voice inside a test call) with a dated board entry, or it ships `.skip` and test calls stay synthetic-tone.
6. **Decide whether the CM POC needs SMS, the pay link and the disposition log to count as a POC.** If yes, fund a fourth unit; none of the three covers it.
7. **Decide whether the demo is the POC or OVO.** The POC already demos today. Re-pointing it at a carrier is weeks. Rebuilding it on OVO is months, and buys persistence, barge-in, multi-tenancy, governance, DNC and honest cost. That is a strategy call, not an engineering one — and the three specs are good enough that it is the only question left open.

---

_Read-only: `git status --short` is empty in `/Users/tejassuds/work/ovo`; nothing was written outside this scratchpad. No vendor, carrier or provider endpoint was contacted._
