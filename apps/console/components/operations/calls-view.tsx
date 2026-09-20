'use client';
import { useCallback, useEffect, useState } from 'react';
import {
  apiRequest,
  items,
  type CallEvent,
  type CallSummary,
  type SessionIdentity,
  type UsageItem,
} from '../../lib/api';
import type { CallCostSummary } from '../../lib/operator-api';
import {
  EmptyState,
  JsonEvidence,
  LoadingBlock,
  Notice,
  Panel,
  PanelHeader,
  ResponsiveTable,
  StatusBadge,
} from '../primitives';
import { RecordingPanel } from './recording-panel';
import { TelemetryStream } from './telemetry-stream';
import { LiveCallForm } from './live-call-form';

type CallEvidence = {
  detail?: CallSummary & Record<string, unknown>;
  events: CallEvent[];
  usage: UsageItem[];
  cost?: CallCostSummary;
  error?: string;
};

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;
function eventTone(type: string): 'good' | 'warning' | 'danger' | 'soft' {
  if (/failed|error|unknown/i.test(type)) return 'danger';
  if (/interrupt|cancel/i.test(type)) return 'warning';
  if (/completed|played|confirmed|succeeded/i.test(type)) return 'good';
  return 'soft';
}

export function CallsView({ role }: { role: SessionIdentity['role'] }) {
  const [calls, setCalls] = useState<CallSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const [evidence, setEvidence] = useState<CallEvidence>({ events: [], usage: [] });
  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const { data } = await apiRequest<unknown>('/calls');
      const next = items<CallSummary>(data);
      setCalls(next);
      setSelectedId((current) => current ?? next[0]?.id);
    } catch (failure) {
      setError(errorMessage(failure, 'Call data unavailable.'));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!selectedId) {
      setEvidence({ events: [], usage: [] });
      return;
    }
    let current = true;
    setEvidence({ events: [], usage: [] });
    Promise.allSettled([
      apiRequest<CallSummary & Record<string, unknown>>(`/calls/${selectedId}`),
      apiRequest<unknown>(`/calls/${selectedId}/events`),
      apiRequest<unknown>(`/calls/${selectedId}/usage`),
      apiRequest<CallCostSummary>(`/calls/${selectedId}/cost`),
    ]).then(([detail, events, usage, cost]) => {
      if (!current) return;
      setEvidence({
        detail: detail.status === 'fulfilled' ? detail.value.data : undefined,
        events: events.status === 'fulfilled' ? items<CallEvent>(events.value.data) : [],
        usage: usage.status === 'fulfilled' ? items<UsageItem>(usage.value.data) : [],
        cost: cost.status === 'fulfilled' ? cost.value.data : undefined,
        error:
          [detail, events, usage, cost].find((result) => result.status === 'rejected')?.status ===
          'rejected'
            ? 'Some call evidence could not be loaded. Missing evidence is not treated as zero.'
            : undefined,
      });
    });
    return () => {
      current = false;
    };
  }, [selectedId]);
  if (loading) return <LoadingBlock label="Loading call evidence" />;
  if (error) return <Notice tone="danger">{error}</Notice>;
  const realCalls = calls.filter((call) => call.kind !== 'simulation');
  const simulationCalls = calls.filter((call) => call.kind === 'simulation');
  return (
    <div className="stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Evidence</p>
          <h1>Calls</h1>
          <p className="muted">Real sessions and simulations remain visibly separate.</p>
        </div>
        <button className="button" onClick={load}>
          Refresh
        </button>
      </header>
      <div className="metrics">
        <div>
          <span>Real calls loaded</span>
          <strong>{realCalls.length}</strong>
          <small>From management API</small>
        </div>
        <div>
          <span>Simulations loaded</span>
          <strong>{simulationCalls.length}</strong>
          <small>No carrier calls</small>
        </div>
        <div>
          <span>Telemetry stream</span>
          <strong>{selectedId ? 'SSE' : '—'}</strong>
          <small>Selected call stages and playback</small>
        </div>
      </div>
      <LiveCallForm role={role} onLaunched={load} />
      {calls.length === 0 ? (
        <EmptyState title="No call data returned">
          The connected API has no matching real calls or simulations. This is not a telemetry
          success claim.
        </EmptyState>
      ) : (
        <div className="call-layout">
          <Panel labelledBy="call-list-title">
            <PanelHeader
              id="call-list-title"
              title="Sessions"
              badge={<StatusBadge>{calls.length}</StatusBadge>}
            />
            <div className="call-list">
              {calls.map((call) => (
                <button
                  key={call.id}
                  className={selectedId === call.id ? 'selected' : ''}
                  onClick={() => setSelectedId(call.id)}
                >
                  <span>
                    <strong>{call.kind === 'simulation' ? 'Simulation' : 'Real call'}</strong>
                    <small className="mono">{call.id}</small>
                  </span>
                  <StatusBadge tone={call.kind === 'simulation' ? 'soft' : 'neutral'}>
                    {call.status ?? 'Status unavailable'}
                  </StatusBadge>
                  <small>
                    {call.createdAt
                      ? new Date(call.createdAt).toLocaleString()
                      : 'Timestamp unavailable'}
                  </small>
                </button>
              ))}
            </div>
          </Panel>
          <div className="stack">
            <Panel labelledBy="inspector-title">
              <PanelHeader
                id="inspector-title"
                title="Call inspector"
                badge={
                  <StatusBadge tone={evidence.detail?.kind === 'simulation' ? 'soft' : 'neutral'}>
                    {evidence.detail?.kind === 'simulation'
                      ? 'Simulation evidence'
                      : 'Recorded evidence'}
                  </StatusBadge>
                }
              />
              <div className="panel-body stack">
                {evidence.error && <Notice tone="warning">{evidence.error}</Notice>}
                <JsonEvidence
                  label="Configuration and session metadata"
                  value={evidence.detail ?? { state: 'unavailable' }}
                />
                <div>
                  <h3>Ordered event timeline</h3>
                  {evidence.events.length === 0 ? (
                    <EmptyState title="No events returned">
                      Generated, sent, played, completed and interrupted evidence cannot be inferred
                      without recorded events.
                    </EmptyState>
                  ) : (
                    <ol className="timeline">
                      {evidence.events.map((event) => (
                        <li key={event.id}>
                          <span className="timeline-dot" aria-hidden="true" />
                          <div>
                            <div className="timeline-heading">
                              <strong>{event.type}</strong>
                              <StatusBadge tone={eventTone(event.type)}>{event.type}</StatusBadge>
                            </div>
                            <small>
                              Sequence {event.sequence} · epoch {event.epoch} ·{' '}
                              {new Date(event.at).toLocaleString()}
                            </small>
                            <JsonEvidence label="Event payload" value={event.payload} />
                          </div>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
                <div>
                  <h3>Usage ledger</h3>
                  {evidence.cost && (
                    <div className="metrics">
                      <div>
                        <span>Estimated</span>
                        <strong>{evidence.cost.estimatedPaise} paise</strong>
                        <small>INR ledger</small>
                      </div>
                      <div>
                        <span>Reconciled delta</span>
                        <strong>{evidence.cost.reconciledPaise} paise</strong>
                        <small>Invoice corrections</small>
                      </div>
                      <div>
                        <span>Total</span>
                        <strong>{evidence.cost.totalPaise} paise</strong>
                        <small>{evidence.cost.currency}</small>
                      </div>
                    </div>
                  )}
                  {evidence.usage.length === 0 ? (
                    <EmptyState title="No usage entries">
                      Cost remains unavailable. The console does not turn missing usage into zero
                      cost.
                    </EmptyState>
                  ) : (
                    <ResponsiveTable label="Native usage and cost entries">
                      <thead>
                        <tr>
                          <th>Provider</th>
                          <th>Quantity</th>
                          <th>Cost</th>
                          <th>State</th>
                        </tr>
                      </thead>
                      <tbody>
                        {evidence.usage.map((entry, index) => (
                          <tr key={entry.id ?? index}>
                            <td>{entry.provider ?? 'Not supplied'}</td>
                            <td>
                              {entry.quantity} {entry.unit}
                            </td>
                            <td>
                              {entry.amountMinor
                                ? `${entry.amountMinor} minor ${entry.currency ?? ''}`
                                : 'Not supplied'}
                            </td>
                            <td>
                              {entry.state ?? (entry.estimated ? 'estimated' : 'not classified')}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </ResponsiveTable>
                  )}
                </div>
                <Notice tone="warning">
                  Transcript/audio alignment remains unavailable without a registered production
                  recording manifest API. Generated text is never relabelled as delivered speech.
                </Notice>
              </div>
            </Panel>
            <RecordingPanel
              call={evidence.detail ?? calls.find((call) => call.id === selectedId)}
              role={role}
            />
            <TelemetryStream callId={selectedId} />
          </div>
        </div>
      )}
    </div>
  );
}
