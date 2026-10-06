import { manifestKeys, PluginRegistry, type PluginDefinition } from '@winsendotai/ovo-runtime';

/**
 * The installed plugin a binding names, checked against its provider and binding schema. A binding
 * without a plugin id takes the provider's only plugin; with several, it stays unpinned.
 */
export function selectedBindingPlugin(
  body: { provider: string; pluginId?: string | null; config: Record<string, unknown> },
  catalog: readonly PluginDefinition[],
) {
  const registry = new PluginRegistry(catalog);
  const matches = registry.list().filter((definition) => {
    const manifest = manifestKeys(definition.manifest).manifest;
    return manifest.kind !== 'infra' && manifest.provider === body.provider;
  });
  const ids = [...new Set(matches.map((definition) => definition.manifest.id))];
  const pluginId = body.pluginId ?? (ids.length === 1 ? ids[0] : null);
  if (pluginId) {
    const definition = registry.get(pluginId);
    if (!definition || manifestKeys(definition.manifest).manifest.provider !== body.provider)
      throw Object.assign(
        new Error(`Plugin ${pluginId} does not match provider ${body.provider}`),
        { statusCode: 400, code: 'binding_plugin_mismatch' },
      );
    const validation = registry.validateBinding(pluginId, body.config);
    if (!validation.ok)
      throw Object.assign(new Error(`Invalid binding for ${pluginId}: ${validation.errors}`), {
        statusCode: 400,
        code: 'binding_schema_invalid',
      });
    return { pluginId, kind: manifestKeys(definition.manifest).manifest.kind };
  }
  return { pluginId: null, kind: null };
}
