# Work unit U1-console: Console refactor: tokens, owned layout primitives, data layer, real routes, #8 fixes, manifest-driven plugin pickers with carrier URLs and attestations, demo path UI and call inspector

Wave: 2
Depends on: F1-contracts-runtime, F2-kits-gates, F3-host-seams, F4-apps-data-driven
Defects fixed: [8, 15]

## Owned paths

- apps/console/** (package.json devDependencies are frozen)
- packages/ui/**
- scripts/baselines/pending/U1.json

## Shared touchpoints (minimal edits allowed)

- none

## Specification

GOAL: refactor the Next 16 / React 19 console (about 12.9k lines) into a responsive, accessible, route-based app with:

- design tokens and layout primitives we own (no SaaS UI kits);
- a shared data layer with pagination;
- manifest-driven engine, carrier, STT, TTS and LLM pickers with live compatibility errors;
- a clean demo path: create agent → pick plugins → fixture test call → live transcript → inspect.

Read docs/architecture/plugin-platform.md (revision 2): section 11 (normative), section 4.3 (bindings and carrier URLs), section 4.5 (CompatIssue with stage), section 4.8 (API contracts) and section 12 (test-call and evidence APIs, built in parallel by D1). Build against the documented shapes and use fixtures in tests.

Backend APIs available from F4:

- GET /v1/plugins?kind=;
- POST /v1/plugins/compat;
- readiness details: CompatIssue[];
- bindings with pluginId;
- GET /v1/provider-bindings/:id/carrier-urls;
- GET /v1/calls, newest first with limit and cursor.
  From D1 (documented): POST /v1/agents/:id/test-calls, GET /v1/calls/:id/stream, GET /v1/calls/:id/evidence, and GET /v1/calls filters agentId, engine, carrier, kind and status.
  From O2 (documented): campaign max_concurrency; inbound routes carrierPluginId and carrierBindingId; attempt status 'unknown' shown as reconciling; 'superseded'.

PHASES (in order; each leaves the app building):

1. Foundations.
   - app/styles/tokens.css per section 11.1: nothing below 12 px; --focus-ring, and --focus-ring-inverse #a7f3c4 in .sidebar; semantic colours with --color-text-muted #5b665f.
   - Rewrite base.css to use tokens only. Split components.css and domain.css (293 lines) into co-located CSS files of ≤200 lines each.
   - components/ui/*: Stack, Cluster, Grid, Panel, PanelHeader, PanelBody, PageHeader, Toolbar, DataTable (column priority; cards below md via container queries; ARIA roles kept), Pagination (cursor), EmptyState, Callout (state only), FormField (render prop giving the control id, aria-describedby, aria-invalid and required), StatusBadge, Dialog and ConfirmDialog (native <dialog>, focus return, Escape), Drawer, Button (36 px minimum, 44 px on touch), Tabs, Time, Stat and Skeleton. Each 40–150 lines.
   - components/forms/*:
     - use-form-action.ts: capture event.currentTarget BEFORE any await; reset on success;
     - use-row-keys.ts;
     - json-editor.tsx: resync only when the canonical value changed AND the field isn't dirty or focused;
     - list-text-input.tsx: raw text, parsed on blur;
     - json-import-box.tsx.
   - lib/errors.ts, lib/format.ts, and lib/ids.ts (useOperationId keeps the id across retries and rotates it only on success).
   - lib/data/{cache,use-resource,use-cursor-list,use-mutation,use-event-stream,resources}.ts: about 350 lines, in-house. use-event-stream treats the named 'heartbeat' SSE event as liveness and goes stale after twice the interval.
   - Split lib/operator-api.ts (323 lines) into lib/types/*.

2. Routing and shell.
   - Delete app/[[...view]]/page.tsx.
   - Create the section 11.2 tree under app/(console)/, with a server-side session gate in layout.tsx (cookies() → /v1/auth/me through lib/gateway.ts; 401 → /login?next=; admin-only routes call notFound() for non-admins) and app/login/page.tsx.
   - Cache loadConsoleExtensions in a module-level promise.
   - Redirect the old paths through next.config.ts redirects(): /providers → /settings/providers, /tools → /settings/tools, /suppressions → /operations/suppressions, /handoffs → /operations/handoffs.
   - Split console-app.tsx into components/shell/{app-shell,sidebar,mobile-nav,topbar,session-provider,nav-config}.tsx.
     - Below lg the nav is a Drawer (aria-expanded, focus trap, closes on route change).
     - The skip link uses inset-inline-start.
     - Remove the global table {min-width: 640px}.
     - No horizontal scroll at 390 px.
   - Every page.tsx is ≤40 lines and renders a features/** component.

3. #8 fixes and existing views on the new foundation:
   - useFormAction in suppressions-view (53), budget-panel (60) and campaign-create-form (80);
   - useRowKeys in script-editor (173), tools-editor (57) and faq-editor (126);
   - JsonEditor replacing json-object-input, the configuration-panels JsonField and the faq-editor ToolInput;
   - useCursorList + Pagination for /calls and /agents (no truncation at 50; newest first);
   - FormField with real aria-describedby (primitives.tsx:75 used data-describedby);
   - the inverse focus ring in the sidebar;
   - ListTextInput for FAQ aliases and script transition matches;
   - Integrations reload no longer unmounts forms;
   - ConfirmDialog replaces the 6 window.confirm calls;
   - Callout is used ≤25 times (down from 85 <Notice>); permanent explanations move to PageHeader.description or FormField help;
   - campaign views show an 'unknown' attempt as 'Reconciling' (non-terminal) and 'superseded' neutrally, and accept max_concurrency;
   - split every file over 300 lines by responsibility into features/** (team-view, script-editor, mcp, handoffs-view, studio, inbound-routes, evaluation-provider-authorizations, evaluations-view, evaluation-dataset-panel, infrastructure-view, credentials, live-recordings-panel, tools-editor, evaluation-runs-panel, calls-view, recording-panel);
   - delete unavailable-view.tsx and the stale operations-evidence panels in packages/ui/src/index.ts (351 lines; split what remains);
   - remove vendor names from console code; the provider-names gate covers apps/console.

4. Plugin pickers (components/plugins/*):
   - slot-picker.tsx: radio cards per slot (engine, carrier, STT, TTS, LLM, VAD, turn detector) from GET /v1/plugins, with label, vendor and capability chips. Incompatible cards stay visible but disabled, with the reason attached via aria-describedby from a live POST /v1/plugins/compat. The LLM slot is hidden for announcement and faq modes.
   - binding-select.tsx: filtered by pluginId, with a 'Create binding' Drawer. For carrier bindings, show the operator URLs from GET /v1/provider-bindings/:id/carrier-urls, with copy buttons and help text (the URLs operators paste into the Twilio, Exotel or Plivo console).
   - schema-form.tsx:
     - renders bindingSchema or configSchema using the ui.fields hints (enum → select, number min/max, boolean → switch);
     - a const-true boolean (for example Exotel's streamEndTerminatesCall) renders as a required attestation checkbox with the field help;
     - secret pointers are password inputs with autocomplete off, write-only (after save, show 'Stored · fingerprint …');
     - an 'Advanced' raw-JSON disclosure.
   - compat-summary.tsx: groups CompatIssue[] by slot and stage, with anchor links and focus management. It shows the checkbox 'I accept weaker playback evidence for this carrier' (voice.acknowledgements) only when playback_evidence_insufficient appears.
   - settings/providers: credential creation is plugin-first; the free-text provider inputs at bindings.tsx:148-155 and credentials.tsx:153-158 go.
   - /operations/inbound: a carrier plugin and binding picker per inbound number (O2 API).
   - Costs: the price-card editor's meter-key picker lists the meters from GET /v1/plugins (manifest meters), so operators can price the new meters. Unpriced usage displays as 'unpriced', never as zero.
   - AgentConfig.voice is edited through these components.

5. Demo path:
   - /agents/new: a 3-step wizard (name, language and mode cards → plugins → behavior essentials). Create → POST then PUT → /agents/:id. No carrier is preselected (the primary carrier is undecided).
   - /agents/:id: tabs Configure · Plugins · Test · Releases, the save state, a readiness chip, and Publish disabled with the blocker count.
   - /agents/:id/test: TestConsole, reviving evaluations-view and simulation-request.
     - A 'Run fixture test call' button → POST /v1/agents/:id/test-calls {useDraft: true} → {callId} → useEventStream('/api/v1/calls/:id/stream'): a live transcript (user interim vs final, agent generated vs played), a stage timeline and cost so far.
     - Engine and carrier switches update the draft in place.
     - A clear banner: 'Live dialing disabled — protocol fixtures'.
     - A 404 {code: 'fixture_calls_disabled'} shows an explanatory empty state.
   - /calls/:id inspector:
     - header from GET /v1/calls/:id/evidence (agent, release, engine, carrier and STT/TTS/LLM from selections with the resolved versions, outcome, duration);
     - left: the recording (reuse ProductionTrackPlayer) and the aligned transcript;
     - right: the latency waterfall (a table-backed bar list from the latency parts), the cost ledger (estimated, reconciled and unpriced) and the event timeline;
     - a 'Raw evidence' disclosure.
   - /calls: DataTable with URL filters (agent, engine, carrier, kind, status) linking to /calls/:id. The live-call launch moves into an admin-only Drawer.

6. Tests. The lockfile is frozen in wave 2, so do NOT run pnpm add.
   - F2 tried to install @testing-library/react, jsdom, Playwright and axe. Check whether they resolve.
   - IF THEY RESOLVE: write about 25 component tests (*.test.tsx; the root vitest config gives them jsdom):
     - FormField ARIA;
     - JsonEditor survives a re-render with invalid text;
     - useRowKeys keeps focus while typing an id;
     - useFormAction resets after an async submit;
     - describeError;
     - useCursorList next/prev plus URL sync;
     - useEventStream against a fake EventSource (reconnect with cursor, stale, dedupe);
     - SchemaForm secret write-only and the const attestation;
     - SlotPicker disables incompatible cards with a reason;
     - DataTable card mode and empty state;
     - alias newline input.
       Add apps/console/playwright.config.ts (projects 390x844, 768x1024, 1280x800) and e2e/_.spec.ts using page.route fixtures (e2e/fixtures/_.json, including 120 agents for pagination, a plugin catalog, readiness with slot blockers, carrier URLs, and an SSE transcript with a gap and a heartbeat).
     - Journeys: the demo path, switching engine and carrier to clear a compat error, /calls pagination and deep link, the mobile nav drawer, and suppression add resetting the form.
     - Every route checks for no horizontal scroll and runs axe (wcag2a, wcag2aa, wcag22aa) with zero violations.
     - Add an 'e2e' script to apps/console/package.json. That is a scripts edit only; dependencies stay frozen.
   - IF THEY DON'T RESOLVE: write pure *.test.ts tests for the lib/data reducers and helpers, and react-dom/server renderToStaticMarkup tests for the FormField, SlotPicker and DataTable ARIA output. Still write the Playwright config and specs (not run), and state in your final report that the browser tests were not run.
   - Keep apps/console/tests/operator-contracts.test.ts and user-contracts.test.ts passing, extended for the readiness details, plugin catalog and carrier-URL shapes.

WAVE-2 RULES:

- You own only apps/console and packages/ui; doc section 15.2 is frozen.
- Do NOT run pnpm install or pnpm add.
- Contract gaps (API shapes that turn out different in D1 or O2): code against the documented shape, and list the gaps.
- Transitional violations go in scripts/baselines/pending/U1.json.
- Done = scoped lint, the console typecheck and build, and the console tests are green.

CONSTRAINTS:

- No SaaS runtime dependencies. The console may not import any plugin-* package.
- Modules ≤300 lines (CSS target ≤200).
- Preserve the HttpOnly cookie gateway behavior; app/api/v1/[...path]/route.ts stays unchanged.
- Update apps/console/OPERATOR_E2E_HANDOFF.md for the new routes and API shapes.
- No git commits.

## Acceptance

- app/[[...view]] is gone. Real routes exist for /agents, /agents/new, /agents/[id] (plugins, test, releases), /calls, /calls/[id], campaigns, operations and settings, with a server session gate and redirects for old paths.
- tokens.css defines spacing, a 12 px type floor, semantic colours and both focus rings. Layout primitives and form hooks live in components/ui and components/forms, and no console module exceeds 300 lines.
- All #8 items are fixed: form reset after await, stable row keys, JSON editor resync, cursor pagination (calls newest first), aria-describedby on the real control, and sidebar focus-ring contrast.
- Plugin pickers are driven by GET /v1/plugins and POST /v1/plugins/compat. Incompatible options are disabled with an accessible reason, secret fields are write-only, const attestations render as required checkboxes, and carrier bindings show their operator URLs.
- Inbound routes pick a carrier plugin and binding, the price-card meter picker lists manifest meters, and unpriced usage never shows as zero.
- The demo path works against fixtures: wizard → plugins → fixture test call with live transcript → the /calls/:id inspector with recording, transcript, latency waterfall and cost.
- <Notice>/Callout usage is ≤25, and there is no horizontal scroll at 390 px (Playwright if available; otherwise documented). The console typecheck and build pass, the console contract tests pass, and scoped lint is green.

## Verify commands

- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && node scripts/lint.mjs --only apps/console packages/ui`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm --filter @winsendotai/ovo-console typecheck`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm exec vitest run apps/console packages/ui --reporter=dot`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm --filter @winsendotai/ovo-console build`
