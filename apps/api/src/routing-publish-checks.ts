import {
  routingNodeTargets,
  type ReleaseSelections,
  type RoutingIssue,
  type RoutingIssueCode,
  type RoutingIssueSeverity,
  type RoutingPath,
  type RoutingPointDraft,
} from '@winsendotai/ovo-contracts';
import type { CostLedgerService } from '@winsendotai/ovo-plugin-ledger';
import type { ControlStore } from '@winsendotai/ovo-plugin-storage';
import { parseApprovedEndpoint } from '@winsendotai/ovo-plugin-tools-http';
import type { PluginRegistry } from '@winsendotai/ovo-runtime';
import { requiredMeterChecklist } from './required-meters.ts';
import { livePool, routerRef, type RoutingResolution } from './routing-publish-resolve.ts';
import { credentialReady } from './session-factory.ts';

/** Languages the router has built-in connecting and final end lines for (design 7.5). */
const BUILT_IN_LINE_LANGUAGES = new Set(['en', 'hi']);

/** The bounds of `RoutingReleaseSnapshot.releaseIds`. */
const MAX_RELEASES = 500;

export interface RoutingCheckInput {
  draft: RoutingPointDraft;
  resolution: RoutingResolution;
  workspaceId: string;
  store: Pick<ControlStore, 'getCredential'>;
  registry: PluginRegistry;
  ledger?: Pick<CostLedgerService, 'getPriceCard'>;
  externalEnabled: boolean;
  requireCostPolicy: boolean;
}

type Add = (
  code: RoutingIssueCode,
  path: RoutingPath,
  message: string,
  severity?: RoutingIssueSeverity,
) => void;

/** The router release's own blockers: it must exist, be an agent, hear the caller and be priced. */
function routerIssues(input: RoutingCheckInput, add: Add): void {
  const { release } = routerRef(input.resolution);
  if (!release) {
    add('routing_router_missing', ['router'], 'The router agent or its release was not found');
    return;
  }
  if (release.config.mode !== 'agent')
    add('routing_router_mode', ['router'], 'The router release must be an agent-mode release');
  if (!release.selections?.stt)
    add('routing_router_input_missing', ['router'], 'The router release has no STT selection');
  if (input.requireCostPolicy && !release.config.costPolicy)
    add(
      'routing_router_cost_policy_missing',
      ['router'],
      'The router release has no cost policy, so admission would refuse every call',
    );
  if (release.config.opening || release.config.tools.length)
    add(
      'routing_router_has_agent_config',
      ['router'],
      "The router release's opening and tools do not run while it routes",
      'warning',
    );
}

/** Every other reference: the default target, tree targets and pool members, with their pools. */
function targetIssues(input: RoutingCheckInput, add: Add): void {
  for (const { role, path, release } of input.resolution.refs) {
    if (release || role === 'router') continue;
    if (role === 'default')
      add(
        'routing_default_target_missing',
        path,
        'The default target agent or release was not found',
      );
    else add('routing_member_release_missing', path, 'The agent or its release was not found');
  }
  for (const { path, target } of routingNodeTargets(input.draft.nodes)) {
    if (target.kind !== 'pool') continue;
    const pool = input.resolution.pools.get(target.poolId);
    if (pool === 'deleted')
      add('routing_pool_deleted', [...path, 'poolId'], `Pool ${target.poolId} was deleted`);
    else if (!pool)
      add('routing_pool_missing', [...path, 'poolId'], `Pool ${target.poolId} was not found`);
  }
}

/**
 * The snapshot lists every distinct release the call can reach, router included, and holds 2 to
 * 500 of them (design 4.8). Checked here so validate and publish agree before the snapshot parse.
 */
function releaseCountIssues(input: RoutingCheckInput, add: Add): void {
  const { refs } = input.resolution;
  if (refs.some((found) => !found.release)) return;
  const distinct = new Set(refs.map((found) => found.release!.id)).size;
  if (distinct < 2)
    add(
      'routing_default_target_missing',
      ['defaultTarget'],
      'Every reference resolves to the router release; the default target needs a release of its own',
    );
  else if (distinct > MAX_RELEASES)
    add(
      'routing_limits_exceeded',
      [],
      `The routing reaches ${distinct} distinct releases; at most ${MAX_RELEASES} are allowed`,
    );
}

/**
 * The router's cost policy prices the whole call (design 7.4), so every other release the call
 * can reach must emit only meters that policy prices: the required-meter checklist run with the
 * router's price cards in place of the release's own.
 */
