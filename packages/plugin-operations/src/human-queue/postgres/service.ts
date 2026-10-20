import type { Pool } from 'pg';
import { HumanQueueEngine } from '../engine.ts';
import { PgHqStore } from './store.ts';

/**
 * The human-queue service on the operations database. `humanQueueEnabled` is
 * OVO_HUMAN_QUEUE_ENABLED: off, the tables exist and stay empty and nothing calls this.
 */
export class PostgresHumanQueueService extends HumanQueueEngine {
  constructor(
    pool: Pool,
    organizationId: string,
    options: { enabled: boolean; presenceTtlSeconds?: number; now?: () => Date },
  ) {
    super(new PgHqStore(pool, organizationId, options.now ?? (() => new Date())), {
      organizationId,
      enabled: options.enabled,
      ...(options.now ? { now: options.now } : {}),
      ...(options.presenceTtlSeconds ? { presenceTtlSeconds: options.presenceTtlSeconds } : {}),
    });
  }
}
