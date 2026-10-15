// Where the live call's VAD would have committed: OVO's energy VAD (the phone row) and its 20 ms
// start/stop state machine run over the whole caller track, as the worker runs them on a call.
// Scribe's manual strategy commits on each `vad.stop`, so these are the commits a stream replays.
import { PHONE_VAD_CONFIG, createEnergyVad } from '../../../plugin-vad/src/index.ts';
import { VadState } from '../../../plugin-vad/src/vad-state.ts';
import type { Pcm } from './wav.ts';

/** Track times (ms, end of the deciding frame) of every `vad.stop`. */
export function vadStops(pcm: Pcm): number[] {
  if (pcm.sampleRate !== 8000 && pcm.sampleRate !== 16000)
    throw new Error(`the energy VAD runs at 8 or 16 kHz, not ${pcm.sampleRate} Hz`);
  const factory = createEnergyVad(PHONE_VAD_CONFIG);
  const analyzer = factory.create(pcm.sampleRate);
  const state = new VadState(factory.params);
  const size = analyzer.frameSamples;
  const stops: number[] = [];
  for (let at = 0; at + size <= pcm.samples.length; at += size) {
    const frame = pcm.samples.subarray(at, at + size);
    const transition = state.observe(analyzer.confidence(frame), analyzer.volume(frame));
    if (transition?.type === 'vad.stop') stops.push(((at + size) / pcm.sampleRate) * 1000);
  }
  return stops;
}
