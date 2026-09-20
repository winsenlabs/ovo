import { definePlugin, type Context } from '@winsendotai/ovo-runtime';
import type { ControlStore } from '@winsendotai/ovo-plugin-storage';
import {
  createProductionRecordingsPlugin,
  PRODUCTION_RECORDINGS_CONFIG_SCHEMA,
  RECORDING_SERVICE_KEYS,
  type ProductionRecordingServices,
  type ProductionRecordingsConfig,
} from '@winsendotai/ovo-plugin-recordings/production';
import { createRecordingExportInputLoader } from './routes/recording-lifecycle.ts';

export type ApiProductionRecordingsOptions = ProductionRecordingsConfig;

export const API_PRODUCTION_RECORDING_SERVICE_KEY = RECORDING_SERVICE_KEYS.production;
export { PRODUCTION_RECORDINGS_CONFIG_SCHEMA };

export function createRecordingRuntimePlugin(options: ApiProductionRecordingsOptions) {
  const template = createApiProductionRecordingsPlugin(options, {
    listCallEvents: async () => {
      throw new Error('Recording runtime is not initialized');
    },
  });
  return definePlugin({ ...template.manifest, requires: ['controlStore'] }, async (ctx, config) => {
    const plugin = createApiProductionRecordingsPlugin(
      options,
      ctx.get('controlStore') as ControlStore,
    );
    await plugin.apply(ctx, config);
  });
}

/** Binds exports to repository-verified workspace/call metadata and durable call events. */
export function createApiProductionRecordingsPlugin(
  options: ApiProductionRecordingsOptions,
  store: Pick<ControlStore, 'listCallEvents'>,
) {
  return createProductionRecordingsPlugin(options, {
    loadExportInput: createRecordingExportInputLoader(store),
  });
}

export function getProductionRecordingServices(
  context: Pick<Context, 'get'>,
): ProductionRecordingServices | undefined {
  return context.get(API_PRODUCTION_RECORDING_SERVICE_KEY) as
    ProductionRecordingServices | undefined;
}
