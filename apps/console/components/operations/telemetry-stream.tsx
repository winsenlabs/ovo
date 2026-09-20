'use client';
import { useEffect, useState } from 'react';
import type { TelemetryEvent } from '../../lib/operator-api';
import {
  EmptyState,
  JsonEvidence,
  Notice,
  Panel,
  PanelHeader,
  ResponsiveTable,
  StatusBadge,
} from '../primitives';

export function TelemetryStream({ callId }: { callId?: string }) {
  const [events, setEvents] = useState<TelemetryEvent[]>([]);
  const [state, setState] = useState<'idle' | 'connecting' | 'live' | 'error'>('idle');
  const [gap, setGap] = useState<string>();
  useEffect(() => {
    setEvents([]);
    setGap(undefined);
    if (!callId) {
      setState('idle');
      return;
    }
    setState('connecting');
    const stream = new EventSource(`/api/v1/calls/${encodeURIComponent(callId)}/stream`);
    stream.addEventListener('open', () => setState('live'));
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
    stream.addEventListener('error', () => setState('error'));
    return () => stream.close();
  }, [callId]);
  return (
    <Panel labelledBy="telemetry-stream-title">
      <PanelHeader
        id="telemetry-stream-title"
        title="Stage and playback stream"
        badge={
          <StatusBadge tone={state === 'live' ? 'good' : state === 'error' ? 'warning' : 'soft'}>
            {state}
          </StatusBadge>
        }
      />
      <div className="panel-body stack">
        <p className="muted">
          Authenticated SSE resumes by sequence. Delivery stages, playback evidence and operation
          outcomes remain separate events.
        </p>
        {gap && <Notice tone="warning">A telemetry sequence gap was reported: {gap}</Notice>}
        {!events.length ? (
          <EmptyState
            title={state === 'error' ? 'Telemetry stream unavailable' : 'Waiting for telemetry'}
          >
            {state === 'error'
              ? 'The performance service may be unconfigured. Existing call evidence remains available above.'
              : 'No stage or playback events have arrived for this call.'}
          </EmptyState>
        ) : (
          <ResponsiveTable label="Live call stage and playback events">
            <thead>
              <tr>
                <th>Sequence</th>
                <th>Stage / event</th>
                <th>Outcome</th>
                <th>Duration</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.eventId}>
                  <td>
                    {event.sequence}
                    <small>{new Date(event.occurredAt).toLocaleTimeString()}</small>
                  </td>
                  <td>
                    <strong>{event.stage ?? event.kind}</strong>
                    <small>{event.kind}</small>
                  </td>
                  <td>{event.outcome ?? '—'}</td>
                  <td>{event.durationMs === undefined ? '—' : `${event.durationMs} ms`}</td>
                  <td>
                    {event.evidence ?? '—'}
                    <JsonEvidence label="Telemetry record" value={event} />
                  </td>
                </tr>
              ))}
            </tbody>
          </ResponsiveTable>
        )}
      </div>
    </Panel>
  );
}
