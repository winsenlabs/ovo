# Tools implementation evidence

Date: 2026-09-20 UTC

## Implemented scope

- `@winsendotai/ovo-plugin-tools`
  - Shared `Execution` service over the contracts `OperationStore`, `Speech`, and `ToolConnector` interfaces.
  - Ajv input/output validation with formats, exact per-agent allowlists, confirmation gates (all writes plus explicitly marked reads), durable intent and running-state persistence before any acknowledgment or effect, operation-ID deduplication/collision rejection, bounded deadlines even when a connector ignores abort, cancellation, bounded progress, and conservative unknown write outcomes without retries.
  - For a live winning operation, acknowledgment starts once and concurrently with the tool. `execute()` does not return a settled result until the acknowledgment promise settles, including instant tools, so downstream result speech is gated. Provider results arriving after a timeout/cancellation are ignored and cannot overwrite the terminal record or trigger later speech.
  - Trusted native handler connector; handlers are deployment code, not user-supplied scripts.
  - Responsibilities are split across policy compilation/validation, operation persistence/runner, acknowledgment/progress scheduling, execution coordination, errors, canonical JSON/digests, native connector, Cordis binding, and service-key modules.
- `@winsendotai/ovo-plugin-tools-http`
  - Exact operator-approved HTTPS endpoint bindings with fixed paths and explicitly mapped query fields.
  - DNS resolves before a credential is read; all resolved addresses must be public. Production fetch uses an Undici agent pinned to those addresses. Requests cannot change origin/path, redirects are not followed, and private/special-use IPv4, IPv6, mapped IPv4, link-local, loopback, metadata, and documentation ranges are rejected.
  - Server-side bearer/header credential resolution, optional operation-ID header mapping, response projection, no retry, and conservative ambiguous 5xx/network outcomes.
  - DNS/egress pinning is isolated from request mapping and connector/plugin binding.
- `@winsendotai/ovo-plugin-tools-mcp`
  - Actual `@modelcontextprotocol/sdk` `Client` plus `StreamableHTTPClientTransport`; no stdio transport or browser command path.
  - `createMcpConnector(connections, dependencies)` exposes read-only `discover`, `validateApproval`, and shared `invoke` operations. `mcpSchemaDigest` is the single approval/release digest function.
  - Discovery never changes approvals. Invocation re-discovers the named tool, compares both the recorded digest and release schemas, requires explicit MCP read-only annotation for a local read classification, and blocks drift before calling the tool.
  - Bearer credentials are resolved only server-side after egress validation and are never present in discovery/results.
  - MCP schema/digest logic, SDK transport, discovery/invocation, and Cordis binding are separate modules.
- Every capability has an explicit `definePlugin` manifest and uses `ctx.provide`. The execution plugin factory declares only the connector services selected by the exact allowlist, plus `ovo.operation-store` and `ovo.speech`.

## Public builder surface

```ts
createExecutionPlugin({ tools, allowedTools, processing? })
createExecutionService(config, { store, speech, connectors })
createNativeToolsPlugin(handlers)
createHttpToolsPlugin(bindings)
createMcpToolsPlugin(connections)

createMcpConnector(connections, { secrets?, network? })
connector.discover({ workspaceId, connectionId, signal? })
connector.validateApproval({ workspaceId, connectionId, remoteName, schemaDigest })
mcpSchemaDigest({ inputSchema, outputSchema? })
toolDefinitionMatchesDiscovery(toolDefinition, discoveredTool)
```

Cordis service keys are exported as `serviceKeys`: `ovo.execution`, `ovo.operation-store`, `ovo.speech`, `ovo.secret-resolver`, and `ovo.tool-connector.native|http|mcp`.

## Verification

Command:

```sh
pnpm exec vitest run \
  packages/plugin-tools/tests/execution.test.ts \
  packages/plugin-tools-http/tests/http.test.ts \
  packages/plugin-tools-mcp/tests/mcp.test.ts
```

Observed: 3 test files passed, 21 tests passed. The suite covers required acknowledgment configuration, allowlist/confirmation/schema rejection before intent, failed intent persistence with zero effects, cancellation after durable intent but before acknowledgment/effect, fast-result acknowledgment gating, duplicate suppression and collision rejection, cooperative and uncooperative connector deadlines, ignored late results, write timeout as unknown with one attempt, explicit cancellation, bounded progress, manifest dependencies, SSRF/private-address/redirect rejection, server-side HTTP auth and idempotency mapping, workspace isolation, MCP discovery/drift, secret-error redaction, and an actual local MCP Streamable HTTP protocol server.

The local MCP protocol fixture deliberately injects a test fetch that maps an approved public test hostname to the loopback fixture. Production code has no loopback exception and rejects private DNS/IP destinations.

Workspace TypeScript validation reported no errors in these three packages. The whole-workspace command was still red on concurrent, out-of-scope implementation files at this evidence point.

The architecture, namespace, private-package, PM-criteria, pinned-upstream, and whole-workspace module-size checks passed. Within the tool packages, the largest production module is 219 canonical nonblank lines and the largest test module is 465, below their respective 400/500 limits.

## Acceptance mapping

- A10/A11: unknown/unallowed/schema-invalid tools and unconfirmed writes stop before persistence/effect.
- A12/A13: one configured acknowledgment starts for the winning operation even when the tool resolves immediately; execution result remains gated on it.
- A15/A16: connectors receive cancellation signals, while the runner independently races abort so an uncooperative provider cannot hold the operation open; progress count is bounded and future progress is cancelled on settlement.
- A29/A30: started writes that time out become `unknown`, reads fail, late results are discarded, operations are never retried, and no effect starts when intent/running persistence fails or cancellation is already visible before invocation.
- A54: private/metadata/special-use destinations and redirects are rejected; production DNS is pinned to validated addresses.
- A75: MCP credentials remain server-side, discovery does not grant, exact tool/schema validation precedes invocation, and calls pass through the same `Execution` path.

## Honest limitations and required follow-up

1. This implementation does not claim distributed exactly-once acknowledgment. Durable operation-ID deduplication prevents an existing intent/running operation from replaying a second acknowledgment, but a process crash after persistence and before `Speech.speak` can omit the acknowledgment. That limitation is documented for this slice; no contracts extension is requested by this narrower fix.
2. `Speech.speak` has no per-segment cancellation signal. The implementation cancels future progress scheduling, but cannot selectively abort a progress segment already accepted by the speech service without calling the global `interrupt()`. The speech scheduler/epoch owner must enforce obsolete-output suppression.
3. The contracts do not yet declare external idempotency/status-query/redaction mappings. HTTP can map the operation ID to an approved header and all connectors intentionally make one attempt; uncertain writes remain visible as `unknown`. Provider-specific reconciliation must be added before certifying those writes.
4. DNS pinning and protocol behavior were verified locally with deterministic fakes, not against a production proxy, external MCP provider, or carrier environment. No paid or customer calls were made.
