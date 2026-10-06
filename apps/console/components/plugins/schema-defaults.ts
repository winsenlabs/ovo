import type { PluginOption } from './types';

/**
 * The binding a new form starts from: each visible top-level field's schema `default`, so a picked
 * provider opens on its recommended model and voice instead of an empty object. Advanced fields
 * stay unset and keep the plugin's own defaults.
 */
export function schemaDefaults(plugin: PluginOption): Record<string, unknown> {
  const schema = plugin.bindingSchema ?? plugin.configSchema;
  return Object.fromEntries(
    Object.entries(schema?.properties ?? {}).flatMap(([key, shape]) =>
      shape.default === undefined || plugin.ui?.fields?.[key]?.advanced
        ? []
        : [[key, structuredClone(shape.default)]],
    ),
  );
}
