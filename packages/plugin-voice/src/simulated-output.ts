import { abortableDelay } from './async.ts';
import type {
  SimulatedSpeechOutputConfig,
  SpeechOutput,
  SpeechOutputResult,
  SpeechSegment,
} from './types.ts';

/** Explicit test/local output. It does not claim TTS, audio, or human playback. */
export class SimulatedSpeechOutput implements SpeechOutput {
  readonly played: SpeechSegment[] = [];
  readonly interruptedEpochs: number[] = [];

  constructor(private readonly config: SimulatedSpeechOutputConfig = {}) {}

  async play(
    segment: SpeechSegment,
    options: { signal: AbortSignal },
  ): Promise<SpeechOutputResult> {
    this.played.push(segment);
    await abortableDelay(this.config.latencyMs ?? 0, options.signal);
    return { state: 'completed', evidence: this.config.evidence ?? 'simulated' };
  }

  async interrupt(epoch: number): Promise<void> {
    this.interruptedEpochs.push(epoch);
  }
}
