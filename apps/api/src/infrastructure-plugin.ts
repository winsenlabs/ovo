import { definePlugin } from '@winsendotai/ovo-runtime';
import {
  createInfrastructureRuntime,
  type InfrastructureRuntimeConfig,
} from './infrastructure-runtime.ts';

export const INFRASTRUCTURE_RUNTIME_PLUGIN_ID = '@winsendotai/ovo-api-infrastructure-runtime';
export function createInfrastructureRuntimePlugin(options: InfrastructureRuntimeConfig) {
  return definePlugin(
    {
      id: INFRASTRUCTURE_RUNTIME_PLUGIN_ID,
      version: '1.0.0',
      contractVersion: 1,
      scope: 'process',
      requires: [],
      provides: ['ovo.infrastructure'],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: [],
    },
    async (ctx, config) => {
      const runtime = await createInfrastructureRuntime(options);
      try {
        await runtime.plugin.apply(ctx, config);
      } catch (error) {
        await runtime.close();
        throw error;
      }
    },
  );
}
