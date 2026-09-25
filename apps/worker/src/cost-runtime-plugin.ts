import { Cap } from '@winsendotai/ovo-contracts';
import type { CostLedgerService } from '@winsendotai/ovo-plugin-ledger';
import type { DurableJobStore, TelephonyControl } from '@winsendotai/ovo-plugin-orchestration';
import type { ControlStore } from '@winsendotai/ovo-plugin-storage';
import { definePlugin, PluginRegistry, type PluginDefinition } from '@winsendotai/ovo-runtime';
import type { SessionDefaults } from '@winsendotai/ovo-session-host';
import { ProductionWorkerCostRuntime } from './cost-runtime.ts';

export function createWorkerCostRuntimePlugin(input: {
  ledger: CostLedgerService;
  control: ControlStore;
  catalog?: readonly PluginDefinition[];
  defaults?: SessionDefaults;
}) {
  return definePlugin(
    {
      id: '@winsendotai/ovo-worker/cost-runtime',
      version: '0.1.0',
      contractVersion: 1,
      scope: 'process',
      requires: [Cap.orchestrationStore, Cap.legacyTelephony],
      provides: [Cap.workerCostRuntime],
      configSchema: {
        type: 'object',
        required: ['workerId'],
        properties: {
          workerId: { type: 'string' },
          requirePolicy: { type: 'boolean', default: true },
        },
        additionalProperties: false,
      },
      secretFields: [],
    },
    (ctx, config) => {
      if (typeof config.workerId !== 'string' || !config.workerId)
        throw new Error('Missing workerId');
      ctx.provide(
        Cap.workerCostRuntime,
        new ProductionWorkerCostRuntime(
          input.ledger,
          input.control,
          ctx.get(Cap.orchestrationStore) as DurableJobStore,
          ctx.get(Cap.legacyTelephony) as TelephonyControl,
          config.workerId,
          config.requirePolicy !== false,
          input.catalog ? new PluginRegistry(input.catalog) : undefined,
          input.defaults,
        ),
      );
    },
  );
}
