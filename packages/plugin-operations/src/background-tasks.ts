import { Cap, type CarrierControlFactory } from '@winsendotai/ovo-contracts';
import { definePlugin } from '@winsendotai/ovo-runtime';
import { CampaignDriver, type CampaignCapacityPort } from './campaign-driver.ts';
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
      );
      ctx.provide(Cap.backgroundTask, {
        id: 'campaign-driver',
        intervalMs: 1_000,
        tick: (signal: AbortSignal) => driver.tick(signal).then(() => undefined),
      });
    },
  ),
];
