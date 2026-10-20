import { registerRoutingAudioRoutes } from './routing-audio.ts';
import { registerRoutingPointRoutes } from './routing-points.ts';
import { registerRoutingPoolRoutes } from './routing-pools.ts';
import { registerRoutingReleaseRoutes } from './routing-releases.ts';
import { RateLimiter } from '../human-queue-ports.ts';
import { registerRoutingEvalRunRoutes } from './routing-eval-runs.ts';
import { registerRoutingPreviewRoutes } from './routing-preview.ts';
import { registerRoutingSimulateRoutes } from './routing-simulate.ts';
import { registerRoutingStatsRoutes } from './routing-stats.ts';
import { registerRoutingUtilisationRoutes } from './routing-utilisation.ts';
import { routingAudit, type RoutingRouteDependencies } from './routing-support.ts';

/**
 * `/v1/routing/*` (Wave 15, design section 6; hold clips and transfer status, Wave 16). Ships
 * dark: with `OVO_ROUTING_ENABLED` off, only `status` answers; every other route is 404
 * `routing_disabled`.
 */
export function registerRoutingRoutes(input: RoutingRouteDependencies): void {
  const audit = routingAudit(input.store);
  const limiter = new RateLimiter(input.simulateRatePerMinute ?? 30, 60_000, input.clock);
  input.app.get('/v1/routing/status', async (request) => {
    input.requireRole(request, 'viewer');
    // Routing needs the operations database too; without it nothing can be routed.
    const enabled = input.enabled && input.operations !== undefined;
    const simulate = enabled && input.simulator !== undefined;
    const live = simulate && input.liveEngines !== undefined;
    return {
      enabled,
      externalEnabled: input.externalEnabled,
      transferEnabled: input.transferEnabled,
      humanQueueEnabled: input.humanQueueEnabled === true && input.operations !== undefined,
      simulate: {
        enabled: simulate,
        liveLlm: live && input.simulateLiveEnabled === true && input.liveEngines!.llm,
        liveExternal: live && input.externalEnabled && input.liveEngines!.external,
      },
      evalRuns: simulate,
      outcomesAvailable: input.outcomes?.available === true,
    };
  });
  const r4 = { ...input, audit, limiter };
  registerRoutingPoolRoutes({ ...input, audit });
  registerRoutingPointRoutes({ ...input, audit });
  registerRoutingReleaseRoutes({ ...input, audit });
  registerRoutingAudioRoutes({ ...input, audit });
  registerRoutingPreviewRoutes(r4);
  registerRoutingUtilisationRoutes(r4);
  registerRoutingStatsRoutes(r4);
  registerRoutingSimulateRoutes(r4);
  registerRoutingEvalRunRoutes(r4);
}
