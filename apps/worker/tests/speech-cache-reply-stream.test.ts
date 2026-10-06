import { expect, it } from 'vitest';
import type {
  AudioFormat,
  SpeechSegment,
  SynthesisInput,
  TtsReply,
} from '@winsendotai/ovo-contracts';
import { WorkerSpeechCacheRuntime } from '../src/speech-cache-runtime.ts';
import { composeCacheOutput, fixtureRelease, RecordingTts } from './speech-cache-harness.ts';

/** RecordingTts with LAT-5 reply contexts and a warm-up. */
class ReplyTts extends RecordingTts {
  readonly warmed: AudioFormat[] = [];
  readonly replies: { segments: string[]; closed: boolean }[] = [];

  async warm(input: { format: AudioFormat }): Promise<void> {
    this.warmed.push(input.format);
  }

  async openReply(input: Omit<SynthesisInput, 'text'>): Promise<TtsReply> {
    const record = { segments: [] as string[], closed: false };
    this.replies.push(record);
    return {
      segment: (text, signal) => {
        record.segments.push(text);
        return this.synthesize({ ...input, text, signal });
      },
      close: async () => void (record.closed = true),
    };
  }
}

// LAT-5 and Wave 2 request #2 on the speech-cache output: the session's TTS is warmed when the
// output is built, the uncached lines of one reply share one provider context, a fixed line still
// renders on its own (a stored clip is exactly its own text), and barge-in closes the context.
it('streams uncached reply lines through one context and keeps fixed lines standalone', async () => {
  const tts = new ReplyTts(true);
  const runtime = new WorkerSpeechCacheRuntime();
  const session = await composeCacheOutput({
    release: fixtureRelease({ speechCache: { enabled: true }, uncertainty: 'I am not sure.' }),
    cache: runtime.cache,
    tts,
  });
  const segment = (id: string, text: string): SpeechSegment => ({
    id,
    text,
    epoch: 7,
    kind: 'response',
    generatedAt: 0,
  });
  const play = (value: SpeechSegment) =>
    session.output.play(value, { signal: new AbortController().signal });
  try {
    expect(tts.warmed).toHaveLength(1);
    await play(segment('a', 'A dynamic model answer.'));
    await play(segment('b', 'I am not sure.'));
    await play(segment('c', 'And a second model sentence.'));
    expect(tts.replies).toEqual([
      { segments: ['A dynamic model answer.', 'And a second model sentence.'], closed: false },
    ]);
    expect(tts.calls.filter((call) => call.path === 'open').map((call) => call.text)).toEqual([
      'I am not sure.',
    ]);
    await session.output.interrupt(7);
    await Promise.resolve();
    expect(tts.replies[0]!.closed).toBe(true);
  } finally {
    await session.dispose();
    await runtime.close();
  }
});
