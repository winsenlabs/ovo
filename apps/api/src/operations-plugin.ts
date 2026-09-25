import { definePlugin } from '@winsendotai/ovo-runtime';
import type { PluginDefinition } from '@winsendotai/ovo-runtime';
import { Cap } from '@winsendotai/ovo-contracts';
import type { ControlStore } from '@winsendotai/ovo-plugin-storage';
import type { SecretManager } from '@winsendotai/ovo-plugin-secrets';
import { ApiCarrierHandoffPort } from './carrier-handoff.ts';
import {
  createOperationsRuntime,
  type CreateOperationsRuntimeOptions,
} from './operations-runtime.ts';

export const OPERATIONS_RUNTIME_PLUGIN_ID = '@winsendotai/ovo-api-operations-runtime';
export function createOperationsRuntimePlugin(
  options: CreateOperationsRuntimeOptions & {
    pluginCatalog?: readonly PluginDefinition[];
  },
) {
  return definePlugin(
    {
      id: OPERATIONS_RUNTIME_PLUGIN_ID,
      version: '1.0.0',
      contractVersion: 2,
      scope: 'process',
      kind: 'host',
      requires: [Cap.controlStore, Cap.secretManager],
      optional: [Cap.carrierControl],
      provides: [Cap.operations],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: [],
    },
    async (ctx, config) => {
      const controls = ctx.all(Cap.carrierControl);
      const carrierPort =
        options.pluginCatalog && controls.size
          ? new ApiCarrierHandoffPort({
              organizationId: options.organizationId,
              catalog: options.pluginCatalog,
              ctx,
              store: ctx.get(Cap.controlStore) as ControlStore,
              secrets: ctx.get(Cap.secretManager) as SecretManager,
              environment: options.environment ?? process.env,
            })
          : undefined;
      const runtime = await createOperationsRuntime({
        maxConnections: 2,
        ...options,
        handoffProvider: carrierPort ?? options.handoffProvider,
      });
      carrierPort?.attach(runtime.service.pool);
      ctx.provide(Cap.operations, runtime.service);
      ctx.effect(() => () => runtime.close());
    },
  );
}
