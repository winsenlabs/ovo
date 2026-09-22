# Unit board: plugin platform rebuild

This board is the single source of truth for unit status. The specs in this folder were generated from the design workflow and are self-contained. For shared contracts, tables and reasoning, see [`docs/architecture/plugin-platform.md`](../../docs/architecture/plugin-platform.md), and read §18 there for the resolved decisions. Roles and the check protocol are in [`PM/HANDOFF.md`](../HANDOFF.md).

## Statuses

| Status                 | Meaning                                                                                   | Set by       |
| ---------------------- | ----------------------------------------------------------------------------------------- | ------------ |
| Not started            | No work yet.                                                                              | —            |
| In progress            | Work has started but the unit is not complete.                                            | builder      |
| Built – awaiting check | Builder says the unit is complete and committed, with checks in the commit body.          | builder      |
| Changes requested      | Checker found blocking issues (listed below).                                             | checker      |
| **Verified `<sha>`**   | Checker independently confirmed scope, the green bar, acceptance, invariants and quality. | checker only |

## Wave 1 (sequential; each unit fully green)

| Unit                          | Title                                                                                   | Depends on | Defects            | Status                                                                                                                                                                                                                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------------- | ---------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [F1](F1-contracts-runtime.md) | Contracts v2 and host enforcement                                                       | —          | 10, 18, 19, 20, 22 | **Verified `da075a7`**. Checks: lint across 599 files, format, typecheck, 512 tests pass / 87 skipped, Postgres serial run 590 / 9 / 0, build.                                                                                                                          |
| [F2](F2-kits-gates.md)        | Shared kits (`plugin-kit`, `audio`, `conformance`) and hygiene gates                    | F1         | 12, 24, 27         | **In progress.** A partial exists in the tree and in `PM/handoff/f2-partial.patch`. At the pause, lint (7 gates), format and typecheck passed and 766 tests passed / 87 skipped. The acceptance list has not been checked and the Postgres serial run has not been run. |
| [F3](F3-host-seams.md)        | Host seams, selection storage and migrations, `session-host`, `distribution`, skeletons | F1, F2     | 1, 21, 27          | Not started                                                                                                                                                                                                                                                             |
| [F4](F4-apps-data-driven.md)  | API and worker made data-driven                                                         | F1–F3      | 1, 20, 21, 26      | Not started                                                                                                                                                                                                                                                             |

## Wave 2 (parallel; disjoint ownership per design §15.5)

| Unit                               | Title                                                         | Defects                  | Status      |
| ---------------------------------- | ------------------------------------------------------------- | ------------------------ | ----------- |
| [E1](E1-turns-vad.md)              | Turn detector and VAD plugins, Pipecat-style                  | 3, 18                    | Not started |
| [E2](E2-native-engine.md)          | OVO native engine rebuild                                     | 3, 4, 9, 26              | Not started |
| [E3](E3-livekit-engine.md)         | LiveKit Agents JS engine plugin                               | 4                        | Not started |
| [C1](C1-carrier-twilio.md)         | Twilio carrier plugin                                         | 1, 21, 26                | Not started |
| [C2](C2-gateway-router.md)         | Carrier-neutral gateway router                                | 1, 2, 23, 26, 27         | Not started |
| [C3](C3-carrier-exotel.md)         | Exotel carrier plugin                                         | 21                       | Not started |
| [C4](C4-carrier-plivo.md)          | Plivo carrier plugin                                          | 21, 26                   | Not started |
| [S1](S1-speech-split.md)           | Split out the Deepgram STT, OpenAI TTS and OpenAI LLM plugins | 21, 27                   | Not started |
| [S2](S2-speech-new.md)             | AssemblyAI STT and Sarvam STT/TTS                             | 9, 21                    | Not started |
| [O1](O1-fargate-scaling.md)        | Fargate-native autoscaling, Terraform, Fargate prep           | 7, 15, 17, 23            | Not started |
| [O2](O2-ops-ledger.md)             | Campaign driver, queue liveness, reservation expiry           | 5, 15, 16, 19            | Not started |
| [U1](U1-console.md)                | Console refactor                                              | 8, 15                    | Not started |
| [D1](D1-demo-backend.md)           | Fixture test calls and the demo backend                       | 19, 20                   | Not started |
| [M1](M1-misc-defects.md)           | Behaviors, tools and security defects                         | 6, 10–14, 18, 19, 24, 25 | Not started |
| [M2](M2-evaluations-decoupling.md) | Decouple the evaluations package from other plugins           | 19                       | Not started |

## Wave 3

| Unit                    | Title                                               | Status      |
| ----------------------- | --------------------------------------------------- | ----------- |
| [I1](I1-integration.md) | Integration, full verification, docs and PM updates | Not started |

## Carry-forward issues

These are minor findings that don't block their own unit. The owner resolves them no later than the unit named.

| From | Issue                                                                                                                                                                                                                                    | Resolve in |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| F1   | `packages/plugin-orchestration/src/types.ts` is 322 canonical lines, over the 300 target (the hard limit of 400 still passes).                                                                                                           | O1         |
| F1   | The guarded plugin context passes Cordis `inject`, `plugin` and accessors straight through to the raw context, so a plugin could bypass its declared `requires` and `provides`.                                                          | I1         |
| F1   | `parentReadableKeys` exposes only non-session parent keys, as §3.5 requires. However, `HOST_SESSION_SERVICES` includes three session-scoped keys (`ovo.media.duplex`, `ovo.usage-sink`, and one other). Confirm the session-host wiring. | F3         |
| F1   | Strict Ajv (without `allowUnionTypes`) cannot compile unions of primitive types such as `z.union([z.string(), z.number()])` in `definePluginV2` config schemas. Wave-2 authors must avoid that shape.                                    | all wave 2 |
| F1   | The `lockfileSha256` in `docs/research/dependency-licenses.json` is stale. No gate checks it.                                                                                                                                            | I1         |
| F1   | API release validation (`apps/api/src/release-runtime.ts`) still uses the synthetic `WORKER_VOICE_PORTS`. Switch it to `validateGraph` with host session services as parent keys.                                                        | F4         |
| F1   | The `classifyConfirmation` test table lacks the literal `'no that is not correct'` case. A manual check passed.                                                                                                                          | M1         |

## Changes requested

None open.
