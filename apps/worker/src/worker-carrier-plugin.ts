import { Cap } from '@winsendotai/ovo-contracts';
import {
  definePlugin,
  manifestKeys,
  PluginRegistry,
  type PluginDefinition,
} from '@winsendotai/ovo-runtime';
import type { ControlStore } from '@winsendotai/ovo-plugin-storage';
import type { SecretManager } from '@winsendotai/ovo-plugin-secrets';
import type { PostgresOrchestrationStore } from '@winsendotai/ovo-plugin-orchestration';
import type { InstalledCarrierControl, SessionDefaults } from '@winsendotai/ovo-session-host';
import { WorkerCarrierRuntime, legacyCarrierControl } from './carrier-runtime.ts';

/** Process graph node: installed carrier factories become the only live carrier control. */
export function createWorkerCarrierRuntimePlugin(input: {
  catalog: readonly PluginDefinition[];
  controlStore: ControlStore;
  secrets: SecretManager;
  defaults: SessionDefaults;
  env: Readonly<Record<string, string | undefined>>;
  publicBaseUrl: string;
  routeSecret: string;
}): { definition: PluginDefinition; runtime: () => WorkerCarrierRuntime } {
  let selected: WorkerCarrierRuntime | undefined;
  const definition = definePlugin(
    {
      id: 'ovo.worker.carrier-runtime',
      version: '1.0.0',
      contractVersion: 2,
      scope: 'process',
      kind: 'host',
      provides: [Cap.legacyTelephony],
      requires: [Cap.carrierControl, Cap.orchestrationStore],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: [],
    },
    (ctx) => {
      const registry = new PluginRegistry(input.catalog);
      const controls = new Map<string, InstalledCarrierControl>();
      for (const definition of input.catalog) {
        const manifest = manifestKeys(definition.manifest);
        if (!manifest.provides.some((entry) => entry.key === Cap.carrierControl)) continue;
        const factory = ctx
          .all(Cap.carrierControl)
          .get(manifest.manifest.provider ?? definition.manifest.id);
        if (factory)
          controls.set(definition.manifest.id, { version: definition.manifest.version, factory });
      }
      const orchestration = ctx.get(Cap.orchestrationStore) as PostgresOrchestrationStore;
      selected = new WorkerCarrierRuntime({
        registry,
        controls,
        store: input.controlStore,
        secrets: input.secrets,
        defaults: input.defaults,
        env: input.env,
        publicBaseUrl: input.publicBaseUrl,
        routeSecret: input.routeSecret,
      });
      ctx.provide(Cap.legacyTelephony, legacyCarrierControl(selected, orchestration));
    },
  );
  return {
    definition,
    runtime: () => {
      if (!selected) throw new Error('Worker carrier runtime is not composed');
      return selected;
    },
  };
}
