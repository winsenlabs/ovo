import { Cap, type AgentConfig, type TextFilter } from '@winsendotai/ovo-contracts';
import {
  compose,
  PluginRegistry,
  type PluginDefinition,
  type PluginRow,
} from '@winsendotai/ovo-runtime';

export interface ReleaseTextFilters {
  filters: TextFilter[];
  /** Selected filter plugins that are not installed here: the chain is then not the speaker's. */
  unresolved: string[];
  close(): Promise<void>;
}

/**
 * Composes exactly the text-filter plugins a release's speaker composes, outside any call, so a
 * pre-render or an inventory count normalizes text the way the live session will (TTS-6).
 */
export async function composeReleaseTextFilters(
  release: {
    workspaceId: string;
    config: AgentConfig;
    selections?: Readonly<Record<string, { pluginId: string; version: string; config: object }>>;
  },
  catalog: readonly PluginDefinition[],
  defaults: { textFilters?: readonly string[] } = {},
): Promise<ReleaseTextFilters> {
  const registry = new PluginRegistry(catalog);
  const selected: { definition: PluginDefinition; config: Record<string, unknown> }[] = [];
  const unresolved: string[] = [];
  const pinned = Object.entries(release.selections ?? {}).filter(([slot]) =>
    slot.startsWith('textFilter:'),
  );
  if (Object.keys(release.selections ?? {}).length) {
    for (const [, selection] of pinned) {
      try {
        const { definition } = registry.resolvePin(selection.pluginId, selection.version);
        selected.push({ definition, config: { ...selection.config } });
      } catch {
        unresolved.push(selection.pluginId);
      }
    }
  } else {
    const legacy = release.config.voice?.textFilters.length
      ? release.config.voice.textFilters.map((item) => ({ id: item.plugin, config: item.config }))
      : (defaults.textFilters ?? []).map((id) => ({ id, config: {} }));
    for (const item of legacy) {
      const definition = registry.get(item.id);
      if (definition) selected.push({ definition, config: { ...(item.config ?? {}) } });
      else unresolved.push(item.id);
    }
  }
  if (!selected.length) return { filters: [], unresolved, close: async () => undefined };
  const rows: PluginRow[] = selected.map(({ definition, config }) => ({
    id: definition.manifest.id,
    config,
  }));
  const composition = await compose(
    rows,
    selected.map((item) => item.definition),
    { scope: 'session', workspaceId: release.workspaceId },
  );
  return {
    filters: [...composition.all(Cap.textFilters).values()] as TextFilter[],
    unresolved,
    close: () => composition.dispose(),
  };
}
