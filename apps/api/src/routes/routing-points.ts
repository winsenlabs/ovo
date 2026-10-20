import type { FastifyReply } from 'fastify';
import {
  RoutingPointDraft,
  routingDraftIssues,
  type RoutingIssue,
} from '@winsendotai/ovo-contracts';
import type { RoutingService } from '@winsendotai/ovo-plugin-operations';
import { z } from 'zod';
import { validateRoutingDraft, type RoutingPublishContext } from '../routing-publish.ts';
import { humanQueuesOf } from './human-queue-support.ts';
import { withPointSummaries } from './routing-summary.ts';
import type { Principal } from '../types.ts';
import {
  etag,
  maskNumber,
  routed,
  routingPage,
  sendError,
  staleConflict,
  type RoutingAudit,
  type RoutingRouteDependencies,
} from './routing-support.ts';

export const PointParams = z.object({ pointId: z.uuid() });
const PointBody = z.object({ draft: z.unknown() }).strict();
const ValidateBody = z.object({ draft: z.unknown().optional() }).strict();
const IncludeQuery = z.object({ include: z.enum(['summary']).optional() }).passthrough();

/** The publish context of one request: the principal's workspace and the routing service. */
export function publishContext(
  input: RoutingRouteDependencies,
  principal: Principal,
  routing: RoutingService,
): RoutingPublishContext {
  const queues = humanQueuesOf(input.operations);
  return {
    workspaceId: principal.workspaceId,
    store: input.store,
    routing,
    // Deleted rows are read too, so publish can say a pool or clip was deleted (R1 audit 5).
    pool: async (id) => {
      const found = await routing.pools.get(id, { includeDeleted: true });
      return found?.deletedAt ? 'deleted' : found;
    },
    audio: (id) => routing.audio.get(id, { includeDeleted: true }),
    // Deleted queues are read too, so publish can say a queue was deleted (Wave 17).
    queue: queues
      ? async (id) => {
          const found = await queues.queues.get(id, { includeDeleted: true });
          return found?.deletedAt ? 'deleted' : found;
        }
      : undefined,
    humanQueues: {
      enabled: input.humanQueueEnabled === true,
      webhookEnabled: input.humanQueueWebhookEnabled === true,
      roomConfigured: input.roomConfigured === true,
      operators: async () => (queues ? await queues.operators.list() : []),
    },
    registry: input.registry,
    ledger: input.ledger,
    externalEnabled: input.externalEnabled,
    transferEnabled: input.transferEnabled,
    requireCostPolicy: input.requireCostPolicy,
  };
}

/**
 * A draft that parses and has no structural error, or the 422 already sent. Warnings are kept on
 * the stored draft (an unreachable node, a human step) and returned with it.
 */
function draftOr422(reply: FastifyReply, raw: unknown) {
  const parsed = RoutingPointDraft.safeParse(raw);
  if (!parsed.success)
    return void sendError(reply, 422, 'routing_draft_invalid', 'Routing point draft is invalid', {
      issues: parsed.error.issues,
    });
  const issues = routingDraftIssues(parsed.data);
  if (issues.some((issue) => issue.severity === 'error'))
    return void sendError(reply, 422, 'routing_draft_invalid', 'Routing point draft has errors', {
      issues,
    });
  return { draft: parsed.data, warnings: issues };
}

const withWarnings = <T extends object>(point: T, warnings: RoutingIssue[]) => ({
  ...point,
  issues: warnings,
});

