import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  RoutingPointDraft,
  routingAudioIds,
  routingPoolIds,
  type RoutingPoint,
} from '@winsendotai/ovo-contracts';
import { boundedLimit, transaction } from '../database.ts';
import { POINT_COLUMNS, presentPoint, uuidOrNull, type PointRow } from './rows.ts';

/** A pinned number, as a refusal may show it: the last four digits only. */
export function maskedNumber(phoneNumber: string): string {
  return `••••${phoneNumber.slice(-4)}`;
}

/** Routing points: the editable draft of a tree, versioned; releases freeze it. */
export class RoutingPoints {
  constructor(
    private readonly pool: Pool,
    private readonly organizationId: string,
  ) {}

  async list(limit: number, cursor?: string): Promise<RoutingPoint[]> {
    const result = await this.pool.query<PointRow>(
      `SELECT ${POINT_COLUMNS} FROM ovo_routing_points
       WHERE organization_id = $1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR id > $2)
       ORDER BY id LIMIT $3`,
      [this.organizationId, uuidOrNull(cursor), boundedLimit(limit)],
    );
    return result.rows.map(presentPoint);
  }

  async get(id: string): Promise<RoutingPoint | undefined> {
    if (!uuidOrNull(id)) return undefined;
    const result = await this.pool.query<PointRow>(
      `SELECT ${POINT_COLUMNS} FROM ovo_routing_points
       WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [this.organizationId, id],
    );
    return result.rows[0] ? presentPoint(result.rows[0]) : undefined;
  }

  async create(draft: RoutingPointDraft): Promise<RoutingPoint> {
    const parsed = RoutingPointDraft.parse(draft);
    return transaction(this.pool, async (client) => {
      const result = await client.query<PointRow>(
        `INSERT INTO ovo_routing_points (organization_id, id, name, draft)
         VALUES ($1, $2, $3, $4::jsonb) RETURNING ${POINT_COLUMNS}`,
        [this.organizationId, randomUUID(), parsed.name, JSON.stringify(parsed)],
      );
      await this.namePools(client, result.rows[0]!.id, parsed);
      return presentPoint(result.rows[0]!);
    });
  }

  /** Undefined when the draft moved past `expectedVersion` or the point does not exist. */
  async update(
    id: string,
    draft: RoutingPointDraft,
    expectedVersion: number,
  ): Promise<RoutingPoint | undefined> {
    if (!uuidOrNull(id)) return undefined;
    const parsed = RoutingPointDraft.parse(draft);
    return transaction(this.pool, async (client) => {
      const result = await client.query<PointRow>(
        `UPDATE ovo_routing_points SET name = $3, draft = $4::jsonb,
           draft_version = draft_version + 1, updated_at = now()
         WHERE organization_id = $1 AND id = $2 AND draft_version = $5 AND deleted_at IS NULL
         RETURNING ${POINT_COLUMNS}`,
        [this.organizationId, id, parsed.name, JSON.stringify(parsed), expectedVersion],
      );
      if (!result.rows[0]) return undefined;
      await this.namePools(client, id, parsed);
      return presentPoint(result.rows[0]);
    });
  }

  /** Refused while a number pins one of its releases (numbers masked); releases are kept. */
  async remove(
    id: string,
    expectedVersion: number,
  ): Promise<'removed' | 'conflict' | { pinnedBy: string[] }> {
    if (!uuidOrNull(id)) return 'conflict';
    return transaction(this.pool, async (client) => {
      const locked = await client.query<{ draft_version: string }>(
        `SELECT draft_version FROM ovo_routing_points
         WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`,
        [this.organizationId, id],
      );
      if (Number(locked.rows[0]?.draft_version) !== expectedVersion) return 'conflict';
      const pinned = await client.query<{ phone_number: string }>(
        `SELECT r.phone_number FROM ovo_ops_inbound_routes r
         JOIN ovo_routing_releases rr
           ON rr.organization_id = r.organization_id AND rr.id = r.routing_release_id
         WHERE r.organization_id = $1 AND rr.routing_point_id = $2 ORDER BY r.phone_number`,
        [this.organizationId, id],
      );
      if (pinned.rowCount)
        return { pinnedBy: pinned.rows.map((row) => maskedNumber(row.phone_number)) };
      for (const table of ['ovo_routing_point_pools', 'ovo_routing_point_audio'])
        await client.query(`DELETE FROM ${table} WHERE organization_id = $1 AND point_id = $2`, [
          this.organizationId,
          id,
        ]);
      await client.query(
        `UPDATE ovo_routing_points SET deleted_at = now(), updated_at = now()
         WHERE organization_id = $1 AND id = $2`,
        [this.organizationId, id],
      );
      return 'removed';
    });
  }

  /**
   * Records which pools (tree targets and transfer destinations) and hold clips the draft names,
   * so neither can be deleted under a live draft. The named rows are share-locked: a concurrent
   * pool or clip delete waits for this draft, then sees it.
   */
  private async namePools(
    client: PoolClient,
    pointId: string,
    draft: RoutingPointDraft,
  ): Promise<void> {
    const links = [
      {
        table: 'ovo_routing_point_pools',
        column: 'pool_id',
        rows: 'ovo_routing_pools',
        ids: routingPoolIds(draft),
      },
      {
        table: 'ovo_routing_point_audio',
        column: 'audio_id',
        rows: 'ovo_routing_audio',
        ids: routingAudioIds(draft),
      },
    ] as const;
    for (const { table, column, rows, ids } of links) {
      const sorted = [...ids].sort();
      await client.query(
        `SELECT id FROM ${rows} WHERE organization_id = $1 AND id = ANY($2::uuid[])
         ORDER BY id FOR SHARE`,
        [this.organizationId, sorted],
      );
      await client.query(`DELETE FROM ${table} WHERE organization_id = $1 AND point_id = $2`, [
        this.organizationId,
        pointId,
      ]);
      await client.query(
        `INSERT INTO ${table} (organization_id, point_id, ${column})
         SELECT $1, $2, unnest($3::uuid[])`,
        [this.organizationId, pointId, sorted],
      );
    }
  }
}
