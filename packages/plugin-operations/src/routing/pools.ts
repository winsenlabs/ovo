import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { RoutingPoolDefinition, type RoutingPool } from '@winsendotai/ovo-contracts';
import { boundedLimit, transaction } from '../database.ts';
import {
  isUniqueViolation,
  pointsNaming,
  POOL_COLUMNS,
  presentPool,
  RoutingPoolNameTakenError,
  uuidOrNull,
  type PoolRow,
} from './rows.ts';

const NAME_INDEX = 'ovo_routing_pools_name_idx';
const LINK = { table: 'ovo_routing_point_pools', column: 'pool_id' } as const;

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

  /** Excludes deleted pools unless `includeDeleted`; a deleted pool then carries `deletedAt`. */
  async get(
    id: string,
    options: { includeDeleted?: boolean } = {},
  ): Promise<(RoutingPool & { deletedAt?: string }) | undefined> {
    if (!uuidOrNull(id)) return undefined;
    const result = await this.pool.query<PoolRow>(
      `SELECT ${POOL_COLUMNS} FROM ovo_routing_pools
       WHERE organization_id = $1 AND id = $2 AND ($3 OR deleted_at IS NULL)`,
      [this.organizationId, id, options.includeDeleted === true],
    );
    return result.rows[0] ? presentPool(result.rows[0]) : undefined;
  }

  /** Live point ids whose current draft names the pool (tree targets and transfer destinations). */
  usedBy(id: string): Promise<string[]> {
    return pointsNaming(this.pool, this.organizationId, LINK, id);
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
      const users = await pointsNaming(client, this.organizationId, LINK, id);
      if (users.length) return { inUseBy: users };
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
