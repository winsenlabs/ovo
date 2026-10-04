import { sameFormat, type AudioFormat, type TextToSpeech } from '@winsendotai/ovo-contracts';
import { createTranscoder, plan } from '@winsendotai/ovo-audio';

function nativeFor(tts: TextToSpeech, requested: AudioFormat): AudioFormat {
  const formats = tts.capabilities.outputFormats ?? [];
  const identical = formats.find((format) => sameFormat(format, requested));
  const native = identical ?? formats.find((format) => plan(format, requested));
  if (!native) throw new Error('No reachable native TTS format');
  return native;
}

/** Host-side format adaptation; provider plugins see only their declared native formats. */
export function adaptTextToSpeech(tts: TextToSpeech): TextToSpeech {
  const wrapped: TextToSpeech = {
    capabilities: tts.capabilities,
    cacheIdentity: (format, voice) => tts.cacheIdentity(format, voice),
    async *synthesize(input) {
      const native = nativeFor(tts, input.format);
      const codec = sameFormat(native, input.format)
        ? undefined
        : createTranscoder(plan(native, input.format)!);
      for await (const bytes of tts.synthesize({ ...input, format: native })) {
        input.signal.throwIfAborted();
        const output = codec ? codec.push(bytes) : bytes;
        if (output.length) yield output;
      }
      const tail = codec?.flush();
      if (tail?.length) yield tail;
    },
    ...(tts.open
      ? {
          async open(input) {
            const native = nativeFor(tts, input.format);
            const session = await tts.open!({ ...input, format: native });
            if (sameFormat(native, input.format)) return session;
            const codec = createTranscoder(plan(native, input.format)!);
            return {
              push: (text: string) => session.push(text),
              flush: () => session.flush(),
              close: () => session.close(),
              audio: (async function* () {
                for await (const bytes of session.audio) {
                  input.signal.throwIfAborted();
                  const output = codec.push(bytes);
                  if (output.length) yield output;
                }
                const tail = codec.flush();
                if (tail.length) yield tail;
              })(),
            };
          },
        }
      : {}),
  };
  return wrapped;
}
