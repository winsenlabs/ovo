'use client';
import { useMemo, useState } from 'react';
import { SectionCard } from '../ui/section-card';
import { EmptyStateV2, InlineAlert } from '../ui/feedback-v2';
import { Conversation } from '../ui/conversation';
import { ConversationAudioPlayer, type SeekRequest } from './conversation-audio-player';
import { CallDiagnosisPanel } from './call-diagnosis-panel';
import {
  audioSegments,
  toConversationLines,
  turnMarkers,
  type CallEvidence,
} from '../../lib/derive/call-detail';
import type { TurnRow } from './turn-model';

/**
 * The Conversation tab: the recording on top (segment-availability bar + turn markers), the
 * transcript as a chat view below it (click a line to seek), and the diagnosis summary as a
 * desktop right rail (brief §3 CALLS "Conversation").
 */
export function ConversationTab({
  callId,
  evidence,
  turns,
  turnsError,
}: {
  callId: string;
  evidence: CallEvidence;
  turns: readonly TurnRow[] | undefined;
  turnsError?: string;
}) {
  const [positionMs, setPositionMs] = useState(0);
  const [seekRequest, setSeekRequest] = useState<SeekRequest | null>(null);
  const lines = useMemo(
    () => toConversationLines(evidence.transcript, turns),
    [evidence.transcript, turns],
  );
  const segments = useMemo(() => audioSegments(evidence.recording?.segments), [evidence.recording]);
  const markers = useMemo(
    () => turnMarkers(turns, evidence.call.createdAt, evidence.call.durationMs),
    [turns, evidence.call.createdAt, evidence.call.durationMs],
  );
  const recording = evidence.recording;
  const recordingSource =
    recording?.source ??
    (recording?.id
      ? `/api/v1/calls/${encodeURIComponent(callId)}/live-recordings/${encodeURIComponent(recording.id)}/audio/outbound`
      : undefined);
  const activeId = useMemo(() => {
    const played = lines.filter(
      (line) => !line.interim && line.atMs !== undefined && line.atMs <= positionMs,
    );
    return played.at(-1)?.id;
  }, [lines, positionMs]);

  return (
    <div className="inspector-grid">
      <div className="ds-stack">
        <SectionCard title="Recording">
          {recordingSource && segments.length ? (
            <ConversationAudioPlayer
              src={recordingSource}
              durationMs={evidence.call.durationMs ?? 0}
              segments={segments}
              markers={markers}
              seekRequest={seekRequest}
              onPositionChange={setPositionMs}
              downloadHref={recordingSource}
            />
          ) : (
            <EmptyStateV2 variant="unavailable" title="No recording available">
              This call has no assembled recording track to play.
            </EmptyStateV2>
          )}
        </SectionCard>
        <SectionCard title="Transcript" padding="flush">
          {lines.length ? (
            <Conversation
              lines={lines}
              activeId={activeId}
              onSeek={(atMs) => setSeekRequest({ ms: atMs, nonce: Date.now() })}
            />
          ) : (
            <EmptyStateV2 variant="first-run" title="No transcript recorded" />
          )}
        </SectionCard>
      </div>
      <aside className="ds-stack">
        <SectionCard title="Diagnosis">
          {turnsError && (
            <InlineAlert tone="warn">Turn timings unavailable: {turnsError}</InlineAlert>
          )}
          <CallDiagnosisPanel diagnosis={evidence.diagnosis} />
        </SectionCard>
      </aside>
    </div>
  );
}
