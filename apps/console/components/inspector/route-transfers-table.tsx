'use client';
import { DataTableV2, type ColumnV2 } from '../ui/data-table-v2';
import { EmptyStateV2 } from '../ui/feedback-v2';
import { StatusBadgeV2 } from '../ui/status-badge';
import { SectionCard } from '../ui/section-card';
import { Duration } from '../ui/display';
import { dataTableRenderKey } from '../../lib/data-table-remount-key';
import { humaniseEnum, type Tone } from '../../lib/status';
import type { TransferRow } from '../../lib/derive/call-route-summary';

const OUTCOME_TONE: Record<string, Tone> = {
  connected: 'ok',
  fallback: 'warn',
  returned: 'warn',
  callback: 'info',
  ended: 'neutral',
  caller_hangup: 'neutral',
  failed: 'danger',
};

const ms = (value: number | null) => (value == null ? null : <Duration ms={value} />);

const COLUMNS: ColumnV2<TransferRow>[] = [
  {
    id: 'transfer',
    header: 'Transfer',
    priority: 'high',
    sortValue: (row) => row.transfer,
    cell: (row) => `#${row.transfer}`,
  },
  {
    id: 'target',
    header: 'Target',
    priority: 'high',
    cell: (row) =>
      row.kind ? (
        <>
          {humaniseEnum(row.kind)}
          {row.key && <span className="mono"> {row.key}</span>}
        </>
      ) : (
        <span className="ds-unknown">Unknown</span>
      ),
  },
  {
    id: 'source',
    header: 'Asked by',
    priority: 'low',
    cell: (row) => (row.source ? humaniseEnum(row.source) : null),
  },
  {
    id: 'requested',
    header: 'Requested',
    priority: 'high',
    cell: (row) =>
      row.result === 'refused' ? (
        <>
          <StatusBadgeV2 tone="danger" size="sm" label="Refused" />
          {row.refusal && <span className="mono"> {row.refusal}</span>}
        </>
      ) : row.result === 'accepted' ? (
        <StatusBadgeV2 tone="ok" size="sm" label={row.queued ? 'Accepted, queued' : 'Accepted'} />
      ) : (
        <span className="ds-unknown">Not recorded</span>
      ),
  },
  {
    id: 'completed',
    header: 'Completed',
    priority: 'high',
    cell: (row) =>
      row.outcome ? (
        <StatusBadgeV2
          tone={OUTCOME_TONE[row.outcome] ?? 'neutral'}
          size="sm"
          label={humaniseEnum(row.outcome)}
        />
      ) : row.result === 'refused' ? (
        <span className="muted">Not attempted</span>
      ) : (
        <span className="ds-unknown">Not completed</span>
      ),
  },
  { id: 'prepare', header: 'Prepare', priority: 'low', align: 'end', cell: (r) => ms(r.prepareMs) },
  { id: 'queue', header: 'Queue', priority: 'low', align: 'end', cell: (r) => ms(r.queueMs) },
  { id: 'hold', header: 'Hold', priority: 'normal', align: 'end', cell: (r) => ms(r.holdMs) },
  { id: 'gap', header: 'Gap', priority: 'low', align: 'end', cell: (r) => ms(r.gapMs) },
  {
    id: 'steps',
    header: 'Timeout steps',
    priority: 'low',
    cell: (row) =>
      row.steps.length
        ? row.steps.map((step) => `${humaniseEnum(step.step)} ${step.result}`).join(', ')
        : row.reason
          ? humaniseEnum(row.reason)
          : null,
  },
];

/** Requested against completed, one row per transfer: who asked, why it was refused, how long it took. */
export function TransfersTable({ rows }: { rows: readonly TransferRow[] }) {
  return (
    <SectionCard
      title="Transfers"
      description="Each request against how it ended. Hold is how long the caller waited."
      padding="flush"
    >
      <DataTableV2
        key={dataTableRenderKey(false, undefined, rows.length)}
        label="Transfers"
        rows={rows}
        rowKey={(row) => String(row.transfer)}
        columns={COLUMNS}
        empty={
          <EmptyStateV2 variant="first-run" title="No transfers were requested on this call" />
        }
      />
    </SectionCard>
  );
}
