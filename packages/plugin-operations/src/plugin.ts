import { definePlugin } from '@winsendotai/ovo-runtime';
import { PostgresOperationsService } from './service.ts';
import type { HandoffProviderPort } from './types.ts';
import type { OperationsServiceConfig } from './types.ts';

export const OPERATIONS_SERVICE_KEY = 'ovo.operations';

export function createOperationsPlugin(input: {
  organizationId: string;
  handoffProvider?: HandoffProviderPort;
  connectionString: string;
  maxConnections?: number;
  config?: OperationsServiceConfig;
}) {
  return definePlugin(
    {
      id: 'ovo.operations.postgres',
      version: '1.0.0',
      contractVersion: 1,
      scope: 'process',
      provides: [OPERATIONS_SERVICE_KEY],
      requires: [],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: [],
      ui: { label: 'Single-organization operations' },
    },
    async (ctx) => {
      const service = new PostgresOperationsService(input);
      try {
        await service.migrate();
      } catch (error) {
        await service.close();
        throw error;
      }
      ctx.provide(OPERATIONS_SERVICE_KEY, service);
      ctx.effect(() => () => service.close());
    },
  );
}
