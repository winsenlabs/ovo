# Current state

2026-10-04. Read `PM/HANDOFF.md` for roles and protocol, this for where things stand.

## Where we are

**Wave 2 is complete. All 15 units verified and merged to `main`** (merge commit `a82308c`, kept as
a merge rather than a squash so every `Verified <sha>` reference on the unit board still resolves).

Wave 1 (F1–F4) verified earlier. Wave 2: M2, U1, S1, E1, E2, D1, C2, C1, C4, S2, O1, O2, M1, E3, I1.

**Since Wave 2, on `vorflux/ovo-foundation`: the decision slot, P1, is built** — `963f306` (the
capability, the TypeSafe Jev plugin, the `decision@1` conformance kit) and `ce3321a` (per-agent
authoring, the console editor, the runtime gate with LLM fallback). See
`docs/architecture/decision-slot.md`.

Bar now: **2,268 passed / 216 database-gated skips (2,484), 0 failures** by default. Seven lint
gates, format, typecheck, frozen offline install and console E2E 41/41 all exit 0. The Wave 2
completion bar was 2,265 / 0 on a PostgreSQL serial run with all four database gates.

## What is proven

- **The plugin boundary.** One release config driven through the real native engine, the genuine
  `@livekit/agents@1.9.0` and a third synthetic engine, changing only `selections.engine.pluginId` —
  verified by instrumenting the real LiveKit prototypes. A 48-case matrix runs two production carrier
  ingresses (Twilio + Plivo) together through the production `selectSessionGraph`.
- **Safety, by construction.** No double-dial on campaigns. Fixture calls structurally unable to
  reach a carrier. Production refuses to start without a ≥32-byte session secret. Credential rotation
  safe under 8-way concurrency. Cross-tenant writes pinned by same-ID tenant tests. §4.10 termination
  ordering preserved even when the fence fails.
- **Test strength, measured not counted.** Mutation sweeps with committed tooling
  (`scripts/mutation-sweep.mjs`, `--kind=all|ts|sql --paths=…`).
- **A decision model can answer a turn without the LLM.** Driven through the real
  `selectSessionGraph` with the real native engine, the real Twilio ingress and real
  Deepgram/OpenAI providers; on the confident path the fixture LLM holds an empty wire script, so an
  inference request fails the call. The LLM is not merely unused, it is unreachable.

## What is NOT proven

**No decision confidence has been calibrated.** `calibrationVersion` is an identity, not a
measurement. The `decision@1` kit proves confidence _moves_; nothing proves it is _calibrated_. Every
threshold an operator sets is a judgement until real calls measure it. No TypeSafe endpoint has been
contacted, so Jev's `noul` shape is also unconfirmed: the published API documents no confidence on a
noul answer, and the adapter refuses to invent one.

**OVO has never handled a real phone call.** Call quality, latency, barge-in behaviour and actual
costs are unknown. Every figure in `docs/07-acceptance.md` is labelled a target to verify, not an
achievement. No vendor, carrier, paid provider or AWS endpoint has ever been contacted by this
codebase.

Also unverified: production rollout (Compose public routing, live operational drills), and the
Linux/glibc worker image under real load.

## Next action

**One founder-authorized inbound Twilio call**, following `docs/runbooks/first-real-call.md`.
Twilio only — C1 supplies a production ingress. Inbound only; OVO initiates no outbound dial in that
procedure. One call, then unconditional teardown.

The runbook is prepared and checker-reviewed. It has not been executed.

## Open, in dependency order

| #   | Item                                                                         | Size                                     |
| --- | ---------------------------------------------------------------------------- | ---------------------------------------- |
| 1   | The first inbound Twilio call                                                | founder-gated                            |
| 2   | Fix whatever it exposes                                                      | **unknowable until it runs**             |
| 3   | Six live console bugs in the test-call surface (no deps)                     | ~1 day — available now                   |
| 3b  | **A `knowledge` slot** — see below                                           | next unit                                |
| 4   | Second call: **outbound, Indian carrier, `ta-IN`**                           | blocked on Exotel vendor evidence        |
| 5   | Production rollout drills                                                    | unverified                               |
| 6   | Wave 3 — 6 dated obligations                                                 | small; only the SQL tenant sweep matters |
| 7   | Post-I1 roadmap — **P1 built**; P2, P3/P4 specced; handoff + correlation not | months                                   |
| 8   | Three **unspecced** units needed for a collections product                   | not written                              |
| 9   | C3 Exotel, C5 TCN, C6 Alohaa                                                 | held for vendor evidence                 |

### Grounding: there is no retrieval capability

An agent can be grounded in three things today, and none is a queryable knowledge base:

- **`faq[]`** (≤1000 entries) is matched by **token overlap** with stopword and negation handling
  (`packages/behaviors/src/faq.ts`). Lexical, not semantic: "how much do I owe" does not match "what
  is my outstanding" unless the alias is authored.
- **`context`** (≤100k chars) **throws** above `contextBudget` (12k default) — it is not truncated,
  chunked or queried, and the whole blob is pasted into every inference request. More knowledge
  fails publication rather than being retrieved.
- **A tool** with `connector: 'http' | 'mcp'` is the only real query path, and it works — but the
  knowledge lives outside OVO: no chunking, no citations, no freshness, no cost accounting on
  retrieval, and the LLM decides when to call it.

`Cap` has ~70 keys and none is retrieval; there are no embeddings anywhere in the repository. This
also bounds the decision slot: `DecisionRequest.state` is all a decision model sees, so a decision
cannot be grounded in anything the runtime cannot retrieve. The two slots are coupled.

### Item 8, stated plainly

The post-I1 specs cover the conversation model, not the product. Still unwritten:

- **Effects**: SMS, the pay link, the paid-state callback, and the business disposition log.
  19 of 34 CreditMantri nodes write a disposition; `CallOutcome` has no slot for
  `promise_to_pay:tomorrow`. `grep -i '\bsms\b' packages/contracts/src` returns nothing.
- **The speculation engine**: decision-on-partials and the abort-accounted parallel LLM.
- **The filler clip and two-phase turn.** Without it a tier-3 LLM fallback is _silent_ for the whole
  round trip. This is the most audible regression against the POC.
- **The `route` producer** — which tier answered a turn. It falls between P2 and P4 and is produced
  by neither, so the console's tier column reads `—`.

### Held carriers

C3 Exotel (authenticated 16 kHz wire format: three-parameter limit vs `sample-rate=16000`),
C5 TCN (no accessible media/signing/control contract), C6 Alohaa (streaming and dial documented,
callback signing unconfirmed). The skeleton gate accepts only these three named, dated exemptions —
an unlisted skeleton or a stale exemption fails the gate.

**Do not settle these by inferring from documentation.** C1 succeeded because the genuine Twilio SDK
was installable as an oracle, and it caught C1's own port-handling bug.

## Branches

- `main` — everything through Wave 2.
- `vorflux/ovo-foundation` — working branch. `main` has an owners-only ruleset, so work lands here
  and reaches `main` by PR.
- `w2/C3` — **held, 2 unmerged commits.** The approved Exotel kit and API fixes. Do not delete.

## The open strategic question

Is the demo the CreditMantri POC, or OVO? The POC demos today. Re-pointing it at a carrier is weeks.
Rebuilding it on OVO is months, and buys persistence, barge-in, multi-tenancy, governance, DNC
enforcement and honest cost accounting. That is a product decision, not an engineering one.
See `PM/units/post-i1-feasibility.md`.
