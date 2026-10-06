import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';

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
