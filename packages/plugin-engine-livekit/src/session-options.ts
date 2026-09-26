import type { AgentSession } from '@livekit/agents';
import type { OvoStt } from './stt-adapter.ts';
import type { OvoTts } from './tts-adapter.ts';
import { assertOptions } from './guards.ts';

export function sessionOptions(
  stt: OvoStt | undefined,
  tts: OvoTts,
  minWords: number,
): ConstructorParameters<typeof AgentSession>[0] {
  const options = {
    stt,
    tts,
    vad: null,
    turnHandling: {
      turnDetection: 'stt' as const,
      interruption: { mode: 'vad' as const, minWords, discardAudioIfUninterruptible: false },
      preemptiveGeneration: { enabled: false },
    },
    aecWarmupDuration: null,
    userAwayTimeout: null,
    ttsTextTransforms: null,
    useTtsAlignedTranscript: false,
    expressive: false,
    connOptions: { sttConnOptions: { maxRetry: 0 }, ttsConnOptions: { maxRetry: 0 } },
  };
  assertOptions(options);
  return options;
}
