# Console implementation evidence

Date: 2026-09-20

## Delivered surface

- Next.js 16 management console on port 3000 with a server-only same-origin gateway from `/api/v1/*` to the configured management API.
- Bootstrap login posts the token once, clears the input immediately, and relies on the API-issued HttpOnly session cookie. No admin token is bundled into browser code.
- API-backed Agent Studio for all four `AgentConfig` modes, optimistic draft writes with `If-Match`, conflict evidence, immutable release history, API-authoritative release validation, processing phrases, provider-binding references, and explicit contract gaps for unsupported call policy.
- Write-only credential create/rotate/retire flows, redacted metadata, provider bindings, MCP connection test/discovery, schema digest drift display, and explicit per-agent approval.
- Release simulations, call/event/usage inspection, stored evaluation fixtures/outcomes, and clear separation between simulations and real calls.
- Authenticated call recording metadata and WAV playback with duration, source, format, expiry, empty/error/expired states, plus an explicitly simulation-only fixture upload. Audio is never presented as transcript alignment or proof of carrier capture.
- Honest unavailable panels for aggregate performance and infrastructure because the management API does not currently define those sources.
- Forest/light responsive visual system from the approved console design. At 390 px, grids collapse to one column, navigation scrolls horizontally, tables stay inside labelled scroll regions, and desktop-only authoring limitations are stated.

## Plugin composition

`@winsendotai/ovo-ui` defines a console extension registry and extension plugin factory using the runtime `definePlugin()` API. Core forms and panels are registered as Cordis plugins and composed on the Next server before serialization to the client. Registration disposal is owned by `ctx.effect`; it is not a descriptor-only plugin label.

## Verification performed

- `pnpm --filter @winsendotai/ovo-console typecheck` — passed.
- `pnpm vitest run packages/ui/tests/registry.test.ts apps/console/tests/gateway.test.ts` — includes registry composition, HttpOnly forwarding, bounded gateway errors, and authenticated binary WAV streaming.
- Assigned console/UI files pass `node scripts/check-module-size.mjs`; route, panel, form, hook, and CSS responsibilities are split below the 400 canonical-line/24 KiB limits.
- Running Next server returned HTTP 200 for `/agents`.
- Same-origin gateway smoke test returned HTTP 200 for session bootstrap, current identity, and agent listing while preserving an HttpOnly cookie.
- Local API integration created one announcement agent, published an immutable behavior release, completed a release simulation, and stored a passing objective evaluation. Statuses were 201/201/200/201. This proves the local configured path only; it is not production, carrier, recording, or provider certification.

## Remaining honest gates

- Browser automation, keyboard traversal, screen-reader review, and 390 px screenshot validation are owned by final integration and were not claimed here.
- Real carrier capture, transcript/audio alignment, provider credential validation, remote MCP servers, aggregate percentile metrics, worker capacity, queues, and quotas require their respective external systems and API evidence. Local WAV and simulation-fixture paths do not certify S3 or carrier integrations.
- Context and tool-using releases remain subject to the API plugin catalog and provider/tool readiness. The UI reports release rejection rather than claiming readiness.
- No secret values, paid provider operations, real phone calls, or infrastructure deployments were used.
