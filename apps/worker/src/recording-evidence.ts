import type { VoiceSessionEngine } from '@winsendotai/ovo-contracts';
import type { LiveRecordingCapture } from '@winsendotai/ovo-plugin-recordings';

/** Preserve the recorder's scheduler-shaped evidence seam until C2 changes capture. */
export function attachRecordingEvidence(
  capture: LiveRecordingCapture,
  engine: Pick<VoiceSessionEngine, 'subscribe'>,
): () => void {
  return capture.attachEvidence({
    subscribe(listener) {
      return engine.subscribe((event) => {
        if (event.type === 'speech') listener(event.evidence);
      });
    },
  });
}
