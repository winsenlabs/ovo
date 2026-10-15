import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type { InboundCarrierRoute } from '../inbound-carrier.ts';

/** What the job payload carries for a call admitted through a routing release. */
export interface InboundRouting {
  routingReleaseId: string;
  routingPointId: string;
  version: number;
  defaultReleaseId: string;
}

/**
 * An enabled inbound route with the release that answers the call: a number's own agent release,
 * or for a routed number the router release (routing on) or the release's default target (routing
 * off: the kill switch, never a dropped call). `routing` is set only when the call is routed.
 */
export interface EffectiveInboundRoute extends InboundCarrierRoute {
  routing_release_id: string | null;
  routing: InboundRouting | null;
  /** A routed number admitted straight to its default agent because routing is off. */
  routing_disabled: boolean;
}

interface Row extends QueryResultRow {
  release_id: string | null;
  routing_release_id: string | null;
  variables: Record<string, string>;
  version: string;
  carrier_plugin_id: string | null;
  carrier_binding_id: string | null;
  router_release_id: string | null;
  default_release_id: string | null;
  routing_point_id: string | null;
  routing_version: number | null;
}

/** Router or default release of one routing release, as `effectiveInboundRoute` resolves it. */
export function routedRelease(
  routing: Pick<
    Row,
    | 'routing_release_id'
    | 'router_release_id'
    | 'default_release_id'
    | 'routing_point_id'
    | 'routing_version'
  >,
  routingEnabled: boolean,
): { releaseId: string; routing: InboundRouting | null } {
  if (!routing.router_release_id || !routing.default_release_id || !routing.routing_point_id)
    throw new Error('Inbound routing release is missing');
  return {
    releaseId: routingEnabled ? routing.router_release_id : routing.default_release_id,
    routing: routingEnabled
      ? {
          routingReleaseId: routing.routing_release_id!,
          routingPointId: routing.routing_point_id,
          version: Number(routing.routing_version),
          defaultReleaseId: routing.default_release_id,
        }
      : null,
  };
}

const ROUTING_COLUMNS = `rr.router_release_id, rr.default_release_id, rr.routing_point_id,
  rr.version AS routing_version`;

/** The routing columns of one routing release, for the wait-resume path. */
export async function selectRoutingRelease(
  client: Pool | PoolClient,
  organizationId: string,
  routingReleaseId: string,
): Promise<Row | undefined> {
  const result = await client.query<Row>(
    `SELECT id AS routing_release_id, ${ROUTING_COLUMNS} FROM ovo_routing_releases rr
     WHERE organization_id = $1 AND id = $2`,
    [organizationId, routingReleaseId],
  );
  return result.rows[0];
}

/**
 * The one lookup admission and the media gateway's pre-check share, so both always agree on the
 * release a call is admitted to. Undefined for an unrouted or disabled number.
 */
export async function effectiveInboundRoute(
  client: Pool | PoolClient,
  organizationId: string,
  toNumber: string,
  routingEnabled: boolean,
): Promise<EffectiveInboundRoute | undefined> {
  const result = await client.query<Row>(
    `SELECT r.release_id, r.routing_release_id, r.variables, r.version, r.carrier_plugin_id,
       r.carrier_binding_id, ${ROUTING_COLUMNS}
     FROM ovo_ops_inbound_routes r
     LEFT JOIN ovo_routing_releases rr
       ON rr.organization_id = r.organization_id AND rr.id = r.routing_release_id
     WHERE r.organization_id = $1 AND r.phone_number = $2 AND r.enabled = true`,
    [organizationId, toNumber],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  const base = {
    variables: row.variables,
    version: row.version,
    carrier_plugin_id: row.carrier_plugin_id,
    carrier_binding_id: row.carrier_binding_id,
    routing_release_id: row.routing_release_id,
  };
  if (!row.routing_release_id)
    return { ...base, release_id: row.release_id!, routing: null, routing_disabled: false };
  const routed = routedRelease(row, routingEnabled);
  return {
    ...base,
    release_id: routed.releaseId,
    routing: routed.routing,
    routing_disabled: !routingEnabled,
  };
}
