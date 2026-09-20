# Upstream source map

Source inspection date: 2026-09-20. These are inspected immutable trees, not claims of executed integration tests.

| System            | Immutable pin                                                                                       | License       | Evidence                                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| DeepSeek Harness  | `ddefc45fbc7f8e46dd73185e68295696d1297887`                                                          | MIT           | [Import map](deepseek-import-map.md), [source](https://github.com/deepseek-ai/deepseek-harness/tree/ddefc45fbc7f8e46dd73185e68295696d1297887) |
| Cordis            | DeepSeek vendor release `4.0.2`, inherited Cordis commit `56b3d4f725681cf4556c1a8695a709cc3b6eed74` | MIT           | [Retained vendor history](../../vendor/DEEPSEEK-VENDOR-NOTES.md); byte hashes checked locally                                                 |
| Pipecat           | `dbdf21a017f86624fb7768e35730417169524e0d`                                                          | BSD-2-Clause  | [Source/tests/dependencies](voice-upstreams.md#1-pipecat-behavioral-reference-not-a-typescript-dependency)                                    |
| LiveKit Agents JS | `5287be114b12fb16f0a3eb6ccca4173e6e3eb219`, package `1.9.0`                                         | Apache-2.0    | [Source/tests/dependencies](voice-upstreams.md#2-livekit-agents-js-complete-typescript-candidate-with-livekit-io-coupling)                    |
| Vercel AI SDK     | `20dd00abba618d5a516e0fee40ccd3e18a2bd1fb`, package `7.0.107`                                       | Apache-2.0    | [Source/tests/dependencies](voice-upstreams.md#3-vercel-ai-sdk-inferencetool-loop-option-not-voice-transport)                                 |
| Twilio / AWS      | Official hosted docs, accessed 2026-09-20; not immutable source                                     | External APIs | [Carrier capabilities](provider-capabilities.md), [deployment feasibility](deployment-feasibility.md)                                         |

## Dependency closure and notices

Cordis and Cosmokit source are vendored from DeepSeek, not substituted from an unrelated Cordis release. Scope, profile patch composition and child lifecycle code retain the DeepSeek license. Other adapters use pinned npm packages with lockfile integrity hashes. Final dependency/license inventory is generated after installation. An installed SDK is not a verified service integration.

DeepSeek's full model/session/tools packages were inspected but are not mounted: the text-agent loop commits generated rather than played speech and would create a second tool execution owner. OVO's voice loop is itself an ordinary plugin under the imported foundation.
