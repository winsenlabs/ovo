# ADR 0001: DeepSeek-derived plugin foundation and provisional voice engines

Date: 2026-09-20. Status: **foundation accepted by fixed product requirement; voice selection provisional**.

## Evidence

The repository initially contained only specifications. DeepSeek Harness commit `ddefc45fbc7f8e46dd73185e68295696d1297887` provides the actual Cordis integration, profile patch composition, scoped registrations and awaited disposal required by OVO. Its vendored Cordis contains important lifecycle changes absent from the original base commit. See [import map](../research/deepseek-import-map.md).

## Decision

Extract the inspected Cordis/Cosmokit source closure, scope/store, profile composition and child-fiber lifecycle. OVO's minimal wrapper validates approved manifests/configuration and dependency graphs before mounting through those functions. It owns no model, speech, database, tools or business behavior. Every application capability remains a Cordis plugin with an explicit manifest.

Exclude dynamic package installation, executable YAML, coding tools, shell, desktop and upstream text-agent loop. Approved artifacts ship with the application. User configuration may select installed capabilities but cannot install code. Immutable compositions pin existing sessions while new calls select new releases.

Compare a focused voice plugin with an actual LiveKit Agents JS adapter under the same host. Pipecat supplies behavioral references, not a hidden Python runtime. Vercel AI SDK may normalize provider inference, but never runs a competing tool executor. The OVO execution layer alone authorizes and records business operations.

## Consequences and gates

OVO maintains an explicit extraction patch log and upgrade checks. The imported code is not cosmetic: it executes composition and owns scoped cleanup. Retained upstream scope/store tests run locally. Partial-init rollback, pinned replacement and repeated disposal receive OVO tests.

No production voice engine is certified by this ADR. Comparative traces, real provider cancellation, carrier playback and Fargate media routing remain gates. A local deterministic simulation cannot close those gates.
