import { definePlugin } from '@winsendotai/ovo-runtime';
import type { ControlStore } from '@winsendotai/ovo-plugin-storage';
import { createEvaluationApiRuntime } from './evaluation-runtime.ts';

export const EVALUATION_RUNTIME_PLUGIN_ID = '@winsendotai/ovo-api-evaluation-runtime';
export function createEvaluationRuntimePlugin(databaseUrl: string) {
  return definePlugin(
    {
      id: EVALUATION_RUNTIME_PLUGIN_ID,
      version: '1.0.0',
      contractVersion: 1,
      scope: 'process',
      requires: ['controlStore'],
      provides: ['ovo.evaluations'],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: [],
    },
    async (ctx) => {
      const runtime = await createEvaluationApiRuntime({
        databaseUrl,
        store: ctx.get('controlStore') as ControlStore,
        maxConnections: 2,
        onError: () => console.error('Evaluation background job failed; retry remains durable'),
      });
      ctx.effect(() => () => runtime.stop());
      ctx.provide('ovo.evaluations', runtime.service);
      runtime.start();
    },
  );
}
