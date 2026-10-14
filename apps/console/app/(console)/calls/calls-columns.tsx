import type { ColumnV2 } from '../../../components/ui/data-table-v2';
import { StatusBadgeV2 } from '../../../components/ui/status-badge';
import { RelativeTime, Duration } from '../../../components/ui/display';
import { IdChip } from '../../../components/ui/section-card';
import { humaniseEnum } from '../../../lib/status';
import { shortenId } from '../../../lib/format';
import { callDurationMs, endReasonLabel, type CallRow } from '../../../lib/derive/calls';
import { RouteTierBar } from './calls-controls';

/** The Calls list's column set (brief §3 CALLS): humanised everywhere, duration derived
 * client-side, low-priority columns drop to the mobile card view first. */
export function callColumns(agents: Map<string, string>): ColumnV2<CallRow>[] {
  return [
    {
      id: 'started',
      header: 'Started',
      priority: 'high',
      sortValue: (call) => (call.createdAt ? Date.parse(call.createdAt) : 0),
      cell: (call) => (
        <span className="ds-stack" style={{ gap: 2 }}>
          <RelativeTime value={call.createdAt} />
          <IdChip id={call.id} short={shortenId(call.id)} />
        </span>
      ),
    },
    {
      id: 'agent',
      header: 'Agent',
      priority: 'high',
      cell: (call) => (call.releaseId && agents.get(call.releaseId)) || 'Unknown',
    },
    {
      id: 'kind',
      header: 'Kind',
      priority: 'normal',
      cell: (call) => <span className="ds-chip">{humaniseEnum(call.kind)}</span>,
    },
    {
      id: 'status',
      header: 'Status',
      priority: 'normal',
      cell: (call) => <StatusBadgeV2 value={call.status} />,
    },
    {
      id: 'duration',
      header: 'Duration',
      priority: 'normal',
      align: 'end',
      sortValue: (call) => callDurationMs(call) ?? -1,
      cell: (call) => <Duration ms={callDurationMs(call)} />,
    },
    {
      id: 'disposition',
      header: 'Disposition',
      priority: 'normal',
      cell: (call) => humaniseEnum(call.outcome?.disposition),
    },
    {
      id: 'end-reason',
      header: 'End reason',
      priority: 'low',
      cell: (call) => {
        const reason = call.outcome?.endReason;
        if (!reason)
          return call.status === 'in_progress' ? <span className="ds-unknown">—</span> : 'Unknown';
        const label = endReasonLabel(reason);
        return reason.startsWith('error:timeout:') ? (
          <StatusBadgeV2 tone="danger" label={label} />
        ) : (
          label
        );
      },
    },
    {
      id: 'tiers',
      header: 'Route tiers',
      priority: 'low',
      cell: (call) => <RouteTierBar tiers={call.outcome?.tiers ?? {}} />,
    },
    {
      id: 'guardrail',
      header: 'Guardrail',
      priority: 'low',
      cell: (call) => {
        const guardrail = call.outcome?.guardrail;
        const total = (guardrail?.flagged ?? 0) + (guardrail?.blocked ?? 0);
        return total > 0 ? (
          <StatusBadgeV2
            tone="warn"
            label={`${guardrail!.flagged} flagged · ${guardrail!.blocked} blocked`}
          />
        ) : null;
      },
    },
  ];
}
