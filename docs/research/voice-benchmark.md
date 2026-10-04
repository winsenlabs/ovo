# Voice comparison benchmark

Status: bounded local component/API viability results; not an end-to-end latency or production-selection claim  
Captured: 2026-09-20T13:40:40.417Z

## Protocol

```sh
pnpm --filter @winsendotai/ovo-voice-experiments benchmark
```

The benchmark separates two scopes that were previously mixed:

- **Hot path:** one long-lived OVO composition per candidate, three warmups, then 30 FAQ and 10 interrupted-tool samples. Composition/session setup and disposal are outside the measured interval. LiveKit reuses one real `AgentSession`; focused OVO reuses one production-plugin composition.
- **Cold lifecycle:** 10 independent samples per candidate. Every interval includes construction of the candidate composition, one FAQ call, and full disposal. This is reported separately and never folded into hot-path percentiles.

`performance.now()` measured complete scenario calls. There were no network, model-provider, local-inference/model, audio-device, room, or carrier calls. LiveKit passed `vad: null` and disabled turn detection. Focused OVO used actual behavior, voice scheduler, AI SDK inference, agent behavior, shared execution, and native connector packages, but its operation store and speech output were explicit in-memory/simulated fixtures.

Raw evidence is preserved at `experiments/voice/results/raw-2026-09-20T13-40-40-417Z.json`. It retains every duration and failure slot, environment, protocol, source identity, model request count, tool attempt count, tool owner, stale playback count, operation state, local-model controls, and transitive-license notices. The runner hashes source and lockfile both before and after sampling and refuses to write evidence if they change during the run. This run retained 100 actual samples: all 100 passed and zero failed. Earlier development runs remain beside it and are not used in the tables below.

## Implementation identity

The working tree was dirty, so the base revision is not treated as the implementation identity.

| Field                            | Value                                                                 |
| -------------------------------- | --------------------------------------------------------------------- |
| Git branch / base HEAD           | `vorflux/ovo-foundation` / `cf7dc6f6c4f901664b902b556b54f413747037fc` |
| Git dirty                        | `true`                                                                |
| Experiment source SHA-256        | `b3542ccf61a5404eb1fa6cf7e46b498ecfc3a4881173e584470ddb3448a29abf`    |
| Runtime source SHA-256           | `c81e4df765563491dc01b722c5023b49078824d9877d90dd1742cde433d27037`    |
| Focused component source SHA-256 | `6b844e4bb5db855ddc0c95299cd9ed5d2bbab415dc08418c0423b55a35f22118`    |
| `pnpm-lock.yaml` SHA-256         | `38371bd69606e14121e78e0a056bff2f868a1395beb2c1c4983f9cc779639dbb`    |

The experiment hash covers `experiments/voice` except generated results and installed modules. Runtime covers `packages/runtime`. Focused components cover `packages/contracts`, `packages/behaviors`, `packages/plugin-inference`, `packages/plugin-tools`, and `packages/plugin-voice`.

## Environment

| Field                 | Value                                                                      |
| --------------------- | -------------------------------------------------------------------------- |
| Node.js               | `v22.21.0`                                                                 |
| OS                    | Linux `7.0.0-1009-aws`, x64                                                |
| CPU                   | 4 logical CPUs, Intel Xeon 6975P-C                                         |
| Memory at capture     | 16,464,347,136 bytes total; 12,794,671,104 bytes free                      |
| LiveKit               | `@livekit/agents@1.9.0`, source `5287be114b12fb16f0a3eb6ccca4173e6e3eb219` |
| Focused inference SDK | `ai@7.0.107`, source `20dd00abba618d5a516e0fee40ccd3e18a2bd1fb`            |

## Matched long-lived hot path

All figures are milliseconds. Percentiles use inclusive interpolation over retained samples.

