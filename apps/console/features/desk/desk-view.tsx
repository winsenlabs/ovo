'use client';
import { useCallback, useState } from 'react';
import { useConfirmDialog } from '../../components/ui/dialog';
import { EmptyStateV2, ErrorState, InlineAlert, SkeletonTableRows } from '../../components/ui/feedback-v2';
import { Duration } from '../../components/ui/display';
import { KpiCard, KpiStrip } from '../../components/ui/kpi';
import { PageHeader } from '../../components/ui/layout';
import { useActiveCall } from '../../lib/data/use-active-call';
import { useDesk, type AcceptOutcome } from '../../lib/data/use-desk';
import { useNow } from '../../lib/data/use-now';
import { acceptBlock, deskKpis, nextToAccept } from '../../lib/derive/desk';
import type { HumanTicketView } from '../../lib/types/desk';
import { ActiveCall } from './active-call';
import { AlertsToggle } from './alerts-toggle';
import { PresenceControl } from './presence-control';
import { QueuePanel } from './queue-panel';
import { useQueueAlerts } from './queue-alerts';
import { useDeskShortcuts } from './shortcuts';

const OUTCOME_TEXT: Partial<Record<AcceptOutcome['kind'], string>> = {
  at_capacity: 'You are at your call limit. Finish a call first.',
  not_eligible: 'That call is not for your queues.',
  room_unavailable: 'Calls cannot be answered in the browser right now.',
};

