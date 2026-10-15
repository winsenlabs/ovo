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
      // Minor #2: a vertical `ds-stack` of the relative time over the ID chip wrapped to 3-4
      // lines (~100px rows) at the widths this column actually gets — one nowrap row, chip
      // inline, plus a width floor so the two never get squeezed into wrapping again.
      width: '200px',
      sortValue: (call) => (call.createdAt ? Date.parse(call.createdAt) : 0),
      cell: (call) => (
        <span
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 8,
            flexWrap: 'nowrap',
            whiteSpace: 'nowrap',
          }}
        >
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
      // Minor #5 (partial): the mobile card showed all 6 visible fields end to end — "kind" is
      // the one the brief's own mobile summary ("agent + status / started · duration /
      // disposition") drops, so it goes to `low` to actually shrink the card instead of just
      // relying on a future custom card renderer for all of it.
      priority: 'low',
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
      // Minor #13: `-1` for an in-progress call's unknown duration sorted it as the *shortest*
      // call, so "Duration ascending" put every live call first. `Infinity` keeps unknown
      // durations last ascending (and first descending, where "longest first" already reads as
      // "still running" in that position).
      sortValue: (call) => callDurationMs(call) ?? Number.POSITIVE_INFINITY,
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