| Candidate                       | Scenario         | Samples | Passed | Failed |   Min | Median |  Mean |   p95 |   Max |
| ------------------------------- | ---------------- | ------: | -----: | -----: | ----: | -----: | ----: | ----: | ----: |
| Focused OVO production packages | no-LLM FAQ       |      30 |     30 |      0 | 0.022 |  0.029 | 0.122 | 0.156 | 2.342 |
| LiveKit `AgentSession`          | no-LLM FAQ       |      30 |     30 |      0 | 0.115 |  0.302 | 0.300 | 0.545 | 0.726 |
| Focused OVO production packages | interrupted tool |      10 |     10 |      0 | 0.704 |  1.167 | 1.141 | 1.624 | 1.850 |
| LiveKit `AgentSession`          | interrupted tool |      10 |     10 |      0 | 1.283 |  2.586 | 2.493 | 3.058 | 3.137 |

These are local text/control-plane fixture costs, not speech latency. They exclude audio generation, transport, provider latency, and setup/disposal. The run occurred on a shared host with other repository processes active; the visible tail latency reinforces that the small samples and deterministic mocks are suitable only for bounded regression/API comparisons.

## Separate cold lifecycle

Each cold sample includes fresh composition, one FAQ call, and disposal.

| Candidate                       | Samples | Passed | Failed |     Min |  Median |    Mean |     p95 |     Max |
| ------------------------------- | ------: | -----: | -----: | ------: | ------: | ------: | ------: | ------: |
| Focused OVO production packages |      10 |     10 |      0 |  14.985 |  18.755 |  19.309 |  24.900 |  25.224 |
| LiveKit `AgentSession`          |      10 |     10 |      0 | 507.813 | 508.332 | 508.776 | 510.722 | 511.032 |

The cold candidates perform different setup work: focused OVO composes eight production/fixture plugins, while LiveKit starts and closes an AgentSession whose close path contributes roughly 500 ms in this no-audio fixture. This table describes each current candidate's local lifecycle envelope; it is not a normalized engine comparison.

## Correctness observations

| Candidate                       | FAQ model requests | Tool model requests/sample | Tool attempts/sample | Operation evidence                                        | Stale playback |
| ------------------------------- | -----------------: | -------------------------: | -------------------: | --------------------------------------------------------- | -------------: |
| Focused OVO production packages |                  0 |                          1 |                    1 | canceled read settled `failed` in experiment memory store |              0 |
| LiveKit `AgentSession`          |                  0 |                          1 |                    1 | canceled read settled `failed` at controlled boundary     |              0 |

The companion Vitest fixture ran 8 tests successfully. It checks real composition, production focused-package binding, no-LLM FAQ behavior, one tool execution owner, acknowledgment/takeover/canceled-read settlement ordering, stale output suppression, idempotent disposal, and LiveKit AgentSession reuse across hot calls. In all 20 interrupted-tool samples, caller takeover canceled the already-started read, the terminal operation state was honestly observed as `failed`, and no stale playback completed.

The focused ownership chain is AI SDK tool selection without an execute handler → production `AgentBehavior` → shared `Execution` → one approved native connector. The LiveKit ownership chain is AgentSession → one tool handler → one controlled boundary. Neither chain double-executes the tool.

## Viability conclusion and remaining gates

Both candidate APIs are viable for these deterministic local fixtures. The matched hot path removes the prior per-sample LiveKit close bias, and the separate cold table preserves lifecycle data without contaminating hot percentiles. This supports only local component/API viability; it does not select an audio stack or production engine.

Before any production selection:

1. Drive matched actual audio through STT, VAD, TTS, output flush, and interruption; retain first-audio and confirmed-playback timestamps.
2. Exercise carrier/WebRTC transport, reconnects, packet loss, jitter, backpressure, and slow consumers.
3. Replace the experiment memory store with the production durable operation store and test crash/restart reconciliation; current results prove no durability.
4. Validate real provider usage accounting, cancellation billing, tool error semantics, and shutdown under load.
5. Run matched concurrency and soak tests with retained traces and explicit failure counts.
6. Complete distribution review for LiveKit's `LicenseRef-LiveKit-Model` local-inference package and LGPL-2.1-or-later platform FFmpeg package; never move LiveKit model weights or their outputs into focused OVO.

Until those gates are matched, there is no final production component or engine recommendation.
