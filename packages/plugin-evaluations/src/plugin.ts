import { definePlugin } from '@winsendotai/ovo-runtime';
import { PostgresEvaluationService } from './service.ts';

export const EVALUATION_SERVICE_KEY = 'ovo.evaluations';

export function createEvaluationsPlugin() {
  return definePlugin(
    {
      id: '@winsendotai/ovo-plugin-evaluations',
      version: '1.0.0',
      contractVersion: 1,
      scope: 'process',
      requires: [],
      provides: [EVALUATION_SERVICE_KEY],
      configSchema: {
        type: 'object',
        required: ['databaseUrl'],
        properties: {
          databaseUrl: { type: 'string', minLength: 1 },
          maxConnections: { type: 'integer', minimum: 1, maximum: 20 },
        },
        additionalProperties: false,
      },
      secretFields: ['databaseUrl'],
      ui: { label: 'Evaluation service' },
    },
    async (ctx, config) => {
      const service = new PostgresEvaluationService({
        connectionString: String(config.databaseUrl),
        max: config.maxConnections === undefined ? 4 : Number(config.maxConnections),
      });
      try {
        await service.migrate();
      } catch (error) {
        await service.close();
        throw error;
      }
      ctx.provide(EVALUATION_SERVICE_KEY, service);
      ctx.effect(() => () => service.close());
    },
  );
}
