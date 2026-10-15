import type { Pool, QueryResultRow } from 'pg';
import { normalizePhoneNumber } from './csv.ts';
import type { InboundRoute, InboundRouteInput } from './types.ts';

interface RouteRow extends QueryResultRow {
  organization_id: string;
  phone_number: string;
  release_id: string | null;
  routing_release_id: string | null;
  routing_point_id: string | null;
  routing_point_name: string | null;
  routing_version: number | null;
  variables: Record<string, string>;
  enabled: boolean;
  version: string;
  created_at: Date;
  updated_at: Date;
  carrier_plugin_id: string | null;
  carrier_binding_id: string | null;
}

const routeColumns = `r.organization_id, r.phone_number, r.release_id, r.routing_release_id,
  r.variables, r.enabled, r.version, r.created_at, r.updated_at, r.carrier_plugin_id,
  r.carrier_binding_id`;
/** A route row (`r`) with its routing release's point and version, for the presenter. */
const presented = `SELECT ${routeColumns}, rr.routing_point_id, p.name AS routing_point_name,
    rr.version AS routing_version
  FROM r
  LEFT JOIN ovo_routing_releases rr
    ON rr.organization_id = r.organization_id AND rr.id = r.routing_release_id
  LEFT JOIN ovo_routing_points p
    ON p.organization_id = rr.organization_id AND p.id = rr.routing_point_id`;

export type CarrierInboundRoute = InboundRoute & {
  carrierPluginId: string | null;
  carrierBindingId: string | null;
};

export type CarrierInboundRouteInput = InboundRouteInput & {
  carrierPluginId?: string | null;
  carrierBindingId?: string | null;
};

function present(row: RouteRow): CarrierInboundRoute {
  return {
    organizationId: row.organization_id,
    phoneNumber: row.phone_number,
    releaseId: row.release_id,
    routingReleaseId: row.routing_release_id,
    routing:
      row.routing_release_id && row.routing_point_id
        ? {
            pointId: row.routing_point_id,
            pointName: row.routing_point_name ?? '',
            version: Number(row.routing_version),
          }
        : null,
    variables: row.variables,
    enabled: row.enabled,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    carrierPluginId: row.carrier_plugin_id,
    carrierBindingId: row.carrier_binding_id,
  };
}

function checkedVariables(value: Record<string, string> | undefined): Record<string, string> {
  const variables = value ?? {};
  const entries = Object.entries(variables);
  if (entries.length > 50) throw new Error('Inbound route variables may contain at most 50 keys');
  for (const [key, item] of entries) {
    if (
      !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) ||
      typeof item !== 'string' ||
      item.length > 2_000
    )
      throw new Error('Invalid inbound route variable');
  }
  return variables;
}

export class InboundRouteService {
  constructor(
    private readonly pool: Pool,
    private readonly organizationId: string,
  ) {}

  async get(phoneNumber: string): Promise<CarrierInboundRoute | undefined> {
    const result = await this.pool.query<RouteRow>(
      `WITH r AS (SELECT * FROM ovo_ops_inbound_routes
         WHERE organization_id = $1 AND phone_number = $2)
       ${presented}`,
      [this.organizationId, normalizePhoneNumber(phoneNumber)],
    );
    return result.rows[0] ? present(result.rows[0]) : undefined;
  }

  async list(limit = 100, after?: string): Promise<CarrierInboundRoute[]> {
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const result = await this.pool.query<RouteRow>(
      `WITH r AS (SELECT * FROM ovo_ops_inbound_routes
         WHERE organization_id = $1 AND ($2::text IS NULL OR phone_number > $2)
         ORDER BY phone_number LIMIT $3)
       ${presented} ORDER BY r.phone_number`,
      [this.organizationId, after ? normalizePhoneNumber(after) : null, bounded],
    );
    return result.rows.map(present);
  }

  /**
   * Writes the given target and clears the other, so switching a number between a direct agent
   * and a routing release is one optimistic write.
   */
  async put(input: CarrierInboundRouteInput): Promise<CarrierInboundRoute | undefined> {
    const phoneNumber = normalizePhoneNumber(input.phoneNumber);
    const variables = checkedVariables(input.variables);
    const releaseId = input.releaseId ?? null,
      routingReleaseId = input.routingReleaseId ?? null;
    if ((releaseId === null) === (routingReleaseId === null))
      throw new Error('An inbound route has exactly one of releaseId or routingReleaseId');
    const result =
      input.expectedVersion === null
        ? await this.pool.query<RouteRow>(
            `WITH r AS (INSERT INTO ovo_ops_inbound_routes
               (organization_id, phone_number, release_id, variables, enabled,
                carrier_plugin_id, carrier_binding_id, routing_release_id)
             VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
             ON CONFLICT DO NOTHING RETURNING *)
             ${presented}`,
            [
              this.organizationId,
              phoneNumber,
              releaseId,
              JSON.stringify(variables),
              input.enabled ?? true,
              input.carrierPluginId ?? null,
              input.carrierBindingId ?? null,
              routingReleaseId,
            ],
          )
        : await this.pool.query<RouteRow>(
            `WITH r AS (UPDATE ovo_ops_inbound_routes SET release_id = $3, variables = $4::jsonb,
               enabled = $5, routing_release_id = $11,
               carrier_plugin_id = CASE WHEN $9::boolean THEN $7 ELSE carrier_plugin_id END,
               carrier_binding_id = CASE WHEN $10::boolean THEN $8 ELSE carrier_binding_id END,
               version = version + 1, updated_at = now()
             WHERE organization_id = $1 AND phone_number = $2 AND version = $6
             RETURNING *)
             ${presented}`,
            [
              this.organizationId,
              phoneNumber,
              releaseId,
              JSON.stringify(variables),
              input.enabled ?? true,
              input.expectedVersion,
              input.carrierPluginId ?? null,
              input.carrierBindingId ?? null,
              input.carrierPluginId !== undefined,
              input.carrierBindingId !== undefined,
              routingReleaseId,
            ],
          );
    return result.rows[0] ? present(result.rows[0]) : undefined;
  }

  async remove(phoneNumber: string, expectedVersion: number): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM ovo_ops_inbound_routes
       WHERE organization_id = $1 AND phone_number = $2 AND version = $3`,
      [this.organizationId, normalizePhoneNumber(phoneNumber), expectedVersion],
    );
    return result.rowCount === 1;
  }
}
