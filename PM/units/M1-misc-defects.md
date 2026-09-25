# Work unit M1-misc-defects: Behaviors (confirmation with contract lexicon and hooks, scripts, FAQ, segmenter), tools (policy errors, SSRF via kit, MCP pooling), secrets rotation lock and decoupling, production session secret, MCP storage diff-upsert (#6, #10–#14, #18, #19, #24, #25)

Wave: 2
Depends on: F1-contracts-runtime, F2-kits-gates, F3-host-seams, F4-apps-data-driven
Defects fixed: [6, 10, 11, 12, 13, 14, 18, 19, 24, 25]

## Owned paths

- packages/behaviors/**
- packages/plugin-tools/**
- packages/plugin-tools-http/**
- packages/plugin-tools-mcp/**
- packages/plugin-secrets/**
- apps/api/src/auth-env.ts
- apps/api/src/routes/mcp.ts
- apps/api/tests/operator-auth.test.ts
- apps/api/tests/mcp-routes.test.ts
- packages/plugin-storage/src/postgres/mcp-*.ts
- packages/plugin-storage/src/sqlite/mcp-*.ts
- packages/plugin-storage/src/postgres/migrations/005-mcp-tool-removed.ts
- packages/plugin-storage/src/postgres/migrations.ts
- packages/plugin-storage/src/sqlite/migrations.ts
- packages/plugin-storage/tests/storage.test.ts
- packages/plugin-storage/tests/postgres.test.ts
- packages/plugin-recordings/src/memory-repository.ts
- packages/plugin-recordings/tests/memory-ordering.test.ts
- scripts/baselines/pending/M1.json

## Shared touchpoints (minimal edits allowed)

- none

## Specification

GOAL: fix the independent correctness and security defects in behaviors, tools, secrets, auth and MCP storage, and remove the tools and secrets plugin→plugin edges. Read docs/architecture/plugin-platform.md (revision 2): section 2.6 (the Behavior speechKind and subscribe hooks and BehaviorEvent), section 2.10 (normalizeForMatch, countWords, CONFIRM_YES, CONFIRM_NO, CONFIRM_FILLERS, classifyConfirmation and canonicalJson, all in contracts), section 4.5 (mcp_tool_removed, whose compat rule F3 already wrote in session-host) and section 14.

Already done and frozen:

- @winsendotai/ovo-plugin-kit has tool-errors.ts (including ConnectorPolicyError) and ssrf.ts (isPublicAddress and assertPublicHost with every #24 range);
- plugin-tools/src/errors.ts re-exports plugin-kit;
- plugin-storage models.ts already has McpDiscoveredTool.removedAt.

#10 (packages/behaviors/src/confirmation.ts plus a new args-speaker.ts). Today the confirmation prompt speaks raw JSON, and only the exact words 'yes', 'confirm', 'go ahead' and 'proceed' are accepted.

- ToolConfirmation.request builds the prompt with args-speaker.ts: speakArguments(input, tool.inputSchema, language).
  - It uses the schema title, or the humanised property names, in schema property order.
  - It formats numbers, and currency when the schema has a format hint or x-unit (e.g. 'amount: 500 rupees, to: Ravi').
  - It redacts keys matching password, secret, token, authorization or api key (keep the existing redaction).
  - It caps at 800 characters; beyond that, the existing error.
- accept() uses classifyConfirmation from contracts. That is WHOLE-UTTERANCE matching where NO always wins: 'no that is not correct' and 'yes… no, cancel' decline; 'okay' alone is unclear and re-prompts; 'yes please', 'haan ji' and 'ji haan' confirm. Do NOT write your own lexicon matching.
- heard requires receipt.state 'completed' AND receipt.evidence !== 'estimated', so 'confirmed' and 'simulated' pass. Never revive a variables.confirmed bypass.
- Hooks (from contracts): every behavior that owns a confirmation implements:
  - speechKind(text) → 'confirmation' for the pending prompt text;
  - subscribe(fn), emitting confirmation.pending when the prompt is produced, confirmation.resolved (confirmed | declined | expired) on the outcome, and tool.started and tool.settled around each Execution.execute call.
    The native and LiveKit engines use these for mute rules and receipt ordering.

#11 (packages/behaviors/src/script.ts):

- Transition matching uses normalizeForMatch on both sides (punctuation-insensitive; Devanagari marks kept).
- ScriptBehavior forwards beginTurn, onPlayback, cancel, speechKind and subscribe to its inner FAQ behavior, so FAQ write tools can confirm inside scripts.

#18 (packages/behaviors/src/faq.ts:147): the tokenizer uses normalizeForMatch (letters, marks and numbers). The tie-break sort at faq.ts:102 uses code-unit comparison (#19).

Sentence boundaries (packages/behaviors/src/text-segmenter.ts, and a new sentence-boundary.ts if needed):

- Multilingual sentence-ending punctuation: . ! ? plus । ॥, CJK 。！？ and Arabic ؟ ۔.
- Lookahead: after '.', wait for the next token, so 'Dr. Smith', 'Rs. 500' and '3.5' don't split. Per-language abbreviation lists (Dr, Mr, Mrs, Ms, Rs, No, St, etc.).
- firstSegmentMaxChars 60: flush early at a comma for faster first audio.
- Golden tables in English, Hindi and numbers.

#12 (packages/plugin-tools-http/src/connector.ts and network.ts; plugin-tools execution):

- Policy failures detected BEFORE any request is sent (a private DNS result, a blocked address, a missing credential binding, a disallowed method or endpoint) throw ConnectorPolicyError from plugin-kit.
- Execution records those as 'failed' (never attempted), NOT 'unknown', including for write tools.
- Only errors after dispatch may become 'unknown' for writes.

#24: tools-http uses plugin-kit's ssrf.ts. Delete the local copy in network.ts, and the plugin-tools-http → plugin-tools import (use plugin-kit tool-errors). The F2 duplication baseline entry goes stale.

#25 (packages/plugin-tools-mcp):

- Pool one MCP client per (connectionId, credential version), with an idle TTL (default 5 min) and a max size.
- Cache discovery per connection, keyed by the approval schemaDigest. invoke calls callTool only and never re-runs listTools.
- Revalidate on a tools/list_changed notification or TTL expiry.
- A schemaDigest mismatch at invoke → a ToolSchemaError (a policy failure, not unknown).
- Remove the plugin-tools-mcp → plugin-tools-http and plugin-tools imports (use plugin-kit).

#6 (the plugin-storage MCP repositories plus migration 005). replaceMcpDiscoveredTools currently does a DELETE that the agent_mcp_tools ON DELETE RESTRICT FK blocks.

- Split postgres/mcp-repository.ts (370 canonical lines) and sqlite/mcp-repository.ts (330) into mcp-*.ts modules below 300 FIRST.
- Change the method to a diff-upsert: upsert every discovered tool; tools missing from the new discovery get removed_at = now() and are never deleted; a tool that reappears clears removed_at.
- Keep the RESTRICT FK and the release snapshot semantics.
- Migration 005-mcp-tool-removed: a Postgres TS migration registered in postgres/migrations.ts, plus sqlite parity. It adds removed_at TIMESTAMPTZ NULL on the discovered-tools table.
- Repositories read and write removedAt (the model field exists).
- apps/api/src/routes/mcp.ts (308 lines; split first) handles and presents removed tools.
- The session-host compat rule mcp_tool_removed already exists (F3). Do not edit session-host.

#13 (packages/plugin-secrets/src/index.ts, 364 canonical lines; split to ≤300):

- Concurrent rotation computes the AAD version outside the lock. Compute the next version and the AAD INSIDE the row lock: SELECT … FOR UPDATE on the credential row, in the same transaction as the write.
- Keep the local and encrypted-store backends working.
- Add a concurrency test: two rotations serialize, and the versions are unique and sequential.
- Remove the plugin-secrets → plugin-storage edge: declare a local structural interface (CredentialStore, the subset of ControlStore methods and the CredentialMetadata shape actually used) instead of importing @winsendotai/ovo-plugin-storage. Callers still pass the real ControlStore.

#14 (apps/api/src/auth-env.ts:77): when NODE_ENV === 'production', refuse to start unless OVO_SESSION_SECRET is set with ≥32 bytes (UTF-8 length). Outside production, keep the per-process random fallback with a warning. Never reset an admin password on ordinary startup.

#19:

- plugin-tools/src/json.ts uses canonicalJson from contracts (tool idempotency keys); add a regression test showing key order is now code-unit and stable.
- plugin-recordings/src/memory-repository.ts:50,103 use code-unit comparison, with a new test file packages/plugin-recordings/tests/memory-ordering.test.ts.
- M2 handles plugin-evaluations/src/validation.ts.

TESTS:

- behaviors:
  - the confirmation prompt has no JSON braces and reads schema titles;
  - 'haan', 'ji haan', 'yes.' and 'Yes!' are accepted; 'no that is not correct' and 'yes no cancel' decline; 'okay' re-prompts;
  - estimated evidence never counts as heard;
  - speechKind returns 'confirmation' for the prompt;
  - subscribe emits the pending, resolved and tool events in order;
  - script transitions with punctuation;
  - a FAQ write tool confirms inside a script;
  - FAQ matching with Devanagari;
  - segmenter golden tables.
- tools-http: a private DNS address → failed, not unknown; a missing binding → failed; every #24 range rejected via the kit.
- mcp: two invokes → one listTools; list_changed revalidates; a digest mismatch → ToolSchemaError.
- storage (sqlite plus the PG-gated pattern): rediscovery with a removed tool succeeds without an FK error and sets removed_at; a reappearing tool clears it.
- secrets: rotation concurrency.
- auth-env: production without a secret, or with a short one → throws.
- json.ts idempotency ordering.

WAVE-2 RULES:

- You own only the paths listed; doc section 15.2 is frozen: plugin-kit, contracts, session-host, plugin-storage models.ts and control-store.ts, and every package.json except those of packages you own.
- Do NOT run pnpm install.
- Contract gaps: use a local adapter and list it.
- Transitional violations go in scripts/baselines/pending/M1.json.
- Done = scoped lint, typecheck and tests green.

CONSTRAINTS:

- behaviors may import only contracts, runtime, zod, ajv, ajv-formats and node:* (the existing gate).
- Tool plugins and plugin-secrets may import only contracts, runtime, sdk, plugin-kit and third-party. The existing plugin→plugin edges among the tools packages and from secrets must be gone.
- Preserve write-confirmation and unknown-outcome protections, restore fences and the admin password rules.
- Modules ≤300 lines. No git commits.

## Acceptance

- The confirmation prompt speaks humanised arguments (no raw JSON), classifies answers with the contracts classifyConfirmation (whole utterance, NO wins), and never treats estimated evidence as heard (#10).
- Behaviors that own confirmations implement speechKind and subscribe (confirmation pending and resolved, tool started and settled), and ScriptBehavior forwards beginTurn, onPlayback, cancel, speechKind and subscribe to the inner FAQ (#11). The FAQ tokenizer keeps Devanagari marks (#18).
- Connector policy errors before dispatch are recorded as failed, not unknown (#12). tools-http uses the plugin-kit SSRF guard (#24), and the tools packages have no plugin→plugin imports.
- MCP invoke no longer re-discovers tools on each call; clients are pooled and a digest mismatch is a policy error (#25).
- MCP rediscovery never violates the RESTRICT FK: removed tools get removed_at, and the API presents them (#6).
- Secret rotation computes the AAD version inside the row lock (#13), and plugin-secrets no longer imports plugin-storage. Production startup requires OVO_SESSION_SECRET ≥32 bytes (#14).
- canonicalJson and code-unit sorts replace localeCompare at the tools json, FAQ and recordings sites (#19). Scoped lint, typecheck and tests are green.

## Verify commands

- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && node scripts/lint.mjs --only packages/behaviors packages/plugin-tools packages/plugin-tools-http packages/plugin-tools-mcp packages/plugin-secrets packages/plugin-storage/src/postgres packages/plugin-storage/src/sqlite packages/plugin-recordings/src/memory-repository.ts apps/api/src/auth-env.ts apps/api/src/routes/mcp.ts`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && node scripts/typecheck-scope.mjs packages/behaviors packages/plugin-tools packages/plugin-tools-http packages/plugin-tools-mcp packages/plugin-secrets packages/plugin-storage packages/plugin-recordings/src/memory-repository.ts apps/api/src/auth-env.ts apps/api/src/routes/mcp.ts apps/api/tests/operator-auth.test.ts`
- `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && cd /Users/tejassuds/work/ovo && pnpm exec vitest run packages/behaviors packages/plugin-tools packages/plugin-tools-http packages/plugin-tools-mcp packages/plugin-secrets packages/plugin-storage packages/plugin-recordings/tests/memory-ordering.test.ts apps/api/tests/operator-auth.test.ts --reporter=dot`
