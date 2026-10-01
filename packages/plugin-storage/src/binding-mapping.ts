import type { ProviderBinding } from './models.ts';

/** Map the common binding columns while each database decodes its own JSON and timestamps. */
export function mapProviderBinding(
  row: Record<string, unknown>,
  configColumn: 'config' | 'config_json',
  config: (value: unknown) => Record<string, unknown>,
  timestamp: (value: unknown) => string,
): ProviderBinding {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    label: String(row.label),
    provider: String(row.provider),
    kind: row.kind === null ? null : String(row.kind),
    pluginId: row.plugin_id === null ? null : String(row.plugin_id),
    environment: String(row.environment),
    credentialId: String(row.credential_id),
    config: config(row[configColumn]),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}
