import { describe, expect, it } from 'vitest';
import { MULAW_8K, type SpeechSegment, type VoiceMediaTransport } from '@winsendotai/ovo-contracts';
import { CachedMediaAudioPlayer, observeFirstByte } from '../src/cached-media-player.ts';
import { SessionSpeechOutput, prefetchSpeech } from '../src/session-graph-speech-output.ts';

/**
 * LAT-1: the live worker output streams synthesized audio to the carrier chunk by chunk. First
 * audio is bounded by the provider's time to first byte, not by the time to synthesize a sentence.
 */
describe('live speech output streaming', () => {
  it('sends first carrier audio while synthesis of the segment is still running', async () => {
    const order: string[] = [];
    const marks = new Set<(name: string) => void>();
    const transport: VoiceMediaTransport = {
      sessionId: 'session-1',
      bufferedBytes: 0,
      async sendAudio() {
        order.push('carrier:audio');
      },
      async sendMark(name) {
        queueMicrotask(() => {
          for (const listener of marks) listener(name);
        });
      },
      async clear() {},
      onAudio: () => () => undefined,
      onMark(listener) {
        marks.add(listener);
        return () => marks.delete(listener);
      },
      onDtmf: () => () => undefined,
      onClose: () => () => undefined,
      async close() {},
    };
    let finishSynthesis!: () => void;
    const synthesisGate = new Promise<void>((resolve) => (finishSynthesis = resolve));
    async function* synthesize(): AsyncIterable<Uint8Array> {
      order.push('tts:first-chunk');
      yield new Uint8Array(320).fill(0xff);
      await synthesisGate;
      order.push('tts:last-chunk');
      yield new Uint8Array(320).fill(0xff);
      order.push('tts:done');
    }
    const timing: string[] = [];
    const output = new SessionSpeechOutput(
      new CachedMediaAudioPlayer(transport, {
        format: MULAW_8K,
        playbackEvidence: 'carrier-played',
      }),
      (_segment, signal) =>
        prefetchSpeech(
          observeFirstByte(synthesize(), () => timing.push('tts-first-byte')),
          signal,
          262_144,
        ),
      () => timing.push('carrier-first-audio'),
    );
    const segment: SpeechSegment = {
      id: 'speech-1',
      text: 'Your balance is ready.',
      epoch: 1,
      kind: 'response',
      generatedAt: 0,
    };

    const played = output.play(segment, { signal: new AbortController().signal });
    await until(() => order.includes('carrier:audio'));

    // The provider is still holding the rest of the sentence when the caller starts hearing it.
    expect(order[0]).toBe('tts:first-chunk');
    expect(order).not.toContain('tts:last-chunk');
    expect(timing).toEqual(['tts-first-byte', 'carrier-first-audio']);
    finishSynthesis();
    await expect(played).resolves.toMatchObject({ state: 'completed', evidence: 'confirmed' });
    expect(order.indexOf('tts:done')).toBeGreaterThan(order.indexOf('carrier:audio'));
    output.dispose();
  });
});

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition was not reached');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
