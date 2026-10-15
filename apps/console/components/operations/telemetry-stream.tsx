'use client';
import { useEffect, useRef, useState } from 'react';
import type { TelemetryEvent } from '../../lib/operator-api';
import { SectionCard } from '../ui/section-card';
import { StatusBadgeV2 } from '../ui/status-badge';
import { EmptyStateV2, InlineAlert } from '../ui/feedback-v2';
import { DataTableV2, type ColumnV2 } from '../ui/data-table-v2';
import { dataTableRenderKey } from '../../lib/data-table-remount-key';
import { Duration, RelativeTime } from '../ui/display';
import { humaniseEnum } from '../../lib/status';

/** The in-call live feed (`GET /v1/calls/:id/stream`): authenticated SSE, resumable by sequence,
 * for a call still in progress or a user-toggled "Live" view (brief defect #11 — this panel
 * existed before W14 but was mounted nowhere). */
export function TelemetryStream({ callId }: { callId?: string }) {
  const [events, setEvents] = useState<TelemetryEvent[]>([]);
  const [state, setState] = useState<'idle' | 'connecting' | 'live' | 'error' | 'ended'>('idle');
  const [gap, setGap] = useState<string>();
  // Whether this connection ever actually opened. `EventSource`'s generic `error` event fires
  // both for "never connected at all" (worth an amber warning) and for "connected fine, then the
  // server ended the response" (by spec `readyState` goes back to `CONNECTING` for an automatic
  // retry either way, so it can't tell the two apart) — a normal stream close after a real `open`
  // read as the same scary "Error" badge as a misconfigured endpoint (minor #10).
  const reachedLive = useRef(false);
  useEffect(() => {
    setEvents([]);
    setGap(undefined);
    reachedLive.current = false;
    if (!callId) {
      setState('idle');
      return;
    }
    setState('connecting');
    const stream = new EventSource(`/api/v1/calls/${encodeURIComponent(callId)}/stream`);
    stream.addEventListener('open', () => {
      reachedLive.current = true;
      setState('live');
    });
    stream.addEventListener('telemetry', (message) => {
      try {
        const event = JSON.parse((message as MessageEvent<string>).data) as TelemetryEvent;
        setEvents((current) =>
          [...current.filter((item) => item.sequence !== event.sequence), event]
            .sort((a, b) => a.sequence - b.sequence)
            .slice(-200),
        );
      } catch {
        setState('error');
      }
    });
    stream.addEventListener('gap', (message) => setGap((message as MessageEvent<string>).data));
    stream.addEventListener('error', () => {
      setState(reachedLive.current ? 'ended' : 'error');
    });
    return () => stream.close();
  }, [callId]);
  const columns: ColumnV2<TelemetryEvent>[] = [
    {
      id: 'sequence',
      header: 'Sequence',
      cell: (event) => (
        <>
          {event.sequence} <RelativeTime value={event.occurredAt} />
        </>
      ),
    },
    {
      id: 'stage',
      header: 'Stage / event',
      cell: (event) => humaniseEnum(event.stage ?? event.kind),
    },
    {
      id: 'outcome',
      header: 'Outcome',
      cell: (event) => (event.outcome ? humaniseEnum(event.outcome) : '—'),
    },
    {
      id: 'duration',
      header: 'Duration',
      align: 'end',
      cell: (event) => <Duration ms={event.durationMs} />,
    },
    { id: 'evidence', header: 'Evidence', priority: 'low', cell: (event) => event.evidence ?? '—' },
  ];
  return (
    <SectionCard
      title="Live telemetry"
      description="Authenticated SSE, resumable by sequence. Delivery stages, playback evidence and operation outcomes stay separate events."
      actions={
        <StatusBadgeV2
          tone={state === 'live' ? 'ok' : state === 'error' ? 'warn' : 'neutral'}
          label={humaniseEnum(state)}
        />
      }
      padding="flush"
    >
      {gap && <InlineAlert tone="warn">A telemetry sequence gap was reported: {gap}</InlineAlert>}
      {events.length ? (
        <DataTableV2
          key={dataTableRenderKey(false, undefined, events.length)}
          label="Live call stage and playback events"
          rows={events}
          rowKey={(event) => event.eventId}
          columns={columns}
        />
      ) : (
        <EmptyStateV2
          variant={state === 'error' ? 'unavailable' : 'first-run'}
          title={
            state === 'error'
              ? 'Telemetry stream unavailable'
              : state === 'ended'
                ? 'Telemetry stream ended'
                : 'Waiting for telemetry'
          }
        >
          {state === 'error'
            ? 'The performance service may be unconfigured. Existing call evidence remains available above.'
            : state === 'ended'
              ? 'This call has ended; no further telemetry will arrive.'
              : 'No stage or playback events have arrived for this call.'}
        </EmptyStateV2>
      )}
    </SectionCard>
  );
}
