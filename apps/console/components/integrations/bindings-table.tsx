import type { CredentialMetadata, ProviderBinding, SessionIdentity } from '../../lib/api';
import type { PluginOption } from '../plugins/types';
import { DataTableV2, type ColumnV2 } from './settings-table';
import { EmptyStateV2 } from '../ui/feedback-v2';
import { StatusBadgeV2 } from '../ui/status-badge';
import { JsonViewer } from '../ui/code-block';
import { VoicePreviewButton } from './voice-preview-button';
import { environmentColumn } from './table-columns';

function credentialLabel(credentialId: string, credentials: readonly CredentialMetadata[]): string {
  return credentials.find((credential) => credential.id === credentialId)?.label ?? credentialId;
}

function pluginLabel(binding: ProviderBinding, plugins: readonly PluginOption[]): string {
  return plugins.find((plugin) => plugin.id === binding.pluginId)?.ui?.label ?? binding.provider;
}

function ConfigSummary({ config }: { config?: Record<string, unknown> }) {
  const entries = Object.entries(config ?? {});
  if (!entries.length) return <span className="ds-unknown">No configuration</span>;
  return (
    <div className="stack" style={{ gap: 4 }}>
      <span className="ds-choice-chips">
        {entries.slice(0, 3).map(([key, value]) => (
          <span key={key} className="ds-chip">
            {key}: {String(value)}
          </span>
        ))}
        {entries.length > 3 && <span className="muted">+{entries.length - 3}</span>}
      </span>
      <JsonViewer value={config} label="Show full configuration" filename="binding-config.json" />
    </div>
  );
}

export function BindingsTable({
  bindings,
  credentials = [],
  plugins = [],
  role,
  busy,
  loading = false,
  onEdit,
  onRemove,
}: {
  bindings: ProviderBinding[];
  credentials?: CredentialMetadata[];
  plugins?: PluginOption[];
  role: SessionIdentity['role'];
  busy: boolean;
  loading?: boolean;
  onEdit: (binding: ProviderBinding) => void;
  onRemove: (binding: ProviderBinding) => Promise<void>;
}) {
  const columns: ColumnV2<ProviderBinding>[] = [
    {
      id: 'label',
      header: 'Binding',
      sortValue: (row) => row.label,
      cell: (row) => (
        <>
          <strong>{row.label}</strong>
          <br />
          <small className="mono muted">{row.id}</small>
        </>
      ),
    },
    {
      id: 'plugin',
      header: 'Plugin',
      priority: 'normal',
      cell: (row) => (
        <>
          {pluginLabel(row, plugins)}
          {row.kind && <StatusBadgeV2 value={row.kind} tone="neutral" size="sm" />}
        </>
      ),
    },
    environmentColumn<ProviderBinding>(),
    {
      id: 'credential',
      header: 'Credential',
      cell: (row) => credentialLabel(row.credentialId, credentials),
    },
    {
      id: 'config',
      header: 'Configuration',
      priority: 'low',
      cell: (row) => <ConfigSummary config={row.config} />,
    },
    {
      id: 'actions',
      header: 'Actions',
      align: 'end',
      cell: (row) => (
        <div className="button-row">
          <button
            className="button small"
            type="button"
            disabled={role !== 'admin' || busy}
            onClick={() => onEdit(row)}
          >
            Edit
          </button>
          <button
            className="button small danger"
            type="button"
            disabled={role !== 'admin' || busy}
            onClick={() => void onRemove(row)}
          >
            Delete
          </button>
          {row.kind === 'tts' && (
            <VoicePreviewButton bindingId={row.id} disabled={role !== 'admin'} />
          )}
        </div>
      ),
    },
  ];
  return (
    <DataTableV2
      label="Provider bindings"
      rows={bindings}
      columns={columns}
      rowKey={(row) => row.id}
      loading={loading}
      empty={
        <EmptyStateV2 title="No provider bindings">
          Add one below before assigning provider roles to an agent.
        </EmptyStateV2>
      }
    />
  );
}
