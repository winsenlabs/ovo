import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { InfrastructureService } from '../infrastructure-types.ts';

interface Principal {
  workspaceId: string;
}

interface ReleaseLookup {
  getRelease(workspaceId: string, releaseId: string): Promise<{ id: string } | undefined>;
}

export interface InfrastructureRouteOptions {
  app: FastifyInstance;
  infrastructure?: InfrastructureService;
  store: ReleaseLookup;
  requireRole: (request: FastifyRequest, role: 'viewer') => Principal;
}

const querySchema = z.object({
  releaseId: z.string().min(1).max(200).optional(),
});

export function registerInfrastructureRoutes(options: InfrastructureRouteOptions) {
  options.app.get('/v1/infrastructure', async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = options.requireRole(request, 'viewer');
    if (!options.infrastructure)
      return reply.code(503).send({
        error: {
          code: 'infrastructure_unavailable',
          message: 'Infrastructure snapshot service is not configured',
        },
      });
    if (principal.workspaceId !== options.infrastructure.organizationId)
      return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
    const query = querySchema.parse(request.query);
    if (
      query.releaseId &&
      !(await options.store.getRelease(principal.workspaceId, query.releaseId))
    )
      return reply.code(404).send({ error: { code: 'not_found', message: 'Release not found' } });
    return options.infrastructure.snapshot(principal.workspaceId, query.releaseId);
  });
}
