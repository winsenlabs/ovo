// The VAD of a transcript replay: the engine's own IngressVad (start and stop debounce, hangover)
// over an analyzer that reports what a VAD trace says about each frame, by the replay's clock.
import type { Clock, VadAnalyzerFactory } from '@winsendotai/ovo-contracts';
import { createEnergyVad } from '@winsendotai/ovo-plugin-vad';
import { speakingAt, type VadTrace } from '../corpus/vad-trace.ts';

/**
 * `row` is the agent's energy VAD row, so the debounce matches the call's; `zero` is the clock's
 * reading at call time 0.
 */
export function traceVad(
  trace: VadTrace,
  clock: Clock,
  row: Record<string, unknown> = {},
  zero = 0,
): VadAnalyzerFactory {
  const { params } = createEnergyVad(row);
  return {
    params,
    create: (rate) => {
      const frameSamples = rate / 50;
      // The frame analysed now was received a frame ago: it is judged by its own time.
      const frameMs = (frameSamples * 1000) / rate;
      const speaking = () => speakingAt(trace, clock.now() - zero - frameMs);
      return {
        frameSamples,
        sampleRate: rate,
        confidence: () => (speaking() ? 1 : 0),
        volume: () => (speaking() ? 1 : 0),
        reset() {},
      };
    },
  };
}
