import type { Pool, QueryResultRow } from 'pg';
import { normalizePhoneNumber } from './csv.ts';
import type { InboundRoute, InboundRouteInput } from './types.ts';

interface RouteRow extends QueryResultRow {
  organization_id: string;
  phone_number: string;
  release_id: string;
  variables: Record<string, string>;
  enabled: boolean;
  version: string;
  created_at: Date;
  updated_at: Date;
}

const columns = `organization_id, phone_number, release_id, variables, enabled,
  version, created_at, updated_at`;

function present(row: RouteRow): InboundRoute {
  return {
    organizationId: row.organization_id,
    phoneNumber: row.phone_number,
    releaseId: row.release_id,
    variables: row.variables,
    enabled: row.enabled,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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

  async get(phoneNumber: string): Promise<InboundRoute | undefined> {
    const result = await this.pool.query<RouteRow>(
      `SELECT ${columns} FROM ovo_ops_inbound_routes
       WHERE organization_id = $1 AND phone_number = $2`,
      [this.organizationId, normalizePhoneNumber(phoneNumber)],
    );
    return result.rows[0] ? present(result.rows[0]) : undefined;
  }

  async list(limit = 100, after?: string): Promise<InboundRoute[]> {
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const result = await this.pool.query<RouteRow>(
      `SELECT ${columns} FROM ovo_ops_inbound_routes
       WHERE organization_id = $1 AND ($2::text IS NULL OR phone_number > $2)
       ORDER BY phone_number LIMIT $3`,
      [this.organizationId, after ? normalizePhoneNumber(after) : null, bounded],
    );
    return result.rows.map(present);
  }

  async put(input: InboundRouteInput): Promise<InboundRoute | undefined> {
    const phoneNumber = normalizePhoneNumber(input.phoneNumber);
    const variables = checkedVariables(input.variables);
    const result =
      input.expectedVersion === null
        ? await this.pool.query<RouteRow>(
            `INSERT INTO ovo_ops_inbound_routes
               (organization_id, phone_number, release_id, variables, enabled)
             VALUES ($1, $2, $3, $4::jsonb, $5)
             ON CONFLICT DO NOTHING RETURNING ${columns}`,
            [
              this.organizationId,
              phoneNumber,
              input.releaseId,
              JSON.stringify(variables),
              input.enabled ?? true,
            ],
          )
        : await this.pool.query<RouteRow>(
            `UPDATE ovo_ops_inbound_routes SET release_id = $3, variables = $4::jsonb,
               enabled = $5, version = version + 1, updated_at = now()
             WHERE organization_id = $1 AND phone_number = $2 AND version = $6
             RETURNING ${columns}`,
            [
              this.organizationId,
              phoneNumber,
              input.releaseId,
              JSON.stringify(variables),
              input.enabled ?? true,
              input.expectedVersion,
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
