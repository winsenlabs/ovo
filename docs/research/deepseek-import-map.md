# DeepSeek import map

Audit: 2026-09-20. Pin: `ddefc45fbc7f8e46dd73185e68295696d1297887` from https://github.com/deepseek-ai/deepseek-harness.

| Upstream path                                                   | OVO path                                             | Method and modifications                                                                                                                                                                                                         | License/tests                                                                             |
| --------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `vendor/cordis/src/**`                                          | `vendor/cordis/src/**`                               | Exact source extraction, including DeepSeek's reentrant teardown and effect hardening. Manifest becomes private with source runtime and generated declaration exports.                                                           | MIT notice retained. Scope and OVO conformance tests exercise this implementation.        |
| `vendor/cosmokit/src/**`                                        | `vendor/cosmokit/src/**`                             | Exact dependency closure for Cordis. Private manifest/exports adapted.                                                                                                                                                           | MIT notice retained.                                                                      |
| `packages/core/scope/src/index.ts`, `store.ts`                  | `packages/runtime/src/upstream/scope.ts`, `store.ts` | Entire scoped registration implementation. Rename index and its relative imports only.                                                                                                                                           | DeepSeek MIT retained; `scope.spec.ts` and `store.spec.ts` retained with import rewrites. |
| `vendor/include/src/index.ts:applyEntryPatches`, `PatchOptions` | `packages/runtime/src/upstream/composition.ts`       | Extract pure patch algorithm. Local structural EntryOptions avoids filesystem Loader dependency. Omit executable YAML, file writing and auto-install capabilities.                                                               | DeepSeek MIT + Cordis notice retained. OVO composition fixtures.                          |
| `packages/boot/app-boot/src/profile.ts:composeEntries`          | same composition file                                | Exact function extracted to compose ordered release layers over an empty tree.                                                                                                                                                   | DeepSeek MIT; layer replacement fixtures.                                                 |
| `packages/extensions/cordis-host-runner/src/lifecycle.ts`       | `packages/runtime/src/upstream/lifecycle.ts`         | Reuse awaited child-fiber start, failed-start disposal and missing-services inspection. Replace sandbox guard with operator-approved plugin validation and explicit configuration. Dynamic model-installed plugins are excluded. | DeepSeek MIT; rollback/cleanup fixtures.                                                  |

[Machine-readable source hashes](deepseek-source-lock.json) pin byte-identical vendor sources. [Upstream vendor notes](../../vendor/DEEPSEEK-VENDOR-NOTES.md) retain DeepSeek's own upstream pins and changes. Cordis package release 4.0.2 derives from Cordis 4.0.0-rc.7 at `56b3d4f725681cf4556c1a8695a709cc3b6eed74`; Cosmokit release 1.8.3 derives from 1.8.1 at `16f6fc058ade66e8ac5da0033d35a8d0f279f544`.

## Why extraction

The public package versions exist on npm. Source extraction binds OVO to the inspected commit and preserves DeepSeek's framework patches. Full app-boot imports profile package installation, executable YAML, shell/coding runtime and product-specific home management. Those capabilities do not belong in the voice worker. OVO imports the coherent in-process composition/scope/lifecycle closure instead. Cordis alone would not satisfy this requirement: actual DeepSeek profile and scope functions own OVO composition and disposal.

## Audited but excluded

DeepSeek `core/agent-loop` owns text-agent continuation and commits generated model history. It is not playback-aware and would compete with the OVO voice engine. `core/tools` depends on DeepSeek agent/LLM/session vocabulary; its policy events informed the shared tool contract, but its executor is not mounted. `mcp/mcp-client` has broader process/profile capabilities. OVO uses the official MCP client through a constrained connector. No copied coding tools or executable-plugin installer enters OVO.

## Upgrade process

1. Fetch a new immutable upstream commit into a separate checkout; inspect license, manifests, vendor patch log and source diff.
2. Compare the source-lock map and re-extract the same closure. Record every adaptation and change the pin atomically.
3. Retain upstream scope/store tests. Run local `pnpm check` plus comparative fixture tests.
4. Verify startup rollback, repeated disposal, scoped events, release pinning, all four modes, no-model paths, late-output rejection and tool-state durability.
5. Rerun affected carrier/provider certification before promoting a new release. Existing calls keep their old composition.
6. Reject an upgrade when required tests fail. Do not silently substitute upstream Cordis for the DeepSeek-patched implementation.

OVO's own project license remains undecided. Packages are private and publication is not authorized.
