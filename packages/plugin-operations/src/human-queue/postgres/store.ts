import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { HumanQueueDefinition } from '@winsendotai/ovo-contracts';
import { boundedLimit, transaction } from '../../database.ts';
import { isUniqueViolation, uuidOrNull } from '../../routing/rows.ts';
import type { QueueRecord } from '../rows.ts';
import { HumanQueueNameTakenError } from '../service.ts';
import type { HqStore, HqTx, QueueAdmin } from '../store.ts';
import { queueFromRow } from './columns.ts';
import { PgTx } from './tx.ts';

const NAME_INDEX = 'ovo_hq_queues_name_idx';
const teamsOf = (definition: HumanQueueDefinition) =>
  definition.kind === 'managed' ? definition.teamIds : [];

/** The PostgreSQL store of the human-queue tables, one organization. */
export class PgHqStore implements HqStore {
  constructor(
    private readonly pool: Pool,
    private readonly org: string,
    private readonly now: () => Date,
  ) {}

  run<T>(work: (tx: HqTx) => Promise<T>): Promise<T> {
    return transaction(this.pool, (client) => work(new PgTx(client, this.org, this.now)));
  }

  /** Holds a transaction-scoped advisory lock for the pass; a caller that cannot get it does nothing. */
  singleFlight<T>(name: string, work: (tx: HqTx) => Promise<T>): Promise<T | undefined> {
    return transaction(this.pool, async (client) => {
      const lock = await client.query<{ held: boolean }>(
        'SELECT pg_try_advisory_xact_lock(hashtext($1), hashtext($2)) AS held',
        [`ovo-hq-single-flight:${this.org}`, name],
      );
      return lock.rows[0]!.held ? work(new PgTx(client, this.org, this.now)) : undefined;
    });
  }

  readonly queues: QueueAdmin = {
    list: async (limit, cursor) => {
      const result = await this.pool.query(
        `SELECT * FROM ovo_hq_queues
         WHERE organization_id = $1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR id > $2)
         ORDER BY id LIMIT $3`,
        [this.org, uuidOrNull(cursor), boundedLimit(limit)],
      );
      return result.rows.map(queueFromRow);
    },
    get: async (id) => {
      if (!uuidOrNull(id)) return undefined;
      const result = await this.pool.query(
        'SELECT * FROM ovo_hq_queues WHERE organization_id = $1 AND id = $2',
        [this.org, id],
      );
      return result.rows[0] ? queueFromRow(result.rows[0]) : undefined;
    },
    insert: (definition, at) =>
      this.named(definition.name, async () => {
        const result = await this.pool.query(
          `INSERT INTO ovo_hq_queues (organization_id, id, name, kind, definition, team_ids,
             created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::text[], $7, $7) RETURNING *`,
          [
            this.org,
            randomUUID(),
            definition.name,
            definition.kind,
            JSON.stringify(definition),
            teamsOf(definition),
            at,
          ],
        );
        return queueFromRow(result.rows[0]);
      }),
    update: (id, definition, expectedVersion, at) =>
      this.named(definition.name, async () => {
        if (!uuidOrNull(id)) return undefined;
        const result = await this.pool.query(
          `UPDATE ovo_hq_queues SET name = $3, kind = $4, definition = $5::jsonb, team_ids = $6::text[],
             version = version + 1, updated_at = $7
           WHERE organization_id = $1 AND id = $2 AND version = $8 AND deleted_at IS NULL
           RETURNING *`,
          [
            this.org,
            id,
            definition.name,
            definition.kind,
            JSON.stringify(definition),
            teamsOf(definition),
            at,
            expectedVersion,
          ],
        );
        return result.rows[0] ? queueFromRow(result.rows[0]) : undefined;
      }),
    usedBy: (id) => this.usersOf(this.pool, id),
    softDelete: async (id, expectedVersion, at) => {
      if (!uuidOrNull(id)) return 'conflict';
      return transaction(this.pool, async (client) => {
        const locked = await client.query<{ version: string }>(
          `SELECT version FROM ovo_hq_queues
           WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`,
          [this.org, id],
        );
        if (Number(locked.rows[0]?.version) !== expectedVersion) return 'conflict' as const;
        const inUseBy = await this.usersOf(client, id);
        if (inUseBy.length) return { inUseBy };
        await client.query(
          'UPDATE ovo_hq_queues SET deleted_at = $3, updated_at = $3 WHERE organization_id = $1 AND id = $2',
          [this.org, id, at],
        );
        return 'removed' as const;
      });
    },
  };

  private async usersOf(db: Pick<Pool, 'query'>, queueId: string): Promise<string[]> {
    if (!uuidOrNull(queueId)) return [];
    const result = await db.query<{ point_id: string }>(
      `SELECT link.point_id FROM ovo_hq_point_queues link
       JOIN ovo_routing_points p ON p.organization_id = link.organization_id AND p.id = link.point_id
       WHERE link.organization_id = $1 AND link.queue_id = $2 AND p.deleted_at IS NULL
       ORDER BY link.point_id`,
      [this.org, queueId],
    );
    return result.rows.map((row) => row.point_id);
  }

  private async named<T>(name: string, write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      if (isUniqueViolation(error, NAME_INDEX)) throw new HumanQueueNameTakenError(name);
      throw error;
    }
  }
}

export type { QueueRecord };
