import type { EngineEvent, VoiceSessionEngine } from '@winsendotai/ovo-contracts';

export type TranscriptEntry =
  | {
      type: 'transcript.user.interim' | 'transcript.user.final';
      speaker: 'user';
      turnId: string;
      segmentId: string;
      text: string;
    }
  | {
      type:
        'transcript.agent.generated' | 'transcript.agent.played' | 'transcript.agent.interrupted';
      speaker: 'agent';
      segmentId: string;
      text: string;
      spokenPrefix?: string;
    };

export function transcriptEntry(event: EngineEvent): TranscriptEntry | undefined {
  if (event.type === 'user.transcript')
    return {
      type: `transcript.user.${event.stability}`,
      speaker: 'user',
      turnId: event.turnId,
      segmentId: event.segmentId,
      text: event.text,
    };
  if (event.type === 'agent.transcript')
    return {
      type: `transcript.agent.${event.state}`,
      speaker: 'agent',
      segmentId: event.segmentId,
      text: event.text,
      ...(event.spokenPrefix === undefined ? {} : { spokenPrefix: event.spokenPrefix }),
    };
  return undefined;
}

export function projectTranscript(events: readonly EngineEvent[]): TranscriptEntry[] {
  return events.flatMap((event) => {
    const entry = transcriptEntry(event);
    return entry ? [entry] : [];
  });
}

export function subscribeTranscript(
  engine: Pick<VoiceSessionEngine, 'subscribe'>,
  onEntry: (entry: TranscriptEntry) => void,
): () => void {
  return engine.subscribe((event) => {
    const entry = transcriptEntry(event);
    if (entry) onEntry(entry);
  });
}
