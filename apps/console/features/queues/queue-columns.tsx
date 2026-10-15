import type { ColumnV2 } from '../../components/ui/data-table-v2';
import { StatusBadgeV2 } from '../../components/ui/status-badge';
import { Duration } from '../../components/ui/display';
import { hoursSummary, kindLabel } from '../../lib/derive/queues';
import type { HumanQueueStatus } from '../../lib/types/desk';
import type { QueueRecord } from '../../lib/types/queues';

export interface QueueRowActions {
  status: HumanQueueStatus | undefined;
  canEdit: boolean;
  canTest: boolean;
  onEdit: (record: QueueRecord) => void;
  onTest: (record: QueueRecord) => void;
  onDelete: (record: QueueRecord) => void;
}

/** Whether the queue can take callers on this installation, and the honest reason if not. */
export function queueHealth(record: QueueRecord, status: HumanQueueStatus | undefined) {
  if (!status) return { value: 'unknown' as const, label: 'Unknown' };
  if (record.definition.kind === 'external')
    return status.webhookEnabled
      ? { value: 'enabled' as const, label: 'Ready' }
      : { value: 'disabled' as const, label: 'Webhook off' };
  if (!status.managedAvailable) return { value: 'degraded' as const, label: 'Room not available' };
  return status.room.reachable === false
    ? { value: 'degraded' as const, label: 'Room unreachable' }
    : { value: 'enabled' as const, label: 'Ready' };
}

export function queueColumns(actions: QueueRowActions): ColumnV2<QueueRecord>[] {
  return [
    {
      id: 'name',
      header: 'Name',
      sortValue: (row) => row.definition.name.toLowerCase(),
      cell: (row) => <strong>{row.definition.name}</strong>,
    },
    {
      id: 'kind',
      header: 'Type',
      cell: (row) => <span className="ds-chip">{kindLabel(row.definition.kind)}</span>,
    },
    {
      id: 'assignment',
      header: 'Assignment',
      priority: 'low',
      cell: (row) =>
        row.definition.kind === 'managed'
          ? row.definition.assignment === 'AUTO_ASSIGN'
            ? 'Auto-assign'
            : 'Open pick-up'
          : '—',
    },
    { id: 'hours', header: 'Hours', priority: 'low', cell: (row) => hoursSummary(row.definition.hours) },
    {
      id: 'used',
      header: 'Used by',
      align: 'end',
      priority: 'low',
      cell: (row) => <span title={row.usedBy.join(', ')}>{row.usedBy.length}</span>,
    },
    {
      id: 'waiting',
      header: 'Waiting',
      align: 'end',
      sortValue: (row) => row.stats.waiting + row.stats.offered,
      cell: (row) => (
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
          {row.stats.waiting + row.stats.offered}
          {row.stats.oldestWaitMs > 0 && (
            <>
              {' '}
              (<Duration ms={row.stats.oldestWaitMs} />)
            </>
          )}
        </span>
      ),
    },
    {
      id: 'online',
      header: 'Online',
      align: 'end',
      priority: 'low',
      cell: (row) => (row.definition.kind === 'managed' ? row.stats.online : '—'),
    },
    {
      id: 'status',
      header: 'Status',
      cell: (row) => {
        const health = queueHealth(row, actions.status);
        return <StatusBadgeV2 value={health.value} label={health.label} />;
      },
    },
    {
      id: 'actions',
      header: 'Actions',
      align: 'end',
      cell: (row) => (
        <span className="button-row">
          <button type="button" className="button" onClick={() => actions.onEdit(row)} aria-label={`${actions.canEdit ? 'Edit' : 'View'} ${row.definition.name}`}>
            {actions.canEdit ? 'Edit' : 'View'}
          </button>
          {row.definition.kind === 'external' && actions.canTest && (
            <button type="button" className="button" onClick={() => actions.onTest(row)} aria-label={`Send test webhook for ${row.definition.name}`}>
              Send test
            </button>
          )}
          {actions.canEdit && (
            <button type="button" className="button danger" onClick={() => actions.onDelete(row)} aria-label={`Delete ${row.definition.name}`}>
              Delete
            </button>
          )}
        </span>
      ),
    },
  ];
}
