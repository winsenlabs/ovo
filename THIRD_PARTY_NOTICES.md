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
