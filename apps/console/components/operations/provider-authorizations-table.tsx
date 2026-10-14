'use client';
import type { ProviderEvaluationAuthorization } from '../../lib/operator-api';
import { formatDateTime, formatMoney } from '../../lib/format';
import { DataTableV2, type ColumnV2 } from '../ui/data-table-v2';
import { StatusBadgeV2 } from '../ui/status-badge';
import { IdChip } from '../ui/section-card';
import { Button } from '../ui/button';

export function ProviderAuthorizationsTable({
  authorizations,
  busy,
  revoke,
}: {
  authorizations: readonly ProviderEvaluationAuthorization[];
  busy: boolean;
  revoke: (authorization: ProviderEvaluationAuthorization) => Promise<void>;
}) {
  const columns: ColumnV2<ProviderEvaluationAuthorization>[] = [
    {
      id: 'release',
      header: 'Immutable release',
      cell: (authorization) => (
        <IdChip id={authorization.releaseId} short={authorization.releaseId.slice(0, 10)} />
      ),
    },
    {
      id: 'binding',
      header: 'Provider binding',
      cell: (authorization) => (
        <>
          {authorization.provider} · {authorization.modelId}
          <br />
          <small className="mono muted">{authorization.bindingVersion}</small>
        </>
      ),
    },
    {
      id: 'budget',
      header: 'Budget authorization',
      cell: (authorization) => (
        <>
          <span className="mono">{authorization.budgetId}</span>
          <br />
          <small className="muted">Max {formatMoney(authorization.maximumReservationPaise)}</small>
        </>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      cell: (authorization) => (
        <>
          <StatusBadgeV2
            tone={authorization.revokedAt ? 'neutral' : 'ok'}
            label={authorization.revokedAt ? 'Revoked' : 'Active'}
          />
          <br />
          <small className="muted">{formatDateTime(authorization.createdAt)}</small>
        </>
      ),
    },
    {
      id: 'action',
      header: 'Action',
      cell: (authorization) => (
        <Button
          variant="danger"
          type="button"
          disabled={busy || Boolean(authorization.revokedAt)}
          onClick={() => void revoke(authorization)}
        >
          Revoke
        </Button>
      ),
      align: 'end',
    },
  ];
  return (
    <DataTableV2
      label="Provider evaluation authorizations"
      rows={authorizations}
      columns={columns}
      rowKey={(authorization) => authorization.id}
      empty="No provider authorizations."
    />
  );
}
