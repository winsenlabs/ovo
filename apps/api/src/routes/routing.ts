import { registerRoutingPointRoutes } from './routing-points.ts';
import { registerRoutingPoolRoutes } from './routing-pools.ts';
import { registerRoutingReleaseRoutes } from './routing-releases.ts';
import { routingAudit, type RoutingRouteDependencies } from './routing-support.ts';

/**
 * `/v1/routing/*` (Wave 15, design section 6). Ships dark: with `OVO_ROUTING_ENABLED` off, only
 * `status` answers; every other route is 404 `routing_disabled`.
 */
export function registerRoutingRoutes(input: RoutingRouteDependencies): void {
  const audit = routingAudit(input.store);
  input.app.get('/v1/routing/status', async (request) => {
    input.requireRole(request, 'viewer');
    // Routing needs the operations database too; without it nothing can be routed.
    return {
      enabled: input.enabled && input.operations !== undefined,
      externalEnabled: input.externalEnabled,
    };
  });
  registerRoutingPoolRoutes({ ...input, audit });
  registerRoutingPointRoutes({ ...input, audit });
  registerRoutingReleaseRoutes({ ...input, audit });
}
