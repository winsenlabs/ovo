import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type {
  RoutingPoint,
  RoutingPointDraft,
  RoutingPool,
  RoutingPoolDefinition,
  RoutingRelease,
  RoutingReleaseSnapshot,
} from '@winsendotai/ovo-contracts';

export interface PoolRow extends QueryResultRow {
  organization_id: string;
  id: string;
  definition: RoutingPoolDefinition;
  version: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface PointRow extends QueryResultRow {
  organization_id: string;
  id: string;
  draft: RoutingPointDraft;
  draft_version: string;
  created_at: Date;
  updated_at: Date;
}

export interface ReleaseRow extends QueryResultRow {
  organization_id: string;
  id: string;
  routing_point_id: string;
  version: number;
  draft_version: string;
  snapshot: RoutingReleaseSnapshot;
  digest: string;
  created_by: string;
  created_at: Date;
}

export const POOL_COLUMNS =
  'organization_id, id, definition, version, created_at, updated_at, deleted_at';
export const POINT_COLUMNS = 'organization_id, id, draft, draft_version, created_at, updated_at';
export const RELEASE_COLUMNS = `organization_id, id, routing_point_id, version, draft_version,
  snapshot, digest, created_by, created_at`;

/** A pool; `deletedAt` only on a soft-deleted one (read with `includeDeleted`). */
export function presentPool(row: PoolRow): RoutingPool & { deletedAt?: string } {
  return {
    id: row.id,
    workspaceId: row.organization_id,
    definition: row.definition,
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...(row.deleted_at ? { deletedAt: row.deleted_at.toISOString() } : {}),
  };
}

export function presentPoint(row: PointRow): RoutingPoint {
  return {
    id: row.id,
    workspaceId: row.organization_id,
    draft: row.draft,
    draftVersion: Number(row.draft_version),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function presentRelease(row: ReleaseRow): RoutingRelease {
  return {
    id: row.id,
    workspaceId: row.organization_id,
    routingPointId: row.routing_point_id,
    version: Number(row.version),
    draftVersion: Number(row.draft_version),
    snapshot: row.snapshot,
    digest: row.digest,
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
  };
}

/**
 * Live point ids whose current draft names a pool or a hold clip, from the link tables points keep
 * up to date (`ovo_routing_point_pools`, `ovo_routing_point_audio`).
 */
export async function pointsNaming(
  db: Pool | PoolClient,
  organizationId: string,
  link:
    | { table: 'ovo_routing_point_pools'; column: 'pool_id' }
    | {
        table: 'ovo_routing_point_audio';
        column: 'audio_id';
      },
  id: string,
): Promise<string[]> {
  if (!uuidOrNull(id)) return [];
  const result = await db.query<{ point_id: string }>(
    `SELECT link.point_id FROM ${link.table} link
     JOIN ovo_routing_points p ON p.organization_id = link.organization_id AND p.id = link.point_id
     WHERE link.organization_id = $1 AND link.${link.column} = $2 AND p.deleted_at IS NULL
     ORDER BY link.point_id`,
    [organizationId, id],
  );
  return result.rows.map((row) => row.point_id);
}

/** A cursor or id that is not a uuid matches nothing instead of failing the query. */
export function uuidOrNull(value: string | undefined): string | null {
  return value && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const pg = error as { code?: string; constraint?: string };
  return pg?.code === '23505' && (constraint === undefined || pg.constraint === constraint);
}

/** Another active pool already has this name (case-insensitive). */
export class RoutingPoolNameTakenError extends Error {
  readonly code = 'routing_pool_name_taken';
  constructor(name: string) {
    super(`A routing pool named ${JSON.stringify(name)} already exists`);
    this.name = 'RoutingPoolNameTakenError';
  }
}
