import { Cap, type OperationStore, type SecretResolver } from '@winsendotai/ovo-contracts';
import { definePlugin, type PluginDefinition } from '@winsendotai/ovo-runtime';

export const createSessionServicesPlugin = (
  operations: OperationStore,
  secrets: SecretResolver,
  observability: unknown,
) =>
  definePlugin(
    {
      id: '@winsendotai/ovo-api-session-services',
      version: '0.1.0',
      contractVersion: 1,
      scope: 'session',
      provides: [Cap.operationStore, Cap.secrets, Cap.observability],
      requires: [],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: [],
    },
    (ctx) => {
      ctx.provide(Cap.operationStore, operations);
      ctx.provide(Cap.secrets, secrets);
      ctx.provide(Cap.observability, observability);
    },
  );

export function mergeCatalog(...catalogs: (readonly PluginDefinition[])[]) {
  const merged = new Map<string, PluginDefinition>();
  for (const catalog of catalogs) {
    for (const definition of catalog) {
      const old = merged.get(definition.manifest.id);
      if (old && old.manifest.version !== definition.manifest.version)
        throw new Error(`Conflicting approved versions for ${definition.manifest.id}`);
      merged.set(definition.manifest.id, definition);
    }
  }
  return [...merged.values()];
}
