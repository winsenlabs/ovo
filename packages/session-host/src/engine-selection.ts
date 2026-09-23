import { Cap, type Release } from '@winsendotai/ovo-contracts';
import {
  PluginPinError,
  PluginRegistry,
  type InstalledSessionExtensions,
  type PluginDefinition,
} from '@winsendotai/ovo-runtime';

export interface SelectedEngine {
  definition: PluginDefinition;
  rowConfig: Record<string, unknown>;
  exact: boolean;
}

/** V2 engines use same-major pins; legacy replacement engines retain exact release pins. */
export function selectEngine(
  release: Pick<Release, 'config' | 'plugins' | 'selections'>,
  registry: PluginRegistry,
  installedExtensions: Pick<InstalledSessionExtensions, 'plugins'>,
  fallback: () => PluginDefinition,
): SelectedEngine {
  const selection = release.selections?.engine;
  if (selection) {
    const pinned = registry.resolvePin(selection.pluginId, selection.version);
    if (!pinned.definition.manifest.provides.some((key) => key.split('@')[0] === Cap.engine))
      throw new PluginPinError('plugin_unavailable', `${selection.pluginId} is not an engine`);
    return { definition: pinned.definition, rowConfig: selection.config, exact: pinned.exact };
  }

  const pins = new Map(release.plugins.map((row) => [row.id, row.version]));
  const providers = installedExtensions.plugins.filter(
    (plugin) => pins.has(plugin.manifest.id) && plugin.manifest.provides.includes(Cap.engine),
  );
  if (providers.length > 1)
    throw new Error(
      `multiple installed voice session engine providers: ${providers.map((p) => p.manifest.id).join(', ')}`,
    );
  const replacement = providers[0];
  if (replacement && pins.get(replacement.manifest.id) !== replacement.manifest.version)
    throw new Error(
      `installed voice session engine ${replacement.manifest.id}@${replacement.manifest.version} does not satisfy release pin ${pins.get(replacement.manifest.id)}`,
    );
  const fallbackDefinition = replacement ? undefined : fallback();
  for (const pin of release.plugins)
    if (pin.id !== fallbackDefinition?.manifest.id && !registry.get(pin.id, pin.version))
      throw new Error(`live release plugin is not installed: ${pin.id}@${pin.version}`);
  const definition = replacement ?? fallbackDefinition!;
  const inputEnabled = release.config.mode !== 'announcement';
  return {
    definition,
    exact: true,
    rowConfig: {
      language: release.config.language,
      inputEnabled,
      initialInput: release.config.script || !inputEnabled ? '' : undefined,
      initialVariables: {},
    },
  };
}
