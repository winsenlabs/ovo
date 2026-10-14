'use client';
import { useMemo, useState } from 'react';
import { SectionCard } from '../ui/section-card';
import { Switch } from '../ui/display';
import { Timeline, type TimelineEvent } from '../ui/timeline';
import { EmptyStateV2 } from '../ui/feedback-v2';
import { TelemetryStream } from '../operations/telemetry-stream';
import type { CallEvidence } from '../../lib/derive/call-detail';

const EVENT_PAGE = 100;

/** The Events tab: the call's recorded event timeline, plus a live telemetry stream for a call
 * still in progress (or toggled on manually) — both `LiveRecordingsPanel` and `TelemetryStream`
 * exist already but were mounted nowhere before W14 (brief defect #11). */
export function EventsTab({ callId, evidence }: { callId: string; evidence: CallEvidence }) {
  const [liveToggled, setLiveToggled] = useState(false);
  const callStart = evidence.call.createdAt ? Date.parse(evidence.call.createdAt) : NaN;
  const events = useMemo<TimelineEvent[]>(() => {
    if (!Number.isFinite(callStart)) return [];
    return (evidence.events ?? []).map((event, index) => {
      const at = event.at ? Date.parse(event.at) : NaN;
      const type = event.kind ?? event.type ?? 'event';
      return {
        id: event.id ?? String(index),
        type,
        atMs: Number.isFinite(at) ? at - callStart : index * 1000,
        // `type` is already the row's humanised type label (`Timeline` renders both); echoing
        // it again here as the "summary" just repeated the same text twice per row.
        summary: '',
        payload: event.payload,
      };
    });
  }, [evidence.events, callStart]);
  const live = evidence.call.status === 'in_progress' || liveToggled;
  return (
    <div className="ds-stack">
      <SectionCard
        title="Event timeline"
        description={`${events.length} recorded events`}
        actions={
          evidence.call.status !== 'in_progress' && (
            <Switch checked={liveToggled} onChange={setLiveToggled} label="Live telemetry" />
          )
        }
      >
        {events.length ? (
          <Timeline events={events} groupBy="minute" pageSize={EVENT_PAGE} />
        ) : (
          <EmptyStateV2 variant="first-run" title="No events recorded" />
        )}
      </SectionCard>
      {live && <TelemetryStream callId={callId} />}
    </div>
  );
}
