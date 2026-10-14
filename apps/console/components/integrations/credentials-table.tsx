import type { CredentialMetadata, ProviderBinding, SessionIdentity } from '../../lib/api';
import type { PluginOption } from '../plugins/types';
import { DataTableV2, type ColumnV2 } from './settings-table';
import { StatusBadgeV2 } from '../ui/status-badge';
import { RelativeTime } from '../ui/display';
import { EmptyStateV2 } from '../ui/feedback-v2';
import { expiryTone, usedByCount } from './credential-helpers';
import { environmentColumn } from './table-columns';

/** Vendor display name sourced from the installed plugin manifest, never a hardcoded map
 * (brief §2 provider-names gate — `plugin.ui.vendor`, falling back to the raw provider id only
 * when no installed plugin advertises it). */
function vendorLabel(provider: string, plugins: readonly PluginOption[]): string {
  return plugins.find((plugin) => plugin.provider === provider)?.ui?.vendor ?? provider;
}

function ExpiryCell({ expiresAt }: { expiresAt?: string }) {
  if (!expiresAt) return <span className="ds-unknown">No expiry</span>;
  const tone = expiryTone(expiresAt);
  if (!tone) return <RelativeTime value={expiresAt} />;
  return (
    <span className={`ds-badge tone-${tone} size-sm`}>
      <span className="ds-badge-dot" aria-hidden="true" />
      <RelativeTime value={expiresAt} />
    </span>
  );
}

export function CredentialsTable({
  credentials,
  bindings,
  plugins,
  role,
  busy,
  loading,
  onRotate,
  onRetire,
  onAdd,
}: {
  credentials: CredentialMetadata[];
  bindings: ProviderBinding[];
  plugins: PluginOption[];
  role: SessionIdentity['role'];
  busy?: string;
  loading: boolean;
  onRotate: (credential: CredentialMetadata) => void;
  onRetire: (credential: CredentialMetadata) => Promise<void>;
  onAdd: () => void;
}) {
  const columns: ColumnV2<CredentialMetadata>[] = [
    {
      id: 'label',
      header: 'Credential',
      sortValue: (row) => row.label,
      cell: (row) => (
        <>
          <strong>{row.label}</strong>
          <br />
          <small className="muted">
            {vendorLabel(row.provider, plugins)} · {row.type}
          </small>
        </>
      ),
    },
    environmentColumn<CredentialMetadata>(),
    {
      id: 'fingerprint',
      header: 'Fingerprint',
      priority: 'low',
      cell: (row) => <span className="mono">{row.fingerprint ?? 'Unavailable'}</span>,
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (row) => row.status ?? '',
      cell: (row) => <StatusBadgeV2 value={row.status} />,
    },
    {
      id: 'rotated',
      header: 'Rotated',
      priority: 'low',
      sortValue: (row) => row.rotatedAt ?? row.createdAt ?? '',
      cell: (row) =>
        row.rotatedAt ? (
          <RelativeTime value={row.rotatedAt} />
        ) : (
          <>
            <span className="muted">Never rotated</span>
            {row.createdAt && (
              <>
                {' · created '}
                <RelativeTime value={row.createdAt} />
              </>
            )}
          </>
        ),
    },
    {
      id: 'expiry',
      header: 'Expiry',
      cell: (row) => <ExpiryCell expiresAt={row.expiresAt} />,
    },
    {
      id: 'usedBy',
      header: 'Used by',
      align: 'end',
      priority: 'low',
      sortValue: (row) => usedByCount(row.id, bindings),
      cell: (row) => {
        const count = usedByCount(row.id, bindings);
        return count > 0 ? (
          `${count} binding${count === 1 ? '' : 's'}`
        ) : (
          <span className="muted">None</span>
        );
      },
    },
    {
      id: 'actions',
      header: 'Actions',
      align: 'end',
      cell: (row) => (
        <div className="button-row">
          <button
            type="button"
            className="button small"
            disabled={role !== 'admin' || Boolean(busy)}
            onClick={() => onRotate(row)}
          >
            Rotate
          </button>
          <button
            type="button"
            className="button small danger"
            disabled={role !== 'admin' || Boolean(busy)}
            onClick={() => void onRetire(row)}
          >
            Retire
          </button>
        </div>
      ),
    },
  ];
  return (
    <DataTableV2
      label="Credentials"
      rows={credentials}
      columns={columns}
      rowKey={(row) => row.id}
      loading={loading}
      empty={
        <EmptyStateV2
          title="No credentials yet"
          action={
            role === 'admin' ? (
              <button type="button" className="button primary" onClick={onAdd}>
                Add credential
              </button>
            ) : undefined
          }
        >
          Add a write-only credential before creating a provider binding.
        </EmptyStateV2>
      }
    />
  );
}
