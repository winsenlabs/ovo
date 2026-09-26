import type { StreamingStt, TranscriptRevision } from '@winsendotai/ovo-contracts';

/** Transitional observer for a v1 caller; the v2 Deepgram provider emits SttEvent directly. */
export function observeStreamingTranscripts(
  streaming: StreamingStt,
  observer: (revision: Readonly<TranscriptRevision>) => void | Promise<void>,
): StreamingStt {
  return {
    start: (input) =>
      streaming.start({
        ...input,
        onTranscript: (revision) => {
          try {
            void Promise.resolve(observer(Object.freeze(structuredClone(revision)))).catch(
              () => undefined,
            );
          } catch {
            // Observation cannot interrupt the live STT consumer.
          }
          input.onTranscript(revision);
        },
      }),
  };
}
