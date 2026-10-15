import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { RoutingPoolDefinition, type RoutingPool } from '@winsendotai/ovo-contracts';
import { boundedLimit, transaction } from '../database.ts';
import {
  isUniqueViolation,
  POOL_COLUMNS,
  presentPool,
  RoutingPoolNameTakenError,
  uuidOrNull,
  type PoolRow,
} from './rows.ts';

const NAME_INDEX = 'ovo_routing_pools_name_idx';

/** Agent pools: versioned definitions, soft-deleted so releases keep their history. */
export class RoutingPools {
  constructor(
    private readonly pool: Pool,
    private readonly organizationId: string,
  ) {}

  async list(limit: number, cursor?: string): Promise<RoutingPool[]> {
    const result = await this.pool.query<PoolRow>(
      `SELECT ${POOL_COLUMNS} FROM ovo_routing_pools
       WHERE organization_id = $1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR id > $2)
       ORDER BY id LIMIT $3`,
      [this.organizationId, uuidOrNull(cursor), boundedLimit(limit)],
    );
    return result.rows.map(presentPool);
  }

  async get(id: string): Promise<RoutingPool | undefined> {
    if (!uuidOrNull(id)) return undefined;
    const result = await this.pool.query<PoolRow>(
      `SELECT ${POOL_COLUMNS} FROM ovo_routing_pools
       WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [this.organizationId, id],
    );
    return result.rows[0] ? presentPool(result.rows[0]) : undefined;
  }

  async create(definition: RoutingPoolDefinition): Promise<RoutingPool> {
    const parsed = RoutingPoolDefinition.parse(definition);
    const result = await this.named(parsed.name, () =>
      this.pool.query<PoolRow>(
        `INSERT INTO ovo_routing_pools (organization_id, id, name, definition)
         VALUES ($1, $2, $3, $4::jsonb) RETURNING ${POOL_COLUMNS}`,
        [this.organizationId, randomUUID(), parsed.name, JSON.stringify(parsed)],
      ),
    );
    return presentPool(result.rows[0]!);
  }

  /** Undefined when the pool moved past `expectedVersion` or does not exist. */
  async update(
    id: string,
    definition: RoutingPoolDefinition,
    expectedVersion: number,
  ): Promise<RoutingPool | undefined> {
    if (!uuidOrNull(id)) return undefined;
    const parsed = RoutingPoolDefinition.parse(definition);
    const result = await this.named(parsed.name, () =>
      this.pool.query<PoolRow>(
        `UPDATE ovo_routing_pools SET name = $3, definition = $4::jsonb,
           version = version + 1, updated_at = now()
         WHERE organization_id = $1 AND id = $2 AND version = $5 AND deleted_at IS NULL
         RETURNING ${POOL_COLUMNS}`,
        [this.organizationId, id, parsed.name, JSON.stringify(parsed), expectedVersion],
      ),
    );
    return result.rows[0] ? presentPool(result.rows[0]) : undefined;
  }

  /** Refused while a live point's draft names the pool; releases keep their own frozen copy. */
  async remove(
    id: string,
    expectedVersion: number,
  ): Promise<'removed' | 'conflict' | { inUseBy: string[] }> {
    if (!uuidOrNull(id)) return 'conflict';
    return transaction(this.pool, async (client) => {
      const locked = await client.query<{ version: string }>(
        `SELECT version FROM ovo_routing_pools
         WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`,
        [this.organizationId, id],
      );
      if (Number(locked.rows[0]?.version) !== expectedVersion) return 'conflict';
      const users = await client.query<{ point_id: string }>(
        `SELECT pp.point_id FROM ovo_routing_point_pools pp
         JOIN ovo_routing_points p ON p.organization_id = pp.organization_id AND p.id = pp.point_id
         WHERE pp.organization_id = $1 AND pp.pool_id = $2 AND p.deleted_at IS NULL
         ORDER BY pp.point_id`,
        [this.organizationId, id],
      );
      if (users.rowCount) return { inUseBy: users.rows.map((row) => row.point_id) };
      await client.query(
        `UPDATE ovo_routing_pools SET deleted_at = now(), updated_at = now()
         WHERE organization_id = $1 AND id = $2`,
        [this.organizationId, id],
      );
      return 'removed';
    });
  }

  private async named<T>(name: string, write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      if (isUniqueViolation(error, NAME_INDEX)) throw new RoutingPoolNameTakenError(name);
      throw error;
    }
  }
}
