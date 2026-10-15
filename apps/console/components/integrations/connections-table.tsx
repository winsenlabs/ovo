import type { CredentialMetadata, McpConnection, SessionIdentity } from '../../lib/api';
import { DataTableV2, type ColumnV2 } from '../ui/data-table-v2';
import { EmptyStateV2 } from '../ui/feedback-v2';
import { StatusBadgeV2 } from '../ui/status-badge';
import { RelativeTime } from '../ui/display';
import { endpointHost } from './mcp-helpers';
import { credentialLabel } from './credential-helpers';

export function ConnectionsTable({
  connections,
  credentials = [],
  loading,
  busyId,
  role,
  onTest,
  onDiscover,
  onEdit,
  onRemove,
  onAdd,
}: {
  connections: McpConnection[];
  credentials?: CredentialMetadata[];
  loading: boolean;
  busyId?: string;
  role: SessionIdentity['role'];
  onTest: (connection: McpConnection) => void;
  onDiscover: (connection: McpConnection) => void;
  onEdit: (connection: McpConnection) => void;
  onRemove: (connection: McpConnection) => void;
  onAdd: () => void;
}) {
  const columns: ColumnV2<McpConnection>[] = [
    {
      id: 'label',
      header: 'Connection',
      sortValue: (row) => row.label,
      cell: (row) => <strong>{row.label}</strong>,
    },
    {
      id: 'endpoint',
      header: 'Endpoint',
      priority: 'normal',
      cell: (row) => (
        <span className="mono" title={row.endpoint}>
          {endpointHost(row.endpoint)}
        </span>
      ),
    },
    {
      id: 'auth',
      header: 'Auth',
      priority: 'low',
      cell: (row) =>
        row.auth === 'bearer'
          ? `Bearer · ${credentialLabel(row.credentialId, credentials)}`
          : 'None',
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (row) => row.status ?? '',
      cell: (row) => <StatusBadgeV2 value={row.status} />,
    },
    {
      id: 'tested',
      header: 'Last tested',
      sortValue: (row) => row.lastTestedAt ?? '',
      cell: (row) => <RelativeTime value={row.lastTestedAt} />,
    },
    {
      id: 'actions',
      header: 'Actions',
      align: 'end',
      cell: (row) => {
        const busy = busyId === row.id;
        const disabled = role === 'viewer' || busy;
        return (
          <div className="button-row">
            <button
              className="button small"
              type="button"
              disabled={disabled}
              onClick={() => onTest(row)}
            >
              Test
            </button>
            <button
              className="button small"
              type="button"
              disabled={disabled}
              onClick={() => onDiscover(row)}
            >
              Discover
            </button>
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
              onClick={() => onRemove(row)}
            >
              Delete
            </button>
          </div>
        );
      },
    },
  ];
  return (
    <DataTableV2
      label="MCP connections"
      rows={connections}
      columns={columns}
      rowKey={(row) => row.id}
      loading={loading}
      empty={
        <EmptyStateV2
          title="No MCP connections yet"
          action={
            role !== 'viewer' ? (
              <button type="button" className="button primary" onClick={onAdd}>
                Add MCP connection
              </button>
            ) : undefined
          }
        >
          Connect a remote MCP server before agents can discover and use its tools.
        </EmptyStateV2>
      }
    />
  );
}
