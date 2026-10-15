// What a configuration said for a region: its committed transcript, and everything it showed.
import type { UtteranceRecording } from './stream.ts';

/** The final transcript: each segment's last final, in the order the segments first finalised. */
export function finalText(recording: Pick<UtteranceRecording, 'events'>): string {
  const finals = new Map<string, string>();
  for (const event of recording.events)
    if (event.kind === 'final') finals.set(event.segmentId, event.text.trim());
  return [...finals.values()].filter(Boolean).join(' ');
}

/**
 * Everything the configuration put in front of the host: the finals, and the last partial of any
 * segment that never finalised. A host that opens turns on partials acts on both, so words heard
 * where the caller said nothing count from here.
 */
export function heardText(recording: Pick<UtteranceRecording, 'events'>): string {
  const latest = new Map<string, { kind: 'partial' | 'final'; text: string }>();
  for (const event of recording.events) {
    const seen = latest.get(event.segmentId);
    if (seen?.kind === 'final' && event.kind === 'partial') continue;
    latest.set(event.segmentId, { kind: event.kind, text: event.text.trim() });
  }
  return [...latest.values()]
    .map((entry) => entry.text)
    .filter(Boolean)
    .join(' ');
}