async function meterIssues(input: RoutingCheckInput, add: Add): Promise<void> {
  const router = routerRef(input.resolution).release;
  const costPolicy = router?.config.costPolicy;
  if (!router || !costPolicy) return;
  const checked = new Set<string>([router.id]);
  for (const { path, release } of input.resolution.refs) {
    if (!release || checked.has(release.id)) continue;
    checked.add(release.id);
    let uncovered: string[];
    try {
      const checklist = await requiredMeterChecklist({
        config: { ...release.config, costPolicy },
        selections: (release.selections ?? {}) as ReleaseSelections,
        registry: input.registry,
        ledger: input.ledger,
      });
      uncovered = checklist.meters
        .filter((meter) => meter.status !== 'covered')
        .map((meter) => `${meter.key} (${meter.status})`);
    } catch (error) {
      uncovered = [`meters unreadable: ${error instanceof Error ? error.message : 'unknown'}`];
    }
    if (uncovered.length)
      add(
        'routing_member_meter_uncovered',
        path,
        `Release ${release.id} uses meters the router's cost policy does not price: ${uncovered.join(', ')}`,
      );
  }
}

/** Engines the router release must back: its LLM, its decision slot, a usable webhook. */
async function engineIssues(input: RoutingCheckInput, add: Add): Promise<void> {
  const router = routerRef(input.resolution).release;
  for (const [n, node] of input.draft.nodes.entries())
    for (const [e, engine] of node.engines.entries()) {
      const path = ['nodes', n, 'engines', e];
      if (engine.kind === 'llm' && router && !router.selections?.llm)
        add('routing_engine_llm_unselected', path, 'The router release has no LLM selection');
      if (engine.kind === 'decision' && router && !router.selections?.decision)
        add(
          'routing_engine_decision_unselected',
          path,
          'The router release has no decision selection',
        );
      if (engine.kind !== 'external') continue;
      try {
        parseApprovedEndpoint(engine.endpoint);
      } catch {
        add(
          'routing_external_endpoint_invalid',
          [...path, 'endpoint'],
          'The endpoint must be public HTTPS without credentials or a fragment',
        );
      }
      try {
        await credentialReady(
          input.store,
          { workspaceId: input.workspaceId, id: input.draft.router.agentId },
          engine.credentialId,
        );
      } catch {
        add(
          'routing_external_credential_missing',
          [...path, 'credentialId'],
          'The signing credential is missing, inactive, expired or not permitted for the router agent',
        );
      }
      if (!input.externalEnabled)
        add(
          'routing_external_disabled',
          path,
          'External engines report disabled until OVO_ROUTING_EXTERNAL_ENABLED is true',
          'warning',
        );
    }
}

/** Lines the router needs and has no built-in for, recording, and languages no member speaks. */
function coverageIssues(input: RoutingCheckInput, add: Add): void {
  const { draft, resolution } = input;
  if (!BUILT_IN_LINE_LANGUAGES.has(draft.language.default)) {
    if (!draft.connecting)
      add(
        'routing_line_builtin_missing',
        ['connecting'],
        `No built-in connecting line in ${draft.language.default}; author one`,
      );
    for (const [n, node] of draft.nodes.entries())
      if (!node.fallback.some((step) => step.kind === 'end'))
        add(
          'routing_line_builtin_missing',
          ['nodes', n, 'fallback'],
          `No built-in final line in ${draft.language.default}; end the chain with an end step`,
        );
  }
  const router = routerRef(resolution).release;
  const recorded = new Set<string>(router ? [router.id] : []);
  if (router && !router.config.recording)
    for (const { path, release } of resolution.refs)
      if (release?.config.recording && !recorded.has(release.id) && recorded.add(release.id))
        add(
          'routing_recording_mismatch',
          path,
          `Release ${release.id} records, but a routed call records only when the router does`,
          'warning',
        );
  for (const { path, target } of routingNodeTargets(draft.nodes)) {
    if (target.kind !== 'pool' || target.language !== 'caller') continue;
    const pool = livePool(resolution.pools.get(target.poolId));
    if (!pool || pool.definition.languageFallback.length) continue;
    const spoken = new Set(
      pool.definition.members.filter((m) => m.enabled).flatMap((m) => m.languages),
    );
    const missing = draft.language.allowed.filter((language) => !spoken.has(language));
    if (missing.length)
      add(
        'routing_language_uncovered',
        path,
        `No enabled member of ${pool.definition.name} speaks ${missing.join(', ')} and it has no language fallback`,
        'warning',
      );
  }
}

/** Every resolution check of design 8.4; structural issues come from `routingDraftIssues`. */
export async function routingResolutionIssues(input: RoutingCheckInput): Promise<RoutingIssue[]> {
  const issues: RoutingIssue[] = [];
  const add: Add = (code, path, message, severity = 'error') =>
    issues.push({ code, severity, path, message });
  routerIssues(input, add);
  targetIssues(input, add);
  releaseCountIssues(input, add);
  await meterIssues(input, add);
  await engineIssues(input, add);
  coverageIssues(input, add);
  return issues;
}
