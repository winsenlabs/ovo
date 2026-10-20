import type { FastifyReply, FastifyRequest } from 'fastify';
import { RoutingPoolDefinition, type RoutingPool } from '@winsendotai/ovo-contracts';
import { RoutingPoolNameTakenError, type RoutingService } from '@winsendotai/ovo-plugin-operations';
import { z } from 'zod';
import {
  etag,
  routed,
  routingPage,
  sendError,
  staleConflict,
  type RoutingAudit,
  type RoutingRouteDependencies,
} from './routing-support.ts';

export const PoolParams = z.object({ poolId: z.uuid() });
const PoolBody = z.object({ definition: z.unknown() }).strict();

/** The parsed definition, or the 422 already sent. */
function definitionOr422(reply: FastifyReply, body: unknown) {
  const parsed = RoutingPoolDefinition.safeParse(PoolBody.parse(body ?? {}).definition);
  if (parsed.success) return parsed.data;
  sendError(reply, 422, 'routing_pool_invalid', 'Pool definition is invalid', {
    issues: parsed.error.issues,
  });
}

/** A create or update, with a taken name answered as 409 `routing_pool_name_taken`. */
async function named<T>(reply: FastifyReply, write: () => Promise<T>) {
  try {
    return { written: await write() };
  } catch (error) {
    if (!(error instanceof RoutingPoolNameTakenError)) throw error;
    sendError(reply, 409, 'routing_pool_name_taken', 'Another pool already has this name');
  }
}

/** The pool named by the route's `:poolId`, or undefined once the 404 has been sent. */
export async function poolOr404(
  routing: RoutingService,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<RoutingPool | undefined> {
  const { poolId } = PoolParams.parse(request.params);
  const pool = await routing.pools.get(poolId);
  if (!pool) sendError(reply, 404, 'routing_pool_not_found', 'Pool not found');
  return pool;
}

/** Agent pools (design 4.3): members are agent releases with what they support. */
export function registerRoutingPoolRoutes(
  input: RoutingRouteDependencies & { audit: RoutingAudit },
): void {
  const { app, audit } = input;
  const notFound = (reply: FastifyReply) =>
    sendError(reply, 404, 'routing_pool_not_found', 'Pool not found');
  const conflict = (reply: FastifyReply, routing: RoutingService, poolId: string) =>
    staleConflict(reply, 'routing_pool_conflict', 'Pool state changed', routing.pools.get(poolId));

  app.get(
    '/v1/routing/pools',
    routed(input, 'viewer', ({ request, routing }) =>
      routingPage(request, (limit, cursor) => routing.pools.list(limit, cursor)),
    ),
  );

  app.post(
    '/v1/routing/pools',
    routed(input, 'editor', async ({ request, reply, principal, routing }) => {
      const definition = definitionOr422(reply, request.body);
      if (!definition) return;
      const created = await named(reply, () => routing.pools.create(definition));
      if (!created) return;
      const pool = created.written;
      await audit(principal, 'routing.pool.create', 'routing_pool', pool.id, {
        version: pool.version,
        members: pool.definition.members.length,
      });
      return reply.code(201).header('etag', etag(pool.version)).send(pool);
    }),
  );

  app.get(
    '/v1/routing/pools/:poolId',
    routed(input, 'viewer', async ({ request, reply, routing }) => {
      const pool = await poolOr404(routing, request, reply);
      if (!pool) return;
      reply.header('etag', etag(pool.version));
      return { ...pool, usedBy: await routing.pools.usedBy(pool.id) };
    }),
  );

  app.put(
    '/v1/routing/pools/:poolId',
    routed(input, 'editor', async ({ request, reply, principal, routing }) => {
      const { poolId } = PoolParams.parse(request.params);
      const expected = input.expectedVersion(request);
      const definition = definitionOr422(reply, request.body);
      if (!definition) return;
      if (!(await routing.pools.get(poolId))) return notFound(reply);
      const updated = await named(reply, () => routing.pools.update(poolId, definition, expected));
      if (!updated) return;
      const pool = updated.written;
      if (!pool) return conflict(reply, routing, poolId);
      await audit(principal, 'routing.pool.update', 'routing_pool', poolId, {
        version: pool.version,
        members: pool.definition.members.length,
      });
      return reply.header('etag', etag(pool.version)).send(pool);
    }),
  );

  app.delete(
    '/v1/routing/pools/:poolId',
    routed(input, 'editor', async ({ request, reply, principal, routing }) => {
      const { poolId } = PoolParams.parse(request.params);
      const expected = input.expectedVersion(request);
      if (!(await routing.pools.get(poolId))) return notFound(reply);
      const removed = await routing.pools.remove(poolId, expected);
      if (removed === 'conflict') return conflict(reply, routing, poolId);
      if (removed !== 'removed')
        return sendError(reply, 409, 'routing_pool_in_use', 'Point drafts still name this pool', {
          usedBy: removed.inUseBy,
        });
      await audit(principal, 'routing.pool.delete', 'routing_pool', poolId, { version: expected });
      return reply.code(204).send();
    }),
  );
}
