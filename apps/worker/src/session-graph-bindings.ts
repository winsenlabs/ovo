import { deriveLegacySelections, type ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import type { SelectedEngine } from '@winsendotai/ovo-session-host';
import type { PluginRegistry } from '@winsendotai/ovo-runtime';

/**
 * Stamps each provider row with the immutable binding identity it was selected under, as well as
 * the copied config, so legacy bridges and credential lookups see exactly the published binding.
 */
export function stampBindingIdentity(
  rows: { id: string; config?: Record<string, unknown> }[],
  release: Pick<ReleaseRecord, 'workspaceId' | 'selections' | 'providerBindings'>,
): void {
  // Legacy bridges need the immutable binding identity as well as the copied config.
  for (const selection of Object.values(release.selections ?? {})) {
    if (!selection?.binding) continue;
    const row = rows.find((item) => item.id === selection.pluginId);
    if (row)
      row.config = {
        ...row.config,
        workspaceId: release.workspaceId,
        bindingId: selection.bindingId,
        updatedAt: selection.binding.updatedAt,
      };
  }
  for (const binding of Object.values(release.providerBindings)) {
    const row = rows.find(
      (item) =>
        item.config?.credentialRef &&
        (item.config.credentialRef as { credentialId?: string }).credentialId ===
          binding.credentialId,
    );
    if (row)
      row.config = {
        ...row.config,
        workspaceId: release.workspaceId,
        bindingId: binding.id,
        updatedAt: binding.updatedAt,
      };
  }
}

/** Merges `patch` into a v2 engine row's session input; a v1 engine row has none and is left. */
export function patchEngineSession(
  rows: { id: string; config?: Record<string, unknown> }[],
  engine: { manifest: { id: string } },
  patch: Record<string, unknown>,
): void {
  const row = rows.find((item) => item.id === engine.manifest.id);
  const session = row?.config?.session;
  if (row && typeof session === 'object' && session !== null)
    row.config = { ...row.config, session: { ...session, ...patch } };
}

/**
 * A release without an engine selection, run by a v1 engine, gets the selections its legacy
 * config implies, pinned to the installed versions, with the selected engine's row.
 */
export function withDerivedSelections(
  release: ReleaseRecord,
  registry: PluginRegistry,
  defaults: { engine?: string; turnDetector?: string },
  selected: SelectedEngine,
): ReleaseRecord {
  if (release.selections?.engine || selected.definition.manifest.contractVersion !== 1)
    return release;
  const derived = deriveLegacySelections(release, registry, {
    engine: defaults.engine,
    turnDetector: defaults.turnDetector,
  });
  return {
    ...release,
    selections: {
      ...Object.fromEntries(
        Object.entries(derived).map(([slot, choice]) => [
          slot,
          { ...choice, version: registry.get(choice.pluginId)!.manifest.version },
        ]),
      ),
      engine: {
        pluginId: selected.definition.manifest.id,
        version: selected.definition.manifest.version,
        config: selected.rowConfig,
      },
    },
  };
}
