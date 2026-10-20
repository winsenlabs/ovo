import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { PostgresHumanQueueService } from '../../src/human-queue/postgres/service.ts';
import { MemoryClock } from '../../src/human-queue/memory-support.ts';
import { runOperationsMigrations } from '../../src/migrations.ts';
import { routingSchema } from '../routing-fixture.ts';
import { T0, type HqHarness } from './harness.ts';

/** A throwaway schema with every operations migration applied. */
export async function humanQueueSchema(url: string) {
  const db = await routingSchema(url);
  await runOperationsMigrations(db.pool);
  return db;
}

/**
 * A harness on a shared schema. Each test gets its own organization, so tests do not see each
 * other's rows; the organization is `ORG` for the suite's workspace checks, hence one per harness.
 */
export function postgresHarness(
  pool: Pool,
  organizationId = `org-${randomUUID()}`,
): HqHarness & {
  organizationId: string;
  pool: Pool;
} {
  const clock = new MemoryClock(T0);
  const service = new PostgresHumanQueueService(pool, organizationId, {
    enabled: true,
    now: clock.now,
  });
  const known = new Set<string>();
  return {
    org: organizationId,
    organizationId,
    pool,
    service,
    clock,
    async bindPoint(pointId, queueIds) {
      if (!known.has(pointId)) {
        // A routing point row stands in for a draft that binds these queues; the link rows are what
        // the guard reads (points.ts keeps them in step with real drafts).
        await pool.query(
          `INSERT INTO ovo_routing_points (organization_id, id, name, draft)
           VALUES ($1, $2, $3, '{}'::jsonb)`,
          [organizationId, pointId, `point ${pointId}`],
        );
        known.add(pointId);
      }
      await pool.query(
        'DELETE FROM ovo_hq_point_queues WHERE organization_id = $1 AND point_id = $2',
        [organizationId, pointId],
      );
      if (queueIds === undefined) {
        await pool.query(
          'UPDATE ovo_routing_points SET deleted_at = now() WHERE organization_id = $1 AND id = $2',
          [organizationId, pointId],
        );
        return;
      }
      for (const queueId of queueIds)
        await pool.query(
          'INSERT INTO ovo_hq_point_queues (organization_id, point_id, queue_id) VALUES ($1, $2, $3)',
          [organizationId, pointId, queueId],
        );
    },
    async events(ticketId) {
      const result = await pool.query(
        `SELECT kind, source_event_id, payload FROM ovo_hq_ticket_events
         WHERE organization_id = $1 AND ticket_id = $2 ORDER BY seq`,
        [organizationId, ticketId],
      );
      return result.rows.map((row) => ({
        kind: row.kind as string,
        ...(row.source_event_id ? { sourceEventId: row.source_event_id as string } : {}),
        payload: row.payload as Record<string, unknown>,
      }));
    },
    close: async () => undefined,
  };
}
