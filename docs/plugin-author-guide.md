# Plugin author guide: manifest v2

OVO loads approved, deployed code. Agent configuration selects installed plugins and provider bindings; it cannot install packages or execute scripts. The binding design and capability contracts are in [plugin-platform.md](architecture/plugin-platform.md).

## Define the plugin

`packages/plugin-example` is the small v2 reference. It depends on `@winsendotai/ovo-sdk` and `zod`, declares a session-scoped behavior, validates a strict config, provides its capability and disposes it through `ctx.effect`. A typical entry exports `plugins = [myPlugin]` so the distribution loader can collect it. Register an approved first-party package in `packages/distribution/src/catalog.ts` with its package name, roles and `load()` line; external packages enter through the operator-controlled `OVO_PLUGIN_MODULES` list. Neither path adds a host switch for a provider name.

Use `definePluginV2` for new plugins. Its `config` and optional `binding` Zod schemas become Draft-07 JSON Schema with `io: 'input'`, so fields with defaults stay optional at admission. The apply callback receives the parsed output. A v2 manifest declares `id`, `version`, `kind`, `scope`, `provides`, `requires`, `optional` as needed, `secretFields`, runtime egress/model-licence metadata, UI metadata, capability claims, conformance suites and usage meters. A process plugin can own shared clients; call state belongs in a session plugin. Release selections pin plugin version, binding identity and a snapshot of non-secret binding config.

`ctx.net` is the only network port for a vendor plugin. The runtime checks declared hosts and private-address policy. Do not import `node:net`, `node:tls`, `node:http`, `node:https`, `node:dgram`, `ws` or another plugin package from a vendor plugin. `ctx.secret` resolves a declared credential reference for its workspace; never copy a secret into a manifest, release snapshot, fixture, log or UI response. Every timer, socket and subscription needs bounded cleanup through the plugin lifecycle.

## Prove the contract

1. Add an exported fixture or fixture template containing documented request and response shapes, a source URL and retrieval date. Tests run through `FixtureNet` and the egress sentinel; no test should contact a vendor endpoint.
2. Run the relevant `@winsendotai/ovo-conformance` kit (`engine@1`, `carrier@1`, `stt@1`, `tts@1`, `llm@1`, or tool) against the real exported plugin. Cover absent and negative forms of every optional field and capability flag, along with valid cases. A test must fail on a value assertion against the broken implementation.
3. Test schema rejection, startup failure, cancellation, idempotent disposal, workspace isolation and selected-release compatibility. Carrier HTTP and upgrade signatures require independent vendor-oracle vectors when the vendor publishes a validator or signer.
4. Run `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, focused tests, full tests and build. Architecture and conformance gates must have no new baseline entry. The fixture matrix in `packages/distribution/tests/matrix.test.ts` is the cross-plugin integration check.

Publish a new immutable release after changing a plugin or binding; active calls retain the pinned graph. A conformance pass establishes protocol behavior under fixtures. It does not certify real vendor traffic, public routing or a carrier sandbox. Twilio and Plivo ingress are installed; Exotel, TCN and Alohaa remain held on confirmed vendor contracts.

## Module size

Keep one responsibility per module and prefer fewer than 300 formatted lines. CI rejects more than 400 canonical nonblank source lines or 24 KiB (500 lines for tests). The gate measures Prettier's canonical output. Imported pinned DeepSeek files retain their upstream hash and layout.
