import { definePlugin } from '@winsendotai/ovo-runtime';
import { PostgresCostLedger } from './postgres.ts';
import { calculateInrScenario } from './scenario.ts';

export const COST_LEDGER_SERVICE_KEY = 'ovo.cost-ledger';
export const COST_SCENARIO_SERVICE_KEY = 'ovo.cost-scenario';
export const COST_LEDGER_PLUGIN_ID = '@winsendotai/ovo-plugin-ledger';

export function createCostLedgerPlugin() {
  return definePlugin(
    {
      id: COST_LEDGER_PLUGIN_ID,
      version: '1.0.0',
      contractVersion: 1,
      scope: 'process',
      requires: [],
      provides: [COST_LEDGER_SERVICE_KEY, COST_SCENARIO_SERVICE_KEY],
      configSchema: {
        type: 'object',
        required: ['databaseUrl'],
        properties: { databaseUrl: { type: 'string', minLength: 1 } },
        additionalProperties: false,
      },
      secretFields: ['databaseUrl'],
      ui: { label: 'Cost ledger' },
    },
    async (ctx, config) => {
      const ledger = new PostgresCostLedger({
        connectionString: String(config.databaseUrl),
        max: 2,
      });
      try {
        await ledger.migrate();
      } catch (error) {
        await ledger.close();
        throw error;
      }
      ctx.provide(COST_LEDGER_SERVICE_KEY, ledger);
      ctx.provide(COST_SCENARIO_SERVICE_KEY, { calculate: calculateInrScenario });
      ctx.effect(() => () => ledger.close());
    },
  );
}
