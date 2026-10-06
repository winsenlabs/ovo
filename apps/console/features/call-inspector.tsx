'use client';
import { useEffect, useState } from 'react';
import { apiRequest } from '../lib/api';
import { PageHeader } from '../components/ui/layout';
import { EmptyState, StatusBadge } from '../components/ui/feedback';
import {
  ProductionTrackPlayer,
  type RecordingTrackSegment,
} from '../components/operations/production-track-player';
import { CallOutcomePanel } from './call-outcome-panel';
import {
  CallDiagnosisPanel,
  type CallDiagnosis,
} from '../components/inspector/call-diagnosis-panel';
import { CostPanel, type CostEvidence } from '../components/inspector/cost-panel';
import { TurnWaterfall } from '../components/inspector/turn-waterfall';

const EVENT_PAGE = 100;

type Evidence = {
  call: {
    id: string;
    agentId?: string;
    releaseId?: string;
    status?: string;
    durationMs?: number;
    outcome?: string;
  };
  selections?: Record<string, { pluginId: string; version: string; resolvedVersion?: string }>;
  transcript?: { id?: string; speaker?: string; phase?: string; text: string; atMs?: number }[];
  latency?: {
    stage?: string;
    name?: string;
    durationMs: number;
    parts?: { key: string; ms: number }[];
  }[];
  cost?: CostEvidence & { estimatedPaise?: string | null; reconciledPaise?: string | null };
  diagnosis?: CallDiagnosis;
  recording?: { id?: string; state?: string; source?: string; segments?: RecordingTrackSegment[] };
  events?: { id?: string; kind?: string; type?: string; at?: string }[];
  sttMode?: string;
};
export function CallInspectorFeature({ callId }: { callId: string }) {
  const [evidence, setEvidence] = useState<Evidence>();
  const [error, setError] = useState<string>();
  const [events, setEvents] = useState(EVENT_PAGE);
  const [raw, setRaw] = useState(false);
  useEffect(() => {
    void apiRequest<Evidence>(`/calls/${encodeURIComponent(callId)}/evidence`)
      .then(({ data }) => setEvidence(data))
      .catch((failure) =>
        setError(failure instanceof Error ? failure.message : 'Call evidence unavailable'),
      );
  }, [callId]);
  if (error) return <p role="alert">{error}</p>;
  if (!evidence) return <p role="status">Loading call evidence…</p>;
  const maxLatency = Math.max(1, ...(evidence.latency ?? []).map((item) => item.durationMs));
  const recording = evidence.recording;
  const recordingSource =
    recording?.source ??
    (recording?.id
      ? `/api/v1/calls/${encodeURIComponent(callId)}/live-recordings/${encodeURIComponent(recording.id)}/audio/outbound`
      : undefined);
  return (
    <div className="ui-stack">
      <PageHeader
        eyebrow="Call inspector"
        title={`Call ${evidence.call.id}`}
        description={`Agent ${evidence.call.agentId ?? 'unknown'} · release ${evidence.call.releaseId ?? 'unknown'}`}
        actions={
          <StatusBadge tone="soft">
            {evidence.call.outcome ?? evidence.call.status ?? 'Unknown'}
          </StatusBadge>
        }
      />
      <div className="ui-cluster">
        <span>
          Duration:{' '}
          {evidence.call.durationMs == null ? 'Unavailable' : `${evidence.call.durationMs} ms`}
        </span>
        <span>STT mode: {evidence.sttMode ?? 'Unknown'}</span>
        {Object.entries(evidence.selections ?? {}).map(([slot, selection]) => (
          <span key={slot} className="badge soft">
            {slot}: {selection.pluginId}@{selection.resolvedVersion ?? selection.version}
          </span>
        ))}
      </div>
      <section className="panel panel-body">
        <h2>Outcome</h2>
        <CallOutcomePanel callId={callId} />
      </section>
      <section className="panel panel-body">
        <h2>End reason and errors</h2>
        <CallDiagnosisPanel diagnosis={evidence.diagnosis} />
      </section>
      <section className="panel panel-body">
        <h2>Turns</h2>
        <TurnWaterfall callId={callId} />
      </section>
      <div className="inspector-grid">
        <div className="ui-stack">
          <section className="panel panel-body">
            <h2>Recording</h2>
            {recordingSource && recording?.segments?.length ? (
              <ProductionTrackPlayer
                source={recordingSource}
                track="outbound"
                recordingState={recording.state ?? 'partial'}
                segments={recording.segments}
              />
            ) : (
              <EmptyState title="No recording available" />
            )}
          </section>
          <section className="panel panel-body">
            <h2>Aligned transcript</h2>
            <ol>
              {evidence.transcript?.map((item, index) => (
                <li key={item.id ?? index}>
                  <strong>
                    {item.speaker ?? 'Speaker'} · {item.phase ?? 'final'}
                  </strong>{' '}
                  {item.text}
                  <small>{item.atMs == null ? 'Time unavailable' : `${item.atMs} ms`}</small>
                </li>
              ))}
            </ol>
          </section>
        </div>
        <div className="ui-stack">
          <section className="panel panel-body">
            <h2>Cost</h2>
            <CostPanel callId={callId} cost={evidence.cost} />
          </section>
          <details className="panel panel-body">
            <summary>Engine latency breakdown</summary>
            <table>
              <thead>
                <tr>
                  <th>Turn</th>
                  <th>Total</th>
                  <th>Parts</th>
                </tr>
              </thead>
              <tbody>
                {evidence.latency?.map((part, index) => (
                  <tr key={index}>
                    <td>{part.stage ?? part.name ?? 'Stage'}</td>
                    <td>
                      {part.durationMs} ms
                      <div
                        className="latency-bar"
                        style={{ width: `${Math.max(2, (100 * part.durationMs) / maxLatency)}%` }}
                      />
                    </td>
                    <td className="mono">
                      {part.parts?.map((item) => `${item.key} ${item.ms} ms`).join(' · ') || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
          <section className="panel panel-body">
            <h2>Event timeline</h2>
            <ol>
              {evidence.events?.slice(0, events).map((event, index) => (
                <li key={event.id ?? index}>
                  {event.kind ?? event.type ?? 'Event'} · {event.at ?? 'time unavailable'}
                </li>
              ))}
            </ol>
            {(evidence.events?.length ?? 0) > events && (
              <button className="button small" onClick={() => setEvents(events + EVENT_PAGE)}>
                Show more of {evidence.events!.length - events} events
              </button>
            )}
          </section>
        </div>
      </div>
      <details onToggle={(event) => setRaw(event.currentTarget.open)}>
        <summary>Raw evidence</summary>
        {/* Serialised only when opened: on a long call this is megabytes of JSON. */}
        {raw && <pre className="mono">{JSON.stringify(evidence, null, 2)}</pre>}
      </details>
    </div>
  );
}
