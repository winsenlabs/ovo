import { describe, expect, it } from 'vitest';
import type { AudioFormat, TextToSpeech } from '@winsendotai/ovo-contracts';
import { adaptReplyAndWarm } from '../src/speech-adapters/tts-reply-format.ts';

const MULAW: AudioFormat = { encoding: 'mulaw', sampleRate: 8000, channels: 1 };
const PCM: AudioFormat = { encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 };

function tts(extra: Partial<TextToSpeech>): TextToSpeech {
  return {
    capabilities: {
      outputFormats: [PCM],
      languages: ['*'],
      interim: false,
      wordTimestamps: false,
      turnSignals: [],
      forceEndpoint: false,
      incrementalText: true,
    },
    cacheIdentity: () => ({ provider: 'p', model: 'm', voice: 'v', revision: '1' }),
    // swallow-ok: never called here.
    async *synthesize() {},
    ...extra,
  };
}

const input = {
  sessionId: 's',
  format: MULAW,
  language: 'en-IN',
  signal: new AbortController().signal,
  onUsage: () => undefined,
};
/** 60 ms of a 440 Hz tone at 24 kHz. */
const tone = () => {
  const bytes = new Uint8Array(60 * 24 * 2);
  const view = new DataView(bytes.buffer);
  for (let sample = 0; sample < bytes.length / 2; sample += 1)
    view.setInt16(
      sample * 2,
      Math.round(5000 * Math.sin((2 * Math.PI * 440 * sample) / 24000)),
      true,
    );
  return bytes;
};

describe('format adapter for reply contexts and warm-up', () => {
  it('opens the reply in the native format and transcodes each segment on its own', async () => {
    const formats: AudioFormat[] = [];
    let closed = false;
    const adapted = adaptReplyAndWarm(
      tts({
        async openReply(open) {
          formats.push(open.format);
          return {
            segment: () =>
              (async function* () {
                yield tone();
              })(),
            close: async () => void (closed = true),
          };
        },
      }),
      () => PCM,
    );
    const reply = await adapted.openReply!(input);
    for (const text of ['One.', 'Two.']) {
      let bytes = 0;
      for await (const chunk of reply.segment(text, new AbortController().signal))
        bytes += chunk.length;
      // 60 ms of μ-law 8 kHz is 480 bytes, give or take the resampler's edges.
      expect(bytes).toBeGreaterThanOrEqual(460);
      expect(bytes).toBeLessThanOrEqual(550);
    }
    await reply.close();
    expect(formats).toEqual([PCM]);
    expect(closed).toBe(true);
  });

  it('warms in the native format and never rejects', async () => {
    const warmed: AudioFormat[] = [];
    const adapted = adaptReplyAndWarm(
      tts({
        async warm(request) {
          warmed.push(request.format);
          throw new Error('handshake refused');
        },
      }),
      () => PCM,
    );
    await expect(adapted.warm!({ format: MULAW })).resolves.toBeUndefined();
    expect(warmed).toEqual([PCM]);
    const unreachable = adaptReplyAndWarm(tts({ warm: async () => undefined }), () => {
      throw new Error('No reachable native TTS format');
    });
    await expect(unreachable.warm!({ format: MULAW })).resolves.toBeUndefined();
  });

  it('adds nothing for a provider without either method', () => {
    expect(adaptReplyAndWarm(tts({}), () => PCM)).toEqual({});
  });
});
