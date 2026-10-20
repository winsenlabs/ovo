'use client';
import { DataTableV2, type ColumnV2 } from '../ui/data-table-v2';
import { EmptyStateV2 } from '../ui/feedback-v2';
import { StatusBadgeV2 } from '../ui/status-badge';
import { IdChip, SectionCard } from '../ui/section-card';
import { Duration, Money } from '../ui/display';
import { dataTableRenderKey } from '../../lib/data-table-remount-key';
import { shortenId } from '../../lib/format';
import { humaniseEnum } from '../../lib/status';
import { REASON_LABELS, type TimelineSegment } from '../../lib/derive/call-route';

const ROLE_LABEL = { router: 'Router', agent: 'Agent', human: 'Person' } as const;

export function segmentColumns(
  onOpen: (index: number) => void,
  currency: string,
): ColumnV2<TimelineSegment>[] {
  return [
    {
      id: 'index',
      header: 'Segment',
      priority: 'high',
      sortValue: (segment) => segment.index,
      cell: (segment) => (
        <button
          type="button"
          className="text-button"
          aria-label={`Open segment ${segment.index}`}
          onClick={() => onOpen(segment.index)}
        >
          #{segment.index}
        </button>
      ),
    },
    {
      id: 'role',
      header: 'Role',
      priority: 'high',
      cell: (segment) => <span className="ds-chip">{ROLE_LABEL[segment.role]}</span>,
    },
    {
      id: 'agent',
      header: 'Agent',
      priority: 'high',
      cell: (segment) =>
        segment.role === 'human' ? (
          segment.label
        ) : (
          <span className="route-agent-cell">
            <a href={`/agents/${encodeURIComponent(segment.agentId)}/releases`}>{segment.label}</a>
            <IdChip id={segment.releaseId} short={shortenId(segment.releaseId)} />
          </span>
        ),
    },
    {
      id: 'pool',
      header: 'Pool / member',
      priority: 'low',
      cell: (segment) =>
        segment.poolId ? `${shortenId(segment.poolId)} / ${segment.memberId ?? 'unknown'}` : null,
    },
    {
      id: 'reason',
      header: 'Reason',
      priority: 'normal',
      cell: (segment) => REASON_LABELS[segment.reason] ?? humaniseEnum(segment.reason),
    },
    { id: 'language', header: 'Language', priority: 'low', cell: (segment) => segment.language },
    {
      id: 'start',
      header: 'Started',
      priority: 'normal',
      align: 'end',
      sortValue: (segment) => segment.startMs,
      cell: (segment) => (
        <>
          <span aria-hidden="true">+</span>
          <Duration ms={segment.startMs} />
        </>
      ),
    },
    {
      id: 'duration',
      header: 'Duration',
      priority: 'normal',
      align: 'end',
      sortValue: (segment) => segment.durationMs ?? -1,
      cell: (segment) =>
        segment.durationMs == null ? (
          <span className="ds-unknown" title="The segment never reported its end">
            Unknown
          </span>
        ) : (
          <Duration ms={segment.durationMs} />
        ),
    },
    {
      id: 'cost',
      header: 'Cost',
      priority: 'normal',
      align: 'end',
      sortValue: (segment) => segment.costPaise ?? -1,
      cell: (segment) =>
        segment.costPaise == null ? (
          <span className="ds-unknown">Unpriced</span>
        ) : (
          <Money minorUnits={segment.costPaise} currency={currency} />
        ),
    },
    {
      id: 'turns',
      header: 'Turns',
      priority: 'low',
      align: 'end',
      cell: (segment) => segment.turns,
    },
    {
      id: 'ended',
      header: 'Ended',
      priority: 'low',
      cell: (segment) =>
        segment.ended ? (
          <StatusBadgeV2 tone="neutral" size="sm" label={humaniseEnum(segment.ended)} />
        ) : (
          <span className="ds-unknown">Running</span>
        ),
    },
  ];
}

/** One row per segment in call order; the segment number opens its drawer. */
export function SegmentsTable({
  segments,
  currency,
  onOpen,
}: {
  segments: readonly TimelineSegment[];
  currency: string;
  onOpen: (index: number) => void;
}) {
  return (
    <SectionCard title="Segments" padding="flush">
      <DataTableV2
        key={dataTableRenderKey(false, undefined, segments.length)}
        label="Segments"
        rows={segments}
        rowKey={(segment) => String(segment.index)}
        columns={segmentColumns(onOpen, currency)}
        empty={<EmptyStateV2 variant="first-run" title="No segments recorded" />}
      />
    </SectionCard>
  );
}
