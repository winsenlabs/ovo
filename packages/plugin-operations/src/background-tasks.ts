import { Cap, type CarrierControlFactory } from '@winsendotai/ovo-contracts';
import { definePlugin } from '@winsendotai/ovo-runtime';
import { CampaignDriver, type CampaignCapacityPort } from './campaign-driver.ts';
import { HumanQueueSweeperTask } from './human-queue/sweeper-task.ts';
import { PostgresOperationsService } from './service.ts';

export const plugins = [
  definePlugin(
    {
      id: '@winsendotai/ovo-plugin-operations/campaign-driver',
      version: '1.0.0',
      contractVersion: 2,
      kind: 'infra',
      scope: 'process',
      requires: [Cap.operations, Cap.orchestrationStore, Cap.carrierControl],
      provides: [Cap.backgroundTask],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: [],
    },
    (ctx) => {
      const operations = ctx.get(Cap.operations) as PostgresOperationsService;
      if (!(operations instanceof PostgresOperationsService))
        throw new Error('Campaign driver requires Postgres operations');
      const driver = new CampaignDriver(
        operations.pool,
        operations.organizationId,
        ctx.get(Cap.orchestrationStore) as CampaignCapacityPort,
        ctx.all(Cap.carrierControl) as ReadonlyMap<string, CarrierControlFactory>,
        operations.compliance.gate,
      );
      ctx.provide(Cap.backgroundTask, {
        id: 'campaign-driver',
        intervalMs: 1_000,
        tick: (signal: AbortSignal) => driver.tick(signal).then(() => undefined),
      });
    },
  ),
  definePlugin(
    {
      id: '@winsendotai/ovo-plugin-operations/human-queue-sweeper',
      version: '1.0.0',
      contractVersion: 2,
      kind: 'infra',
      scope: 'process',
      requires: [Cap.operations],
      provides: [Cap.backgroundTask],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: [],
    },
    (ctx) => {
      const operations = ctx.get(Cap.operations) as PostgresOperationsService;
      if (!(operations instanceof PostgresOperationsService))
        throw new Error('The human queue sweeper requires Postgres operations');
      const task = new HumanQueueSweeperTask(operations.humanQueues);
      ctx.provide(Cap.backgroundTask, {
        id: task.id,
        intervalMs: task.intervalMs,
        tick: () => task.tick(),
      });
    },
  ),
];
