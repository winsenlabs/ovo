# Implementation instructions for coding agents

## 1. Mission and working rules

Build the product described in this documentation pack, not just a telephony demo or a dashboard with invented data. Begin with repository inspection and the research gates. Preserve existing work and repository instructions. The repository was empty when this documentation was prepared; verify current state rather than assuming it is still empty.

1. Read the documentation index, brief, architecture, frontend specification, work breakdown and acceptance gates before modifying application code.
2. Inventory existing packages, infrastructure, tests and CI. Record findings in `docs/progress.md`.
3. Complete the mandatory [upstream source and spike assignment](09-upstream-research-assignment.md), including DeepSeek Harness, Pipecat and LiveKit Agents JS. Execute the bounded research tasks in [03-stack-research.md](03-stack-research.md). Record precise versions/commits, verified capability, evidence and rejected alternatives.
4. Follow [the DeepSeek source-reuse mandate](11-deepseek-foundation.md): import/adapt the actual upstream foundation and retain provenance. An independent lookalike plugin host does not satisfy the requirement. Select the voice implementation through ADRs. TypeScript and product contracts are fixed direction; exact libraries are choices. Do not port all of Pipecat merely to reproduce its API.
5. Implement in vertical slices with real API, persistence, UI and meaningful tests. Build frame-level test harness before external carrier integration.
6. Use owned test numbers/sandbox tools only for automated tests. Infrastructure deployment, paid provider provisioning, package publication and real customer calling need the appropriate explicit authorization; writing code/configuration does not imply those actions.
7. Commit small, coherent work packages. Do not report completion until automated checks and applicable manual evidence exist.
8. Maintain progress, decisions, migration notes and known limitations. Stop only on a concrete blocker; continue independent authorized work where possible.

The [plugin-first/Fargate mandate](08-plugin-first-fargate.md) is binding: enforce architecture boundaries in CI and implement Fargate scaling/admission/draining explicitly.

## 2. Package and project naming

All first-party npm workspace packages use the scope `@winsendotai`, with an `ovo-` prefix. This is npm scope syntax, not a request to rename the GitHub organization. Keep the existing repository URL. Third-party packages retain their names/licenses.

| Proposed path | Package name | Responsibility |
|---|---|---|
| `packages/contracts` | `@winsendotai/ovo-contracts` | Events, manifests, configuration, transport/tool types |
| `packages/runtime` | `@winsendotai/ovo-runtime` | Lifecycle, plugin graph and session scope |
| `packages/pipeline` | `@winsendotai/ovo-pipeline` | Frame lanes, cancellation and backpressure |
| `packages/behavior-announcement` | `@winsendotai/ovo-behavior-announcement` | Templates and fixed responses |
| `packages/behavior-faq` | `@winsendotai/ovo-behavior-faq` | No-generative-LLM FAQ matching |
| `packages/behavior-context` | `@winsendotai/ovo-behavior-context` | Supplied-context dialogue |
| `packages/behavior-agent` | `@winsendotai/ovo-behavior-agent` | Bounded tool-using behavior |
| `packages/acknowledgments` | `@winsendotai/ovo-acknowledgments` | Configurable processing speech |
| `packages/plugin-<kind>-<provider>` | `@winsendotai/ovo-plugin-<kind>-<provider>` | Concrete adapters |
| `packages/ui` | `@winsendotai/ovo-ui` | Shared accessible components and extension registry |
| `packages/sdk` | `@winsendotai/ovo-sdk` | Typed client and plugin-author helpers |
| `packages/testing` | `@winsendotai/ovo-testing` | Virtual clock, fixture transport, assertions |
| `apps/api` | `@winsendotai/ovo-api` | Management and command API |
| `apps/console` | `@winsendotai/ovo-console` | Next.js frontend |
| `apps/worker` | `@winsendotai/ovo-worker` | Call-session container |
| `apps/dispatcher` | `@winsendotai/ovo-dispatcher` | Scheduling, outbox, ownership and capacity |
| `apps/postprocess` | `@winsendotai/ovo-postprocess` | Export, reconciliation, recording finalization |

Use `private: true` for applications and unpublished/internal packages. Public package publishing is a separate release task; check scope ownership before any publication. Keep package boundaries useful: modules can begin inside a package and split when a stable public contract exists. Do not create empty packages to fill this table.

## 3. Engineering defaults to verify

Proposed monorepo: pnpm workspaces, strict TypeScript, a currently supported Node LTS, Next.js frontend, NestJS or Fastify API selected through research, JSON Schema with TypeScript bindings, OpenTelemetry, Vitest for unit/contracts, Playwright for frontend, Docker images and Terraform deployment. Pin versions after verification rather than inventing latest version numbers.

Use discriminated unions and runtime validation at external boundaries. Use `AbortSignal` plus response epochs for cooperative cancellation; promises alone are not cancellation. Avoid synchronous CPU-heavy audio processing on the main event loop. Use proven native/WASM/worker-thread components where research supports them.

No shared mutable call context. No provider SDK imports inside domain behaviors. No business operation executed solely from model text without schema/policy validation. Never store plaintext secrets in git or configuration versions. Never fake durable state with process memory.

## 4. Required implementation artifacts

- Versioned configuration and event schemas with migration tests.
- OpenAPI specification and typed client matching the implemented API.
- Plugin manifest schema, capability matrix and conformance test kit.
- Infrastructure templates for Fargate and single EC2, with permissions, network routes, capacities and cost assumptions.
- Browser-managed agent configuration and provider credential lifecycle.
- Seed templates for all four bot modes using synthetic data.
- Deterministic audio fixtures, reference conversations and failure scenarios.
- Operational runbooks, restore/release procedures and setup instructions.
- Evidence-backed release checklist; no unchecked placeholders disguised as completion.

## 5. Definition of a completed work package

Code builds; schemas and APIs agree; relevant tests pass; user flow is accessible; errors/loading/empty/stale states exist; permissions and redaction are enforced; telemetry is wired; migrations and docs exist; acceptance evidence links to a commit and environment. For provider work, simulation is insufficient to claim real interoperability.

A test suite must verify behavior and failure boundaries, not only reproduce implementation branches. Critical tests cover duplicate calls, stale audio, ambiguous writes, tenant isolation, secret leakage, and replay safety. Avoid broad refactors unrelated to a task.

## 6. Suggested progress record

For each work package store: ID, status (not started/in progress/blocked/verified), owner, prerequisites, commits, tests, evidence paths, unresolved risks, next action. Mark optional work distinctly. Use the estimates in the engineering plan as planning ranges and replace them with measured progress; they are not deadlines.
