'use client';
import { useMemo, type ReactNode } from 'react';
import { DataTableV2, type ColumnV2 } from '../../components/ui/data-table-v2';
import { EmptyStateV2 } from '../../components/ui/feedback-v2';
import { SectionCard } from '../../components/ui/section-card';
import { StatusBadgeV2 } from '../../components/ui/status-badge';
import { formatClock, ticketStateLabel, ticketWaitMs, type DeskTicket } from '../../lib/derive/desk';
import type { HumanTicketView } from '../../lib/types/desk';

interface QueueActions {
  now: number;
  acceptBlock?: string;
  busyId?: string;
  onAccept: (ticket: HumanTicketView) => void;
  onDecline: (ticket: HumanTicketView) => void;
}

function columns(actions: QueueActions): ColumnV2<DeskTicket>[] {
  const { now } = actions;
  return [
    {
      id: 'queue',
      header: 'Queue',
      cell: ({ ticket }) => <strong>{ticket.queueName}</strong>,
    },
    {
      id: 'caller',
      header: 'Caller',
      cell: ({ ticket }) =>
        ticket.callerMasked ? (
          <span className="mono">{ticket.callerMasked}</span>
        ) : (
          <span className="ds-unknown">Hidden</span>
        ),
    },
    {
      id: 'language',
      header: 'Language',
      priority: 'low',
      cell: ({ ticket }) =>
        ticket.language ? <span className="ds-chip">{ticket.language}</span> : <span>—</span>,
    },
    {
      id: 'wait',
      header: 'Wait',
      align: 'end',
      sortValue: (entry) => ticketWaitMs(entry, now),
      cell: (entry) => <span className="mono desk-wait">{formatClock(ticketWaitMs(entry, now))}</span>,
    },
    {
      id: 'priority',
      header: 'Priority',
      priority: 'low',
      cell: ({ ticket }) =>
        ticket.priority > 0 ? <span className="ds-chip">P{ticket.priority}</span> : <span>—</span>,
    },
    {
      id: 'state',
      header: 'State',
      cell: ({ ticket }) => (
        <StatusBadgeV2
          value={ticket.status}
          tone={ticket.offeredToMe ? 'warn' : undefined}
          label={ticketStateLabel(ticket, now)}
        />
      ),
    },
    {
      id: 'actions',
      header: 'Actions',
      align: 'end',
      cell: ({ ticket }) => (
        <span className="button-row">
          <button
            type="button"
            className="button primary"
            disabled={actions.acceptBlock !== undefined || actions.busyId === ticket.id}
            aria-describedby={actions.acceptBlock ? 'desk-accept-reason' : undefined}
            aria-label={`Accept call from ${ticket.callerMasked ?? 'caller'} in ${ticket.queueName}`}
            onClick={() => actions.onAccept(ticket)}
          >
            Accept
          </button>
          {ticket.offeredToMe && (
            <button
              type="button"
              className="button"
              disabled={actions.busyId === ticket.id}
              aria-label={`Decline call in ${ticket.queueName}`}
              onClick={() => actions.onDecline(ticket)}
            >
              Decline
            </button>
          )}
        </span>
      ),
    },
  ];
}

/** The live queue: waiting and offered callers, longest wait ticking, with accept and decline. */
export function QueuePanel({
  rows,
  stale,
  toolbar,
  ...actions
}: QueueActions & { rows: readonly DeskTicket[]; stale: boolean; toolbar?: ReactNode }) {
  const cols = useMemo(() => columns(actions), [actions]);
  return (
    <SectionCard
      title="Queue"
      description="Callers waiting for a person. Shortcuts: A accept, D decline, M mute, H hang up."
      padding="flush"
      actions={
        <>
          {stale && <StatusBadgeV2 tone="warn" label="Reconnecting to the queue" />}
          {toolbar}
        </>
      }
    >
      {actions.acceptBlock && (
        <p id="desk-accept-reason" className="muted desk-reason">
          {actions.acceptBlock}
        </p>
      )}
      <DataTableV2
        label="Callers waiting"
        rows={rows}
        columns={cols}
        rowKey={(entry) => entry.ticket.id}
        empty={
          <EmptyStateV2 title="No callers waiting">
            You will see them here the moment they are offered.
          </EmptyStateV2>
        }
      />
    </SectionCard>
  );
}
