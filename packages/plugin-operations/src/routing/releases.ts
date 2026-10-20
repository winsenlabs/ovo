import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  canonicalJson,
  RoutingReleaseSnapshot,
  type RoutingRelease,
} from '@winsendotai/ovo-contracts';
import { boundedLimit, transaction } from '../database.ts';
import { presentRelease, RELEASE_COLUMNS, uuidOrNull, type ReleaseRow } from './rows.ts';

export interface RoutingReleaseInput {
  pointId: string;
  draftVersion: number;
  snapshot: RoutingReleaseSnapshot;
  digest: string;
  createdBy: string;
}

/** A release without its snapshot: what a list of points needs to say whether it is published. */
export interface RoutingReleaseSummary {
  id: string;
  version: number;
  digest: string;
  draftVersion: number;
  createdAt: string;
}

/** sha256 of the canonical JSON of the parsed snapshot: the digest a release is stored under. */
export function routingSnapshotDigest(snapshot: RoutingReleaseSnapshot): string {
  return createHash('sha256')
    .update(canonicalJson(RoutingReleaseSnapshot.parse(snapshot)))
    .digest('hex');
}

/** Immutable, numbered per point (1, 2, 3...); a database trigger refuses updates and deletes. */
export class RoutingReleases {
  constructor(
    private readonly pool: Pool,
    private readonly organizationId: string,
  ) {}

  /** Undefined when the point is gone or its draft moved past `draftVersion`. */
  async create(input: RoutingReleaseInput): Promise<RoutingRelease | undefined> {
    const snapshot = RoutingReleaseSnapshot.parse(input.snapshot);
    if (snapshot.routingPointId !== input.pointId)
      throw new Error('Routing release snapshot names a different point');
    if (input.digest !== routingSnapshotDigest(snapshot))
      throw new Error('Routing release digest does not match its snapshot');
    if (!input.createdBy.trim()) throw new Error('createdBy is required');
    if (!uuidOrNull(input.pointId)) return undefined;
    return transaction(this.pool, async (client) => {
      // Publishes of one point are serialised, so version = max + 1 never collides.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `ovo-routing-release:${this.organizationId}:${input.pointId}`,
      ]);
      const point = await client.query<{ draft_version: string }>(
        `SELECT draft_version FROM ovo_routing_points
         WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL FOR SHARE`,
        [this.organizationId, input.pointId],
      );
      if (Number(point.rows[0]?.draft_version) !== input.draftVersion) return undefined;
      const result = await client.query<ReleaseRow>(
        `INSERT INTO ovo_routing_releases
           (organization_id, id, routing_point_id, version, draft_version, router_release_id,
            default_release_id, release_ids, snapshot, digest, created_by)
         SELECT $1, $2, $3, COALESCE(MAX(version), 0) + 1, $4, $5, $6, $7::uuid[], $8::jsonb,
           $9, $10
         FROM ovo_routing_releases WHERE organization_id = $1 AND routing_point_id = $3
         RETURNING ${RELEASE_COLUMNS}`,
        [
          this.organizationId,
          randomUUID(),
          input.pointId,
          input.draftVersion,
          snapshot.router.release.releaseId,
          snapshot.defaultTarget.release.releaseId,
          snapshot.releaseIds,
          JSON.stringify(snapshot),
          input.digest,
          input.createdBy,
        ],
      );
      return presentRelease(result.rows[0]!);
    });
  }

  async get(id: string): Promise<RoutingRelease | undefined> {
    if (!uuidOrNull(id)) return undefined;
    const result = await this.pool.query<ReleaseRow>(
      `SELECT ${RELEASE_COLUMNS} FROM ovo_routing_releases WHERE organization_id = $1 AND id = $2`,
      [this.organizationId, id],
    );
    return result.rows[0] ? presentRelease(result.rows[0]) : undefined;
  }

  /** The newest release of each of the points, in one query. Points without one are absent. */
  async latest(pointIds: readonly string[]): Promise<Map<string, RoutingReleaseSummary>> {
    const ids = [...new Set(pointIds.flatMap((id) => uuidOrNull(id) ?? []))];
    const found = new Map<string, RoutingReleaseSummary>();
    if (!ids.length) return found;
    const result = await this.pool.query<ReleaseRow>(
      `SELECT DISTINCT ON (routing_point_id) ${RELEASE_COLUMNS.replace('snapshot,', '')}
       FROM ovo_routing_releases
       WHERE organization_id = $1 AND routing_point_id = ANY($2::uuid[])
       ORDER BY routing_point_id, version DESC`,
      [this.organizationId, ids],
    );
    for (const row of result.rows)
      found.set(row.routing_point_id, {
        id: row.id,
        version: Number(row.version),
        digest: row.digest,
        draftVersion: Number(row.draft_version),
        createdAt: row.created_at.toISOString(),
      });
    return found;
  }

  /** Newest first; the cursor is the id of the last release of the previous page. */
  async list(pointId: string, limit: number, cursor?: string): Promise<RoutingRelease[]> {
    if (!uuidOrNull(pointId)) return [];
    const result = await this.pool.query<ReleaseRow>(
      `SELECT ${RELEASE_COLUMNS} FROM ovo_routing_releases
       WHERE organization_id = $1 AND routing_point_id = $2
         AND ($3::uuid IS NULL OR version < (SELECT version FROM ovo_routing_releases
           WHERE organization_id = $1 AND routing_point_id = $2 AND id = $3))
       ORDER BY version DESC LIMIT $4`,
      [this.organizationId, pointId, uuidOrNull(cursor), boundedLimit(limit)],
    );
    return result.rows.map(presentRelease);
  }
}
