import type { Add, RoutingCheckInput } from './routing-publish-checks.ts';
import { routerRef } from './routing-publish-resolve.ts';
import { credentialReady } from './session-factory.ts';
import { parseApprovedEndpoint } from '@winsendotai/ovo-plugin-tools-http';

/** Engines the router release must back: its LLM, its decision slot, a usable webhook. */
export async function engineIssues(input: RoutingCheckInput, add: Add): Promise<void> {
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
