import type { SessionIdentity } from '../../lib/api';
import type { SuppressionRecord } from '../../lib/operator-api';
import type { ColumnV2 } from '../ui/data-table-v2';
import { StatusBadgeV2 } from '../ui/status-badge';
import { IdChip } from '../ui/section-card';
import { formatDateTime, formatPhoneNumber } from '../../lib/format';

/** A do-not-call entry: who listed it, its scope, and how long an opt-out stays locked. */
export type DoNotCallEntry = SuppressionRecord & {
  source?: keyof typeof SOURCE_LABEL;
  callId?: string;
  scope?: 'all' | 'promotional' | 'purpose';
  purpose?: string;
  lockUntil?: string;
};
export const SOURCE_LABEL = {
  manual: 'Operator',
  import: 'Bulk import',
  opt_out: 'Caller opted out',
  ncpr: 'DND register',
  dlt_revocation: 'DLT revocation',
  complaint: 'Complaint',
  wrong_number: 'Wrong number',
  regulator: 'Regulator',
};

/** Whether an entry is still inside its 90-day opt-out lock (TCCCPR R13). */
export function lockedUntil(row: Pick<DoNotCallEntry, 'lockUntil'>, now = Date.now()) {
  return row.lockUntil && Date.parse(row.lockUntil) > now ? new Date(row.lockUntil) : undefined;
}

/** The do-not-call table's columns. Split out of `SuppressionsView` purely to keep that module
 * under the size gate. */
export function suppressionColumns({
  role,
  busy,
  now,
  onRemove,
}: {
  role: SessionIdentity['role'];
  busy: boolean;
  now: number;
  onRemove: (row: DoNotCallEntry) => void;
}): ColumnV2<DoNotCallEntry>[] {
  return [
    {
      id: 'phoneNumber',
      header: 'Number',
      cell: (row) => <span className="mono">{formatPhoneNumber(row.phoneNumber)}</span>,
      sortValue: (row) => row.phoneNumber,
    },
    { id: 'reason', header: 'Reason', cell: (row) => row.reason },
    {
      id: 'source',
      header: 'Source',
      cell: (row) => (
        <>
          <StatusBadgeV2
            tone="neutral"
            label={row.source ? SOURCE_LABEL[row.source] : SOURCE_LABEL.manual}
          />
          {row.scope && row.scope !== 'all' && (
            <>
              <br />
              <small className="muted">
                {row.scope === 'promotional' ? 'Promotional calls' : row.purpose}
              </small>
            </>
          )}
        </>
      ),
    },
    {
      id: 'origin',
      header: 'Origin call',
      cell: (row) =>
        row.callId ? (
          <IdChip id={row.callId} short={row.callId} href={`/calls/${row.callId}`} />
        ) : (
          <span className="ds-unknown">None</span>
        ),
    },
    {
      id: 'lock',
      header: 'Lock',
      cell: (row) => {
        const locked = lockedUntil(row, now);
        if (!locked) return <span className="ds-unknown">None</span>;
        const daysLeft = Math.ceil((locked.getTime() - now) / 86_400_000);
        return <StatusBadgeV2 tone="warn" label={`Locked · ${daysLeft}d left`} />;
      },
    },
    {
      id: 'createdAt',
      header: 'Added',
      cell: (row) => formatDateTime(row.createdAt),
      sortValue: (row) => row.createdAt,
    },
    {
      id: 'actions',
      header: 'Actions',
      align: 'end',
      cell: (row) => (
        <button
          className="button small danger"
          type="button"
          disabled={role !== 'admin' || busy || Boolean(lockedUntil(row, now))}
          title={lockedUntil(row, now) ? 'Locked by the caller’s own opt-out' : undefined}
          onClick={() => onRemove(row)}
        >
          Remove
        </button>
      ),
    },
  ];
}
