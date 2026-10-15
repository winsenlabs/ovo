import type { CredentialMetadata, ProviderBinding, SessionIdentity } from '../../lib/api';
import type { PluginOption } from '../plugins/types';
import { DataTableV2, type ColumnV2 } from '../ui/data-table-v2';
import { StatusBadgeV2 } from '../ui/status-badge';
import { RelativeTime } from '../ui/display';
import { EmptyStateV2 } from '../ui/feedback-v2';
import { expiryTone, humaniseCredentialType, usedByCount, vendorLabel } from './credential-helpers';
import { environmentColumn } from './table-columns';

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
            {vendorLabel(row.provider, plugins)} · {humaniseCredentialType(row.type)}
          </small>
          {row.permittedAgentIds && row.permittedAgentIds.length > 0 && (
            <>
              <br />
              <small className="muted">
                {row.permittedAgentIds.length} permitted agent
                {row.permittedAgentIds.length === 1 ? '' : 's'}
              </small>
            </>
          )}
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
      cell: (row) => {
        const retired = row.status === 'retired';
        return (
          <div className="button-row">
            <button
              type="button"
              className="button small"
              disabled={role !== 'admin' || Boolean(busy) || retired}
              title={retired ? 'Retired credentials cannot be rotated.' : undefined}
              onClick={() => onRotate(row)}
            >
              Rotate
            </button>
            <button
              type="button"
              className="button small danger"
              disabled={role !== 'admin' || Boolean(busy) || retired}
              title={retired ? 'Already retired.' : undefined}
              onClick={() => void onRetire(row)}
            >
              Retire
            </button>
          </div>
        );
      },
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