/** `/desk`: presence, the live queue and the call in progress. */
export function DeskView() {
  const desk = useDesk();
  const now = useNow();
  const [busyId, setBusyId] = useState<string>();
  const [deviceId, setDeviceId] = useState<string>();
  const { confirm, dialog } = useConfirmDialog();
  const api = useActiveCall({
    me: desk.me,
    tickets: desk.state.tickets,
    onCommandError: (text) => desk.notify({ tone: 'danger', text }),
  });
  const call = api.call;
  const status = desk.me?.status;
  const announcement = useQueueAlerts(desk.rows, desk.phase === 'ready' && status === 'AVAILABLE');
  const queueInfo = desk.me?.queues.find((queue) => queue.id === call?.ticket.queueId);
  const wrapUpPending = Boolean(
    call?.ended && !call.ended.wrapUpDone && (queueInfo?.wrapUp.required ?? false),
  );
  const block = acceptBlock({
    status,
    hasActiveCall: call !== undefined && call.phase !== 'ended',
    wrapUpPending,
    roomReachable: desk.roomReachable,
  });

  const accept = useCallback(
    async (ticket: HumanTicketView) => {
      setBusyId(ticket.id);
      try {
        const outcome = await desk.accept(ticket);
        if (outcome.kind === 'accepted') {
          await api.start(outcome.result);
          if (deviceId) await api.setInputDevice(deviceId);
        } else if (outcome.kind === 'error') desk.notify({ tone: 'danger', text: outcome.message });
        else if (OUTCOME_TEXT[outcome.kind])
          desk.notify({ tone: 'warn', text: OUTCOME_TEXT[outcome.kind]! });
      } finally {
        setBusyId(undefined);
      }
    },
    [desk, api, deviceId],
  );
  const hangUp = async () => {
    if (call && call.phase !== 'ended' && (await confirm('Hang up', 'End this call for the caller too?')))
      await api.hangUp();
  };
  const sendBack = async (key: string, label: string) => {
    if (await confirm('Send back to AI agent', `Hand this caller back to ${label}?`))
      await api.sendBack(key);
  };
  useDeskShortcuts({
    accept: () => {
      const next = nextToAccept(desk.rows);
      if (next && !block) void accept(next);
    },
    decline: () => {
      const next = desk.rows.find((entry) => entry.ticket.offeredToMe)?.ticket;
      if (next) void desk.decline(next);
    },
    mute: () => call && call.phase !== 'ended' && void api.setMuted(!call.muted),
    hangUp: () => void hangUp(),
  });

  const kpis = deskKpis(desk.state, { live: desk.live, now });
  const teams = desk.me?.profile.teamIds.length ? desk.me.profile.teamIds.join(', ') : 'all teams';
  const header = (
    <PageHeader
      eyebrow="Calls"
      title="Operator desk"
      description={desk.me ? `Answering calls for ${teams}.` : 'Answer callers handed over by the AI agents.'}
      actions={
        desk.me && (
          <PresenceControl
            status={desk.me.status}
            deviceId={deviceId}
            disabledReason={
              desk.roomReachable === false
                ? 'Calls cannot be answered in the browser right now.'
                : undefined
            }
            onDevice={setDeviceId}
            onChange={(next) => void desk.setStatus(next)}
          />
        )
      }
    />
  );

  if (desk.phase === 'loading')
    return (
      <div className="ds-stack">
        {header}
        <KpiStrip>
          {['Waiting now', 'Longest wait', 'My calls', 'Online operators', 'Handled (24 h)'].map((label) => (
            <KpiCard key={label} label={label} loading />
          ))}
        </KpiStrip>
        <SkeletonTableRows rows={4} columns={6} />
      </div>
    );
  if (desk.phase === 'disabled')
    return (
      <div className="ds-stack">
        {header}
        <EmptyStateV2 variant="unavailable" title="The operator desk is not enabled here">
          Human queues are switched off on this installation, so no calls can be handed to people.
        </EmptyStateV2>
      </div>
    );
  if (desk.phase === 'not_operator')
    return (
      <div className="ds-stack">
        {header}
        <EmptyStateV2 variant="unavailable" title="Your account is not set up as an operator">
          Ask an administrator to add you under Human queues, Operators.
        </EmptyStateV2>
      </div>
    );
  if (desk.phase === 'error')
    return (
      <div className="ds-stack">
        {header}
        <ErrorState message={desk.error ?? 'The operator desk could not be loaded.'} onRetry={() => void desk.reload()} />
      </div>
    );

  return (
    <div className="ds-stack desk">
      {header}
      <div className="sr-only" aria-live="polite" role="status">
        {announcement}
      </div>
      {desk.notice && (
        <InlineAlert tone={desk.notice.tone} onRetry={undefined}>
          {desk.notice.text}
        </InlineAlert>
      )}
      {desk.roomReachable === false && (
        <InlineAlert tone="warn">
          Calls cannot be answered in the browser right now. The room server is unreachable, so you
          cannot go Available until it is back.
        </InlineAlert>
      )}
      <KpiStrip>
        <KpiCard
          label="Waiting now"
          value={kpis.waiting}
          footnote={kpis.waiting !== null && kpis.waiting > 5 ? 'Above 5, callers are queuing' : undefined}
        />
        <KpiCard
          label="Longest wait"
          value={kpis.longestWaitMs === null ? null : <Duration ms={kpis.longestWaitMs} />}
        />
        <KpiCard label="My active calls" value={kpis.mine} />
        <KpiCard label="Online operators" value={kpis.online} />
        <KpiCard label="Handled (24 h)" value={kpis.handledToday} />
      </KpiStrip>
      <div className={`desk-layout${call || desk.mine[0] ? ' has-active' : ''}`}>
        <div className="desk-active">
          {call ? (
            <ActiveCall
              call={call}
              queue={queueInfo}
              api={api}
              now={now}
              onHangUp={() => void hangUp()}
              onSendBack={(key, label) => void sendBack(key, label)}
            />
          ) : desk.mine[0] ? (
            <InlineAlert tone="info">
              You have a call in progress.{' '}
              <button type="button" className="text-button" onClick={() => void api.resume(desk.mine[0]!)}>
                Rejoin call
              </button>
            </InlineAlert>
          ) : null}
        </div>
        <div className="desk-queue">
          <QueuePanel
            rows={desk.rows}
            now={now}
            stale={desk.stale}
            acceptBlock={block}
            busyId={busyId}
            toolbar={<AlertsToggle />}
            onAccept={(ticket) => void accept(ticket)}
            onDecline={(ticket) => void desk.decline(ticket)}
          />
        </div>
      </div>
      {dialog}
    </div>
  );
}
