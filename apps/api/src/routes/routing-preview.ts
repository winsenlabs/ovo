import {
  RoutingPointDraft,
  routingDiff,
  type PublishPreview,
  type RoutingIssue,
} from '@winsendotai/ovo-contracts';
import { z } from 'zod';
import { buildRoutingSnapshot, validateRoutingDraft } from '../routing-publish.ts';
import { PointParams, publishContext } from './routing-points.ts';
import { routed, sendError, type RoutingRouteDependencies } from './routing-support.ts';

const PreviewBody = z.object({ draft: z.unknown().optional() }).strict();

/**
 * `POST /v1/routing/points/:pointId/preview-publish` (R4 design 6): what publishing the stored
 * draft (or the one the editor holds) would do. It resolves and validates exactly as publish does
 * and builds the same snapshot, so the digest it shows is the one publish then stores; nothing is
 * written.
 */
export function registerRoutingPreviewRoutes(input: RoutingRouteDependencies): void {
  input.app.post(
    '/v1/routing/points/:pointId/preview-publish',
    routed(input, 'editor', async ({ request, reply, principal, routing }) => {
      const { pointId } = PointParams.parse(request.params);
      const body = PreviewBody.parse(request.body ?? {});
      const point = await routing.points.get(pointId);
      if (!point)
        return sendError(reply, 404, 'routing_point_not_found', 'Routing point not found');
      const parsed = RoutingPointDraft.safeParse(body.draft ?? point.draft);
      if (!parsed.success)
        return sendError(reply, 422, 'routing_draft_invalid', 'Routing point draft is invalid', {
          issues: parsed.error.issues,
        });
      const draft = parsed.data;
      const { issues, resolution } = await validateRoutingDraft(
        publishContext(input, principal, routing),
        draft,
      );
      const blockers: RoutingIssue[] = issues.filter((issue) => issue.severity === 'error');
      const warnings: RoutingIssue[] = issues.filter((issue) => issue.severity === 'warning');
      const built = blockers.length ? undefined : buildRoutingSnapshot(pointId, draft, resolution);
      const stub = (await routing.releases.latest([pointId])).get(pointId);
      const previous = stub && (await routing.releases.get(stub.id));
      // A built snapshot compares pin for pin; a draft with blockers compares by structure alone.
      const changes = routingDiff(previous?.snapshot, built?.snapshot ?? draft);
      const preview: PublishPreview = {
        issues,
        blockers,
        warnings,
        canPublish: blockers.length === 0,
        nextVersion: (previous?.version ?? 0) + 1,
        digest: built?.digest ?? null,
        previous: previous
          ? {
              id: previous.id,
              version: previous.version,
              digest: previous.digest,
              createdAt: previous.createdAt,
            }
          : null,
        unchanged: built !== undefined && built.digest === previous?.digest,
        changes,
        pins: resolution.refs.flatMap(({ path, ref, release }) =>
          release
            ? [{ path, agentId: ref.agentId, was: ref.release.kind, releaseId: release.id }]
            : [],
        ),
      };
      return preview;
    }),
  );
}
