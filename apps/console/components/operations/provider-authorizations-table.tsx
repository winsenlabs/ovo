'use client';
import type { ProviderEvaluationAuthorization } from '../../lib/operator-api';
import { formatDateTime, formatMoney } from '../../lib/format';
import { DataTableV2, type ColumnV2 } from '../ui/data-table-v2';
import { StatusBadgeV2 } from '../ui/status-badge';
import { IdChip } from '../ui/section-card';
import { Button } from '../ui/button';
import type { ReleaseOption } from './agent-release-options';

export function ProviderAuthorizationsTable({
  authorizations,
  releases,
  busy,
  revoke,
}: {
  authorizations: readonly ProviderEvaluationAuthorization[];
  releases: readonly ReleaseOption[];
  busy: boolean;
  revoke: (authorization: ProviderEvaluationAuthorization) => Promise<void>;
}) {
  const columns: ColumnV2<ProviderEvaluationAuthorization>[] = [
    {
      id: 'release',
      header: 'Immutable release',
      // Releases load from the agent/release list already fetched for the create form; fall
      // back to the truncated-ID chip only for a release that list doesn't carry (verifier
      // minor #17 — "releases appear as truncated IDs, not names").
      cell: (authorization) => {
        const release = releases.find((item) => item.id === authorization.releaseId);
        return release ? (
          <>
            {release.agentName}
            <br />
            <small className="mono muted">{release.id.slice(0, 10)}</small>
          </>
        ) : (
          <IdChip id={authorization.releaseId} short={authorization.releaseId.slice(0, 10)} />
        );
      },
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
      // A revoked row showing a disabled "Revoke" button has nothing left for the operator to do
      // with it (verifier minor #17); the status column already says "Revoked".
      cell: (authorization) =>
        authorization.revokedAt ? null : (
          <Button
            variant="danger"
            type="button"
            disabled={busy}
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
