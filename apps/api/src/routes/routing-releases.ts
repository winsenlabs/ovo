import type { FastifyReply } from 'fastify';
import { RoutingPointDraft } from '@winsendotai/ovo-contracts';
import { z } from 'zod';
import { publishRoutingPoint } from '../routing-publish.ts';
import { PointParams, publishContext } from './routing-points.ts';
import {
  routed,
  routingPage,
  sendError,
  type RoutingAudit,
  type RoutingRouteDependencies,
} from './routing-support.ts';

const PublishBody = z.object({ expectedDraftVersion: z.number().int().min(1).optional() }).strict();
const ReleaseParams = z.object({ routingReleaseId: z.uuid() });

/** Routing releases (design 4.6): immutable, versioned per point, pinned by inbound numbers. */
export function registerRoutingReleaseRoutes(
  input: RoutingRouteDependencies & { audit: RoutingAudit },
): void {
  const { app, audit } = input;
  const pointNotFound = (reply: FastifyReply) =>
    sendError(reply, 404, 'routing_point_not_found', 'Routing point not found');

  app.post(
    '/v1/routing/points/:pointId/releases',
    routed(input, 'editor', async ({ request, reply, principal, routing }) => {
      const { pointId } = PointParams.parse(request.params);
      const { expectedDraftVersion } = PublishBody.parse(request.body ?? {});
      const point = await routing.points.get(pointId);
      if (!point) return pointNotFound(reply);
      const conflict = () =>
        sendError(
          reply,
          409,
          'routing_point_conflict',
          'The draft changed before it was published',
          {
            current: point,
          },
        );
      if (expectedDraftVersion !== undefined && expectedDraftVersion !== point.draftVersion)
        return conflict();
      // The stored draft is parsed again, so defaults added since it was saved are in the release.
      const draft = RoutingPointDraft.parse(point.draft);
      const result = await publishRoutingPoint(
        publishContext(input, principal, routing),
        { ...point, draft },
        principal.identityId,
      );
      if (result.kind === 'blocked')
        return sendError(reply, 422, 'routing_publish_blocked', 'The draft cannot be published', {
          blockers: result.blockers,
          warnings: result.warnings,
        });
      if (result.kind === 'conflict') return conflict();
      const { release } = result;
      await audit(principal, 'routing.release.create', 'routing_release', release.id, {
        pointId,
        version: release.version,
        digest: release.digest,
        routerReleaseId: release.snapshot.router.release.releaseId,
        defaultReleaseId: release.snapshot.defaultTarget.release.releaseId,
        memberCount: Object.values(release.snapshot.pools).reduce(
          (count, pool) => count + pool.members.length,
          0,
        ),
      });
      return reply.code(201).send({ ...release, warnings: result.warnings });
    }),
  );

  // Newest first; the cursor is the id of the last release of the previous page.
  app.get(
    '/v1/routing/points/:pointId/releases',
    routed(input, 'viewer', async ({ request, reply, routing }) => {
      const { pointId } = PointParams.parse(request.params);
      if (!(await routing.points.get(pointId))) return pointNotFound(reply);
      return routingPage(request, (limit, cursor) => routing.releases.list(pointId, limit, cursor));
    }),
  );

  app.get(
    '/v1/routing/releases/:routingReleaseId',
    routed(input, 'viewer', async ({ request, reply, routing }) => {
      const { routingReleaseId } = ReleaseParams.parse(request.params);
      const release = await routing.releases.get(routingReleaseId);
      return (
        release ?? sendError(reply, 404, 'routing_release_not_found', 'Routing release not found')
      );
    }),
  );
}
