# LiveKit engine

Pinned to `@livekit/agents@1.9.0` and `@livekit/rtc-node@0.13.34`. The production
index registers an engine and its late-bound speech companion without importing
LiveKit. Selecting the engine lazily loads the native runner. The runner uses no
room, LiveKit LLM, tool executor, inference model, or downloaded model.

OVO STT and TTS own provider requests and usage. Audio is mono 8 kHz μ-law or PCM16;
the host owns resampling. Every spoken segment uses `AgentSession.say`, then a
carrier mark, and delivers the exact-text receipt to Behavior before another
turn. Unacknowledged or timed-out playback is estimated. Clearing invalidates
pending mark correlation before the carrier can echo flushed marks.

## Pinned API adaptations

- LiveKit 1.9.0 `agent_activity.ts:2975–2981` skips completed user turns while a
  non-interruptible speech is active. Setting `allowInterruptions: false` alone
  does **not** preserve a one-word confirmation. The STT adapter buffers up to 256
  provider events during confirmation, then forwards them through the real
  LiveKit SpeechStream after `Behavior.onPlayback` and handle completion.
  Disclosure input is discarded. Overflow closes the session with an error.
- LiveKit constructs an empty `ToolContext` even when no tools are supplied.
  Guards require that it remain empty; every nonempty tool context is refused.
- The Web `ReadableStream` type and Node's vendored declaration differ in BYOB
  generic parameters. The input boundary uses a structural type adapter; the
  actual stream is the standard Node global stream, with a bounded 250-frame
  queue. No Node network APIs are imported by the plugin.
- Provider cancellation occurs directly at disposal, before waiting on SDK
  teardown, so native shutdown cannot defer OVO usage settlement.

## Native image and license handoff to I1

All Docker stages use `node:24.8.0-bookworm-slim`. API, worker, gateway and
dispatcher builds externalize `@livekit/*`, `sharp`, and `onnxruntime-node`; their production dependencies must
be shipped by `pnpm deploy` through distribution → this package. The CJS worker
build flags were exercised with the actual lazy runner and offline carrier audio
on Node 22 (which supports `require(esm)`), without changing the worker format.

Transitive license inventory for I1's image/SBOM/release review:

| Dependency                                   | License and responsibility                                                                                                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@livekit/av@10.0.0`                         | JS resolver Apache-2.0; bundled FFmpeg binaries LGPL-2.1-or-later. Preserve upstream NOTICE and corresponding-source offer obligations in shipped images.                        |
| `sharp@0.35.4` / libvips                     | sharp Apache-2.0; libvips LGPL-2.1-or-later. Preserve the native distribution notices.                                                                                           |
| `@livekit/local-inference@0.2.7`             | Declares `Apache-2.0 AND LicenseRef-LiveKit-Model`. No inference model is constructed/downloaded here; I1 must inventory any separately distributed model assets before release. |
| `@livekit/rtc-node@0.13.34` and Agents 1.9.0 | Pinned native/runtime packages; keep platform-specific bindings in the deploy artifact.                                                                                          |

Offline `pnpm --offline --filter @winsendotai/ovo-worker deploy --prod --legacy`
was attempted. It failed with `ERR_PNPM_NO_OFFLINE_META` for the root workspace's
`prettier@3.9.8`; downloaded count was zero. Native deployment packaging remains
an I1 verification item. No installation or network fallback was attempted.

## WIP verification — 2026-09-26

All commands ran in this worktree with
`PATH=/opt/homebrew/opt/node@22/bin:$PATH` (Node 22.23.2).

| Command                                                                                         | Exit and measured result                                      |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `node scripts/lint.mjs --only packages/plugin-engine-livekit infra/container scripts/build.mjs` | 0; all seven gates, largest source module 197 canonical lines |
| `node scripts/typecheck-scope.mjs packages/plugin-engine-livekit`                               | 0                                                             |
| `pnpm typecheck`                                                                                | 0, including console                                          |
| `pnpm format:check`                                                                             | 0                                                             |
| `node scripts/check-duplication.mjs`                                                            | 0; existing stale-baseline warnings only                      |
| `pnpm exec vitest run packages/plugin-engine-livekit --reporter=dot`                            | 1; 42 passed, 2 failed, 0 skipped across 11 files             |
| `pnpm exec vitest run --reporter=dot`                                                           | 1; 1,190 passed, 2 failed, 138 skipped, 1,330 total           |
| `pnpm build`                                                                                    | 0, including worker/API/dispatcher and console                |
| `pnpm --filter @winsendotai/ovo-media-gateway build`                                            | 0 after the independently reproduced native-bundle failure    |
| `git diff --check`                                                                              | 0                                                             |

The two current failures are explicit: the frozen FAQ kit observes generated text
before actual carrier audio, and the real production `AgentBehavior` lacks M1's
pending exact-prompt classification. Neither test is skipped. An independent
review ran the other 43 checks successfully; its combined E3 + pending M1 probe
observed zero write executions before the carrier acknowledgement and one after.
No PostgreSQL paths changed; no PostgreSQL suite was run for this unit.

### True negatives

Each probe below ran against the broken version. Temporary mutations were
restored; the production confirmation dependency remains red on this foundation.

| Broken version or mutation                                    | Observed failure                                                                                                                         |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Original empty `index.ts` inventory at the foundation         | Expected the engine and companion IDs, received `[]`                                                                                     |
| `media.clear()` before pending-mark cancellation              | Expected interrupted/estimated, received completed/confirmed from the flushed mark                                                       |
| Worker native externals removed                               | esbuild: `No loader is configured for .node files`                                                                                       |
| Original gateway build flags                                  | Same actual native `.node` bundle error                                                                                                  |
| Confirmation without the owned STT-event buffer               | `timed out waiting for the confirmed write` (21/22 kit checks passed)                                                                    |
| Inference guard using `/Inference/` against constructor names | Expected a throw for actual inference prototypes named STT/TTS/VAD; no throw occurred                                                    |
| Adapter without final segment-ID deduplication                | Expected `book Friday`, received `book Friday book Friday`                                                                               |
| Shared teardown IIFE when media.close throws synchronously    | Expected Behavior.cancel once, received zero; reviewer also observed post-dispose ingress accepted                                       |
| Unisolated end observer                                       | dispose rejected with `broken observer`                                                                                                  |
| Unisolated unsubscribe callback                               | dispose rejected with `broken unsubscribe`                                                                                               |
| Current foundation real AgentBehavior at prompt tail          | Expected one confirmed write execution after acknowledgement, received zero; pending M1 implementation passes the same independent probe |

The lifecycle regression file ran red 4/4, then green 4/4. The pinned no-room
spike, lazy import fence, real distribution composition, carrier receipt tests,
and CJS native/audio smoke all execute under the egress sentinel. No vendor,
LiveKit room, paid model, network fallback, or model download was used.
