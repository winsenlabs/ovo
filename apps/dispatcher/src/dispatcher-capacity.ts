import type {
  CapacitySignalInput,
  CampaignCapacityDemand,
  PostgresOrchestrationStore,
} from '@winsendotai/ovo-plugin-orchestration';
import type { PostgresOperationsService } from '@winsendotai/ovo-plugin-operations';

type Environment = Record<string, string | undefined>;

export function positiveInteger(env: Environment, name: string, fallback: number): number {
  const value = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative integer`);
  return value;
}

export function inboundEnabled(env: Environment): boolean {
  const value = env.OVO_INBOUND_ENABLED ?? 'false';
  if (value !== 'true' && value !== 'false')
    throw new Error('OVO_INBOUND_ENABLED must be true or false');
  return value === 'true';
}

export async function readDispatcherCapacityInput(input: {
  store: PostgresOrchestrationStore;
  operations: PostgresOperationsService;
  env: Environment;
  readProvisionedTasks(): Promise<number>;
  nowMs?: () => number;
}): Promise<CapacitySignalInput> {
  const [snapshot, provisionedTasks, campaigns] = await Promise.all([
    input.store.readCapacitySnapshot(),
    input.readProvisionedTasks(),
    readCampaignCapacity(input.operations),
  ]);
  if (!Number.isSafeInteger(provisionedTasks) || provisionedTasks < 0)
    throw new Error('Provisioned task count is invalid');
  const starting = snapshot.counts.starting + Math.max(0, provisionedTasks - snapshot.counts.total);
  const counts = {
    ...snapshot.counts,
    starting,
    total:
      snapshot.counts.readyIdle +
      snapshot.counts.reserved +
      snapshot.counts.active +
      starting +
      snapshot.counts.draining,
  };
  return {
    nowMs: Math.max(input.nowMs?.() ?? Date.now(), snapshot.observedAtMs),
    observedAtMs: snapshot.observedAtMs,
    maxMetricAgeMs: positiveInteger(input.env, 'OVO_CAPACITY_MAX_AGE_MS', 15_000),
    counts,
    eligibleDueJobs: snapshot.eligibleUnclaimed,
    admissionHorizon: positiveInteger(input.env, 'OVO_PERMITTED_STARTS', 10),
    campaigns,
    prewarmLeadSeconds: positiveInteger(input.env, 'OVO_PREWARM_LEAD_SECONDS', 600),
    inboundEnabled: inboundEnabled(input.env),
    inboundWarmFloor: positiveInteger(input.env, 'OVO_INBOUND_WARM_FLOOR', 0),
    configuredMax: positiveInteger(input.env, 'OVO_WORKER_MAX_CAPACITY', 100),
    carrierConcurrency: positiveInteger(input.env, 'OVO_CARRIER_CONCURRENCY', 100),
    providerConcurrency: positiveInteger(input.env, 'OVO_PROVIDER_CONCURRENCY', 100),
    spendPermitted: positiveInteger(input.env, 'OVO_SPEND_PERMITTED_STARTS', 100),
    provisionedTasks,
    oldestEligibleJobAgeSeconds: snapshot.oldestEligibleJobAgeSeconds,
  };
}

async function readCampaignCapacity(
  operations: PostgresOperationsService,
): Promise<CampaignCapacityDemand[]> {
  const column = await operations.pool.query<{ present: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='ovo_ops_campaigns'
        AND column_name='max_concurrency') AS present`,
  );
  if (!column.rows[0]?.present) {
    const active = await operations.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ovo_ops_campaigns
       WHERE organization_id=$1 AND status IN ('running','scheduled')`,
      [operations.organizationId],
    );
    if (Number(active.rows[0]?.count ?? 0) > 0)
      throw new Error('Campaign capacity requires the max_concurrency migration');
    return [];
  }
  const rows = await operations.pool.query<{
    status: string;
    schedule_at: Date;
    max_concurrency: number;
    due_queued: string;
    admitted: string;
    contacts: string;
  }>(
    `SELECT c.status,c.schedule_at,c.max_concurrency,
       count(k.id) FILTER (WHERE k.state='queued' AND k.not_before<=now())::text AS due_queued,
       count(k.id) FILTER (WHERE k.state IN ('admitted','dialing'))::text AS admitted,
       count(k.id) FILTER (WHERE k.state='queued')::text AS contacts
     FROM ovo_ops_campaigns c LEFT JOIN ovo_ops_campaign_contacts k ON k.campaign_id=c.id
     WHERE c.organization_id=$1 AND c.status IN ('running','scheduled')
     GROUP BY c.id`,
    [operations.organizationId],
  );
  return rows.rows.map((row) => ({
    running: row.status === 'running',
    scheduledAtMs: row.schedule_at.getTime(),
    maxConcurrency: row.max_concurrency,
    dueQueuedContacts: Number(row.due_queued),
    alreadyAdmitted: Number(row.admitted),
    contacts: Number(row.contacts),
  }));
}
