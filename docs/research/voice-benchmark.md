# Voice comparison benchmark

Status: bounded local component/API viability results; not an end-to-end latency or production-selection claim  
Captured: 2026-09-20T12:59:57.495Z

## Protocol

```sh
pnpm --filter @winsendotai/ovo-voice-experiments benchmark
```

The benchmark separates two scopes that were previously mixed:

- **Hot path:** one long-lived OVO composition per candidate, three warmups, then 30 FAQ and 10 interrupted-tool samples. Composition/session setup and disposal are outside the measured interval. LiveKit reuses one real `AgentSession`; focused OVO reuses one production-plugin composition.
- **Cold lifecycle:** 10 independent samples per candidate. Every interval includes construction of the candidate composition, one FAQ call, and full disposal. This is reported separately and never folded into hot-path percentiles.

`performance.now()` measured complete scenario calls. There were no network, model-provider, local-inference/model, audio-device, room, or carrier calls. LiveKit passed `vad: null` and disabled turn detection. Focused OVO used actual behavior, voice scheduler, AI SDK inference, agent behavior, shared execution, and native connector packages, but its operation store and speech output were explicit in-memory/simulated fixtures.

Raw evidence is preserved at `experiments/voice/results/raw-2026-09-20T12-59-57-495Z.json`. It retains every duration and failure slot, environment, protocol, source identity, model request count, tool attempt count, tool owner, stale playback count, operation state, local-model controls, and transitive-license notices. The runner hashes source and lockfile both before and after sampling and refuses to write evidence if they change during the run. Earlier development runs remain beside it and are not used in the tables below.

## Implementation identity

The working tree was dirty, so the base revision is not treated as the implementation identity.

| Field                            | Value                                                                 |
| -------------------------------- | --------------------------------------------------------------------- |
| Git branch / base HEAD           | `vorflux/ovo-foundation` / `94d674f5836d8905dd64399f4cc516b3229f8b14` |
| Git dirty                        | `true`                                                                |
| Experiment source SHA-256        | `478cca26a6b7e8346f81a1282d171d9e19a78582fed4ca9b8cbc4390b3d1e838`    |
| Runtime source SHA-256           | `c81e4df765563491dc01b722c5023b49078824d9877d90dd1742cde433d27037`    |
| Focused component source SHA-256 | `be80e3794b761c1746b9f8c787e426c4550eff8ef713820c676f602b3fd42633`    |
| `pnpm-lock.yaml` SHA-256         | `141bbf68b3975550236a46bb658d3b7a538877dfe032ce9472533e7f18ca371b`    |

The experiment hash covers `experiments/voice` except generated results and installed modules. Runtime covers `packages/runtime`. Focused components cover `packages/contracts`, `packages/behaviors`, `packages/plugin-inference`, `packages/plugin-tools`, and `packages/plugin-voice`.

## Environment

| Field                 | Value                                                                      |
| --------------------- | -------------------------------------------------------------------------- |
| Node.js               | `v22.21.0`                                                                 |
| OS                    | Linux `7.0.0-1009-aws`, x64                                                |
| CPU                   | 4 logical CPUs, Intel Xeon 6975P-C                                         |
| Memory at capture     | 16,464,347,136 bytes total; 12,816,822,272 bytes free                      |
| LiveKit               | `@livekit/agents@1.9.0`, source `5287be114b12fb16f0a3eb6ccca4173e6e3eb219` |
| Focused inference SDK | `ai@7.0.107`, source `20dd00abba618d5a516e0fee40ccd3e18a2bd1fb`            |

## Matched long-lived hot path

All figures are milliseconds. Percentiles use inclusive interpolation over retained samples.

| Candidate                       | Scenario         | Samples | Passed | Failed |   Min | Median |  Mean |   p95 |    Max |
| ------------------------------- | ---------------- | ------: | -----: | -----: | ----: | -----: | ----: | ----: | -----: |
| Focused OVO production packages | no-LLM FAQ       |      30 |     30 |      0 | 0.031 |  0.035 | 0.060 | 0.173 |  0.234 |
| LiveKit `AgentSession`          | no-LLM FAQ       |      30 |     30 |      0 | 0.246 |  0.412 | 1.243 | 3.033 | 15.307 |
| Focused OVO production packages | interrupted tool |      10 |     10 |      0 | 0.928 |  1.944 | 2.940 | 7.096 |  9.733 |
| LiveKit `AgentSession`          | interrupted tool |      10 |     10 |      0 | 2.988 |  6.550 | 6.182 | 9.241 |  9.242 |

These are local text/control-plane fixture costs, not speech latency. They exclude audio generation, transport, provider latency, and setup/disposal. The run occurred on a shared host with other repository processes active; the visible tail latency reinforces that the small samples and deterministic mocks are suitable only for bounded regression/API comparisons.

## Separate cold lifecycle

Each cold sample includes fresh composition, one FAQ call, and disposal.

| Candidate                       | Samples | Passed | Failed |     Min |  Median |    Mean |     p95 |     Max |
| ------------------------------- | ------: | -----: | -----: | ------: | ------: | ------: | ------: | ------: |
| Focused OVO production packages |      10 |     10 |      0 |  27.299 |  50.023 |  51.298 |  81.565 |  91.162 |
| LiveKit `AgentSession`          |      10 |     10 |      0 | 507.940 | 515.160 | 521.246 | 548.760 | 553.790 |

The cold candidates perform different setup work: focused OVO composes eight production/fixture plugins, while LiveKit starts and closes an AgentSession whose close path contributes roughly 500 ms in this no-audio fixture. This table describes each current candidate's local lifecycle envelope; it is not a normalized engine comparison.

## Correctness observations

| Candidate                       | FAQ model requests | Tool model requests/sample | Tool attempts/sample | Operation evidence                    | Stale playback |
| ------------------------------- | -----------------: | -------------------------: | -------------------: | ------------------------------------- | -------------: |
| Focused OVO production packages |                  0 |                          1 |                    1 | succeeded in experiment memory store  |              0 |
| LiveKit `AgentSession`          |                  0 |                          1 |                    1 | simulated controlled boundary settled |              0 |

The companion Vitest fixture ran 8 tests successfully. It checks real composition, production focused-package binding, no-LLM FAQ behavior, one tool execution owner, acknowledgment/takeover/settlement ordering, stale output suppression, idempotent disposal, and LiveKit AgentSession reuse across hot calls.

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
