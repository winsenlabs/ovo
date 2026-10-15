# Third-party notices

OVO includes portions of DeepSeek Harness at `ddefc45fbc7f8e46dd73185e68295696d1297887`.

- DeepSeek copyright and MIT terms: `packages/runtime/src/upstream/LICENSE`.
- Cordis copyright and MIT terms: `vendor/cordis/LICENSE`.
- Cosmokit copyright and MIT terms: `vendor/cosmokit/LICENSE`.
- Imported source and modifications: `docs/research/deepseek-import-map.md`.
- DeepSeek's Cordis/Cosmokit original upstream pins and patch history: `vendor/DEEPSEEK-VENDOR-NOTES.md`.

Retain these notices and license files in distributions. Dependencies retain their original package names and licenses in the lockfile/package installation. No first-party package is authorized for publication. OVO's project license remains a separate decision.

## LiveKit engine dependency closure

The optional LiveKit engine executes `@livekit/agents@1.9.0` (Apache-2.0) and uses `@livekit/rtc-node` (Apache-2.0). The installed native closure includes `@livekit/av` (package Apache-2.0; platform binary `@livekit/av-darwin-arm64` LGPL-2.1-or-later), `sharp` (Apache-2.0) and its `@img/sharp-libvips-*` native library (LGPL-3.0-or-later). `@livekit/local-inference` is present transitively with `Apache-2.0 AND LicenseRef-LiveKit-Model`; OVO's LiveKit adapter does not configure or load a local model. The exact package and platform records are in `docs/research/dependency-licenses.json`; Linux image/SBOM review remains a deployment gate.

E1 and E2 implemented Pipecat-style scheduling ideas in OVO TypeScript; no Pipecat source was ported line by line and there is no Pipecat runtime dependency. Add its BSD-2-Clause notice if that changes.

## End-of-turn model runtimes (Wave 13)

`packages/plugin-turn-detector-smart-turn` runs the Smart Turn v3.2 model (BSD-2-Clause, Copyright (c) 2024-2025 Daily) through `onnxruntime-node@1.30.0` (MIT). The weights are not stored in git: `packages/plugin-turn-detector-smart-turn/scripts/fetch-model.mjs` downloads them at build time at a pinned revision and checks their SHA-256. Retain the BSD-2-Clause notice wherever the weights ship.

`packages/plugin-turn-detector-livekit` runs LiveKit's end-of-turn models through `@livekit/agents` and `@livekit/local-inference` (Apache-2.0); the model weights are under the LiveKit Model License, which permits use only with the LiveKit Agents framework. It is a bake-off runtime only and is not registered in any distribution. Its dev-only text model pulls `@huggingface/transformers@4.2.0` (Apache-2.0) and, through it, `sharp`'s libvips binaries (LGPL-3.0-or-later).

## Room server and SDKs for the operator desk (Wave 17)

The OVO-managed human queue runs on a self-hosted **LiveKit server** (`livekit/livekit-server`, tag `v1.13.9`, Apache-2.0; Copyright LiveKit, Inc.). It is run as a separate container (Compose profile `livekit`) from the upstream image and is not modified or redistributed by OVO; retain its licence notice with any image you republish. `packages/plugin-room-livekit` uses `@livekit/rtc-node@0.13.34` (Apache-2.0; native bindings per platform) and `livekit-server-sdk@2.19.0` (Apache-2.0, which pulls `@livekit/protocol` and `jose`); `packages/ui` uses the browser SDK `livekit-client@2.22.3` (Apache-2.0, with `@livekit/mutex`, `@livekit/protocol`, `loglevel`, `machina`, `rxjs`, `sdp-transform` and the `@types/dom-mediacapture-record` types). Unlike the end-of-turn models above, none of these packages carries the LiveKit Model License. `rtc-node`'s native closure is the same one the LiveKit engine already pulls (Linux image review remains a deployment gate). The exact records are in `docs/research/dependency-licenses.json`.
