import { definePlugin } from '@winsendotai/ovo-runtime';
import {
  createOperationsRuntime,
  type CreateOperationsRuntimeOptions,
} from './operations-runtime.ts';

export const OPERATIONS_RUNTIME_PLUGIN_ID = '@winsendotai/ovo-api-operations-runtime';
export function createOperationsRuntimePlugin(options: CreateOperationsRuntimeOptions) {
  return definePlugin(
    {
      id: OPERATIONS_RUNTIME_PLUGIN_ID,
      version: '1.0.0',
      contractVersion: 1,
      scope: 'process',
      requires: [],
      provides: ['ovo.operations'],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: [],
    },
    async (ctx, config) => {
      const runtime = await createOperationsRuntime({ maxConnections: 2, ...options });
      try {
        await runtime.plugin.apply(ctx, config);
      } catch (error) {
        await runtime.close();
        throw error;
      }
    },
  );
}
