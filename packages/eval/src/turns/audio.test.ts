import { describe, expect, it } from 'vitest';
import { speechLikePcm16 } from '../../../conformance/src/drivers/audio-gen.ts';
import { alignAudio, readWav, vadTransitions } from './audio.ts';

function wav(pcm: Int16Array, rate = 8000): Uint8Array {
  const bytes = new Uint8Array(44 + pcm.length * 2);
  const view = new DataView(bytes.buffer);
  const tag = (at: number, text: string) =>
    [...text].forEach((c, i) => (bytes[at + i] = c.charCodeAt(0)));
  tag(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, pcm.length * 2, true);
  pcm.forEach((sample, i) => view.setInt16(44 + i * 2, sample, true));
  return bytes;
}

/** The conformance kit's seeded speech-like signal (8 kHz) in `spans` (ms), silence elsewhere. */
function bursts(ms: number, spans: [number, number][]): Int16Array {
  const speech = speechLikePcm16({ seed: 19, ms, rate: 8000 });
  return Int16Array.from(speech, (sample, index) =>
    spans.some(([start, end]) => index / 8 >= start && index / 8 < end) ? sample : 0,
  );
}

describe('caller audio', () => {
  it('reads a 16-bit PCM mono WAV', () => {
    const pcm = Int16Array.from([0, 1, -1, 32767, -32768]);
    expect(readWav(wav(pcm))).toEqual({ pcm, sampleRate: 8000 });
    expect(() => readWav(new Uint8Array(44))).toThrow(/not a WAV/);
  });

  it('runs the production VAD over it, start and stop timed as the engine times them', () => {
    const transitions = vadTransitions(
      bursts(6000, [
        [1000, 2500],
        [4000, 5000],
      ]),
    );
    expect(transitions.map((t) => t.type)).toEqual([
      'vad.start',
      'vad.stop',
      'vad.start',
      'vad.stop',
    ]);
    const [start, stop, again] = transitions.map((t) => t.at);
    // startMs and stopMs are 200 ms: each transition comes about that long into the change.
    expect(start! - 1000).toBeGreaterThanOrEqual(100);
    expect(start! - 1000).toBeLessThanOrEqual(400);
    expect(stop! - 2500).toBeGreaterThanOrEqual(100);
    expect(again! - 4000).toBeLessThanOrEqual(400);
  });

  it('aligns the audio to the live turns the VAD opened', () => {
    const starts = [1000, 5000, 9000, 15_000];
    const live = starts.map((at, i) => ({
      id: `turn-${i}`,
      startedAt: at - 730,
      endAt: at + 1000,
      text: 'x',
      rule: null,
      endpointMs: 500,
      reset: null,
    }));
    // First words a second after each turn started: the VAD opened them.
    const transcripts = live.map((turn, i) => ({
      at: turn.startedAt + 1000,
      type: 'transcript' as const,
      seg: String(i),
      text: 'x',
      final: true,
    }));
    expect(alignAudio(starts, live, transcripts)).toEqual({
      offsetMs: -730,
      matched: 4,
      candidates: 4,
    });
  });
});
