# Plugin author guide

OVO mounts approved, deployed code. Agent configuration cannot install packages or execute scripts.

1. Create a private `@winsendotai/ovo-*` workspace package.
2. Import `definePlugin` and contracts from `@winsendotai/ovo-sdk` only.
3. Declare a unique ID, semantic version, contract version, scope, provided and required service keys, JSON configuration schema and secret-field metadata.
4. Use `ctx.provide` for capabilities and `ctx.effect` for resources. Return awaited cleanup from effects. Never start unowned timers, child processes or tasks.
5. Resolve provider credentials through the scoped secret service. Never put secret values in manifests, release locks, UI responses or logs.
6. Put all business checks through the shared execution service. Inference adapters must not install a second tool executor.
7. Supply UI metadata/forms through the console extension registry. The host must not add a plugin-specific switch.
8. Add explicit conformance tests for schema admission, startup failure, cancellation, idempotent disposal, workspace isolation and selected release compatibility.
9. Add the package to the operator-approved catalog. Publish a new immutable release; existing sessions retain their old lock.

`packages/plugin-example` demonstrates a separate package that depends only on the public SDK. Its tests compose two isolated configurations, enforce schema validation and verify disposal. This proves the package boundary locally; it does not certify third-party code or permit runtime downloads.

The DeepSeek-derived host resolves the dependency graph before allocating resources, applies the original profile patch composition algorithm and starts plugins through the adapted child-fiber lifecycle. Applications use the same mechanism; no capability has a privileged registration route.

## Module size and ownership

Keep one responsibility per first-party module. Prefer fewer than 300 formatted lines. Local CI rejects more than 400 canonical nonblank lines or 24 KiB of source (500 lines for tests). The gate measures Prettier's canonical output, so compressed code cannot evade it. Split routes, repositories, schemas, lifecycle adapters and panels by domain. Imported DeepSeek source/test files retain their original layout and hash checks; they are not reformatted merely to meet an OVO size rule.
