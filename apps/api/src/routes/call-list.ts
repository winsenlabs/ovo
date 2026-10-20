import type { FastifyReply, FastifyRequest } from 'fastify';
import { listRoutedCalls, routingCallFilter } from './call-routing-filter.ts';

/**
 * `GET /v1/calls`: the workspace's calls with their outcome summaries. With routing filters
 * (`routingPointId`, `segmentAgentId`, `poolId`, `transferred`, `human`, `fallback`) the calls are
 * the ones the outcomes say took such a route, newest outcome first (R4 design 6).
 */
export function registerCallListRoute(dependencies: any): void {
  const { app, store, outcomes, requireRole, queryPage, z, Id, error } = dependencies;
  app.get('/v1/calls', async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = requireRole(request, 'viewer'),
      page = queryPage(request);
    const filters = z
      .object({
        order: z.enum(['asc', 'desc']).default('desc'),
        agentId: Id.optional(),
        engine: z.string().min(1).max(200).optional(),
        carrier: z.string().min(1).max(200).optional(),
        kind: z.enum(['live', 'simulation', 'test']).optional(),
        status: z.string().min(1).max(100).optional(),
      })
      .parse(request.query);
    const routing = routingCallFilter(request.query);
    if (routing) {
      // Routed calls are read from the outcomes, newest outcome first; the control-store filters
      // that need its joins (agent, engine, carrier) and an oldest-first order cannot apply.
      if (filters.agentId || filters.engine || filters.carrier || filters.order === 'asc')
        return error(
          reply,
          422,
          'routing_filter_unsupported',
          'Routing filters combine with kind and status only, newest first',
        );
      return await listRoutedCalls({
        store,
        outcomes,
        log: request.log,
        workspaceId: principal.workspaceId,
        filter: routing,
        limit: page.limit,
        cursor: page.cursor,
        kind: filters.kind,
        status: filters.status,
      });
    }
    const calls = await store.listCalls(principal.workspaceId, page.limit, page.cursor, filters);
    return await outcomes.attach(principal.workspaceId, calls, request.log);
  });
}
