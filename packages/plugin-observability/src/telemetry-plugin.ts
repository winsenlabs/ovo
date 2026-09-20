import { definePlugin } from '@winsendotai/ovo-runtime';
import { PostgresTelemetryStore } from './postgres-telemetry.ts';
import { BufferedTelemetryWriter } from './telemetry-ingestion.ts';

export const TELEMETRY_PLUGIN_ID = '@winsendotai/ovo-plugin-telemetry';

export function createTelemetryPlugin(databaseUrl: string) {
  return definePlugin(
    {
      id: TELEMETRY_PLUGIN_ID,
      version: '1.0.0',
      contractVersion: 1,
      scope: 'process',
      provides: ['ovo.telemetry', 'ovo.telemetry-store'],
      requires: [],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: [],
    },
    async (ctx) => {
      const repository = await PostgresTelemetryStore.open({
        connectionString: databaseUrl,
        maxConnections: 2,
      });
      const writer = new BufferedTelemetryWriter(repository);
      ctx.provide('ovo.telemetry', writer);
      ctx.provide('ovo.telemetry-store', repository);
      ctx.effect(() => async () => {
        await writer.close();
        await repository.close();
      });
    },
  );
}
