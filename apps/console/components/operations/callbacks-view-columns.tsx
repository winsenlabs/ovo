import type { ColumnV2 } from '../ui/data-table-v2';
import { StatusBadgeV2 } from '../ui/status-badge';
import { IdChip } from '../ui/section-card';
import { dueBucket } from '../../lib/derive/operations';
import { formatPhoneNumber } from '../../lib/format';
import type { CallbackRecord } from './callbacks-view';

/** The due time in the agent's own timezone, which is the caller's. */
export function due(record: CallbackRecord): string {
  try {
    return new Intl.DateTimeFormat('en-IN', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: record.timezone,
    }).format(new Date(record.dueAt));
  } catch {
    // swallow-ok: an unknown timezone shows the instant as it is stored.
    return record.dueAt;
  }
}

export const sourceLabel = (record: CallbackRecord): string =>
  record.source === 'llm' ? 'LLM' : `Flow · ${record.node ?? 'node'}`;

/** The callbacks table's column set, built fresh per render so each action closes over the
 * current `busy`/`now` without the view needing to pass them through a generic cell callback. */
export function callbackColumns({
  admin,
  busy,
  now,
  act,
}: {
  admin: boolean;
  busy: string | undefined;
  now: () => Date;
  act: (record: CallbackRecord, action: 'dial' | 'complete' | 'cancel') => void;
}): ColumnV2<CallbackRecord>[] {
  return [
    {
      id: 'due',
      header: 'Due',
      cell: (record) => (
        <>
          {due(record)}
          {dueBucket(record.dueAt, record.status, now()) === 'overdue' && (
            <>
              {' '}
              <StatusBadgeV2 tone="warn" label="Overdue" />
            </>
          )}
        </>
      ),
      sortValue: (record) => record.dueAt,
    },
    {
      id: 'phone',
      header: 'Number',
      cell: (record) => <span className="mono">{formatPhoneNumber(record.phone)}</span>,
    },
    {
      id: 'origin',
      header: 'Promised by',
      cell: (record) => (
        <>
          {sourceLabel(record)}
          <br />
          <IdChip id={record.callId} short={record.callId} href={`/calls/${record.callId}`} />
        </>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      cell: (record) => (
        <>
          <StatusBadgeV2 value={record.status} />
          {record.dialedCallId && (
            <>
              <br />
              <IdChip
                id={record.dialedCallId}
                short={record.dialedCallId}
                href={`/calls/${record.dialedCallId}`}
              />
            </>
          )}
        </>
      ),
    },
    {
      id: 'actions',
      header: 'Actions',
      align: 'end',
      cell: (record) => (
        <div className="button-row">
          {(record.status === 'pending' || record.status === 'dialing') && (
            <button
              className="button small primary"
              type="button"
              disabled={!admin || busy !== undefined || !record.phone}
              onClick={() => act(record, 'dial')}
            >
              {busy === record.id ? 'Dialling…' : 'Call back now'}
            </button>
          )}
          {record.status !== 'completed' && record.status !== 'cancelled' && (
            <button
              className="button small"
              type="button"
              disabled={!admin || busy !== undefined}
              onClick={() => act(record, 'complete')}
            >
              Mark done
            </button>
          )}
          {(record.status === 'pending' || record.status === 'dialing') && (
            <button
              className="button small danger"
              type="button"
              disabled={!admin || busy !== undefined}
              onClick={() => act(record, 'cancel')}
            >
              Cancel
            </button>
          )}
        </div>
      ),
    },
  ];
}