/** Routing points (design 4.6): a draft per point, with draftVersion etags. */
export function registerRoutingPointRoutes(
  input: RoutingRouteDependencies & { audit: RoutingAudit },
): void {
  const { app, audit } = input;
  const notFound = (reply: FastifyReply) =>
    sendError(reply, 404, 'routing_point_not_found', 'Routing point not found');
  const conflict = (reply: FastifyReply, routing: RoutingService, pointId: string) =>
    staleConflict(
      reply,
      'routing_point_conflict',
      'Routing point state changed',
      routing.points.get(pointId),
    );

  app.get(
    '/v1/routing/points',
    routed(input, 'viewer', async ({ request, routing }) => {
      const { include } = IncludeQuery.parse(request.query ?? {});
      const page = await routingPage(
        request,
        (limit, cursor) => routing.points.list(limit, cursor),
        ['include'],
      );
      // The summary reads releases and pinned numbers beside the list, never one query per point.
      return include === 'summary' && input.operations
        ? { ...page, items: await withPointSummaries(routing, input.operations, page.items) }
        : page;
    }),
  );

  app.post(
    '/v1/routing/points',
    routed(input, 'editor', async ({ request, reply, principal, routing }) => {
      const valid = draftOr422(reply, PointBody.parse(request.body ?? {}).draft);
      if (!valid) return;
      const point = await routing.points.create(valid.draft);
      await audit(principal, 'routing.point.create', 'routing_point', point.id, {
        draftVersion: point.draftVersion,
        nodes: point.draft.nodes.length,
      });
      return reply
        .code(201)
        .header('etag', etag(point.draftVersion))
        .send(withWarnings(point, valid.warnings));
    }),
  );

  app.get(
    '/v1/routing/points/:pointId',
    routed(input, 'viewer', async ({ request, reply, routing }) => {
      const { pointId } = PointParams.parse(request.params);
      const point = await routing.points.get(pointId);
      if (!point) return notFound(reply);
      return reply.header('etag', etag(point.draftVersion)).send(point);
    }),
  );

  app.put(
    '/v1/routing/points/:pointId',
    routed(input, 'editor', async ({ request, reply, principal, routing }) => {
      const { pointId } = PointParams.parse(request.params);
      const expected = input.expectedVersion(request);
      const valid = draftOr422(reply, PointBody.parse(request.body ?? {}).draft);
      if (!valid) return;
      if (!(await routing.points.get(pointId))) return notFound(reply);
      const point = await routing.points.update(pointId, valid.draft, expected);
      if (!point) return conflict(reply, routing, pointId);
      await audit(principal, 'routing.point.update', 'routing_point', pointId, {
        draftVersion: point.draftVersion,
        nodes: point.draft.nodes.length,
      });
      return reply
        .header('etag', etag(point.draftVersion))
        .send(withWarnings(point, valid.warnings));
    }),
  );

  app.delete(
    '/v1/routing/points/:pointId',
    routed(input, 'editor', async ({ request, reply, principal, routing }) => {
      const { pointId } = PointParams.parse(request.params);
      const expected = input.expectedVersion(request);
      if (!(await routing.points.get(pointId))) return notFound(reply);
      const removed = await routing.points.remove(pointId, expected);
      if (removed === 'conflict') return conflict(reply, routing, pointId);
      if (removed !== 'removed')
        return sendError(
          reply,
          409,
          'routing_point_in_use',
          'Inbound numbers are pinned to releases of this routing point',
          { numbers: removed.pinnedBy.map(maskNumber) },
        );
      await audit(principal, 'routing.point.delete', 'routing_point', pointId, {
        draftVersion: expected,
      });
      return reply.code(204).send();
    }),
  );

  // Full publish validation of the stored draft, or of a draft the caller is editing.
  app.post(
    '/v1/routing/points/:pointId/validate',
    routed(input, 'editor', async ({ request, reply, principal, routing }) => {
      const { pointId } = PointParams.parse(request.params);
      const body = ValidateBody.parse(request.body ?? {});
      const point = await routing.points.get(pointId);
      if (!point) return notFound(reply);
      let draft = point.draft;
      if (body.draft !== undefined) {
        const parsed = RoutingPointDraft.safeParse(body.draft);
        if (!parsed.success)
          return sendError(reply, 422, 'routing_draft_invalid', 'Routing point draft is invalid', {
            issues: parsed.error.issues,
          });
        draft = parsed.data;
      }
      const context = publishContext(input, principal, routing);
      return { issues: (await validateRoutingDraft(context, draft)).issues };
    }),
  );
}
