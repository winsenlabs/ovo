import { ROUTE_VARIABLE_PREFIX } from '@winsendotai/ovo-contracts';
import type { InboundRoute, OperationsService } from '@winsendotai/ovo-plugin-operations';
import type { ControlStore, ReleaseRecord } from '@winsendotai/ovo-plugin-storage';

/** Exactly one of the two, as `operationsApiSchemas.inboundRoute` refines it. */
export type InboundTarget = { releaseId: string } | { routingReleaseId: string };

export type InboundTargetResult =
  | {
      ok: true;
      target: InboundTarget;
      /** The release whose variable schema the route's variables must satisfy: the router's when routed. */
      release: ReleaseRecord;
    }
  | { ok: false; status: number; code: string; message: string; details?: unknown };

/**
 * Resolves what an inbound route PUT binds the number to (design 5.3 and 6). A routing release
 * needs routing switched on and must exist; its router release then plays the part an agent
 * release plays for a direct number. `ovo_route_*` variable names are reserved for the route
 * context the router hands its target, so a number may not set them.
 */
export async function resolveInboundTarget(input: {
  store: Pick<ControlStore, 'getRelease'>;
  operations: OperationsService;
  workspaceId: string;
  routingEnabled: boolean;
  body: { releaseId?: string; routingReleaseId?: string; variables: Record<string, string> };
}): Promise<InboundTargetResult> {
  const { body } = input;
  const reserved = Object.keys(body.variables).filter((name) =>
    name.startsWith(ROUTE_VARIABLE_PREFIX),
  );
  if (reserved.length)
    return {
      ok: false,
      status: 422,
      code: 'invalid_inbound_route_variables',
      message: `Variable names starting ${ROUTE_VARIABLE_PREFIX} are reserved for routing`,
      details: reserved,
    };
  if (body.routingReleaseId === undefined) {
    const release = await input.store.getRelease(input.workspaceId, body.releaseId!);
    return release
      ? { ok: true, target: { releaseId: release.id }, release }
      : { ok: false, status: 404, code: 'release_not_found', message: 'Release not found' };
  }
  if (!input.routingEnabled)
    return {
      ok: false,
      status: 409,
      code: 'routing_disabled',
      message: 'Routing is not enabled, so a number cannot be bound to a routing release',
    };
  const routing = await input.operations.routing.releases.get(body.routingReleaseId);
  if (!routing)
    return {
      ok: false,
      status: 404,
      code: 'routing_release_not_found',
      message: 'Routing release not found',
    };
  const release = await input.store.getRelease(
    input.workspaceId,
    routing.snapshot.router.release.releaseId,
  );
  return release
    ? { ok: true, target: { routingReleaseId: routing.id }, release }
    : {
        ok: false,
        status: 404,
        code: 'release_not_found',
        message: 'The routing release router release was not found',
      };
}

/** What a number answered with before a PUT, for the audit entry. */
export function inboundTargetOf(route: InboundRoute | undefined): InboundTarget | null {
  if (!route) return null;
  return route.routingReleaseId
    ? { routingReleaseId: route.routingReleaseId }
    : { releaseId: route.releaseId! };
}
