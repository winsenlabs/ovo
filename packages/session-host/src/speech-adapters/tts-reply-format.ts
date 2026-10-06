import { createTranscoder, plan } from '@winsendotai/ovo-audio';
import {
  sameFormat,
  type AudioFormat,
  type TextToSpeech,
  type TtsReply,
} from '@winsendotai/ovo-contracts';

type NativeFor = (tts: TextToSpeech, requested: AudioFormat) => AudioFormat;

/**
 * The format adapter's half for LAT-5 reply contexts and the session-start warm-up: the provider
 * sees only its native format, and each reply segment is transcoded on its own, so its audio still
 * ends where the segment does. Absent methods stay absent, so the speech output falls back.
 */
export function adaptReplyAndWarm(
  tts: TextToSpeech,
  nativeFor: NativeFor,
): Pick<TextToSpeech, 'openReply' | 'warm'> {
  return {
    ...(tts.openReply
      ? {
          async openReply(input): Promise<TtsReply> {
            const native = nativeFor(tts, input.format);
            const reply = await tts.openReply!({ ...input, format: native });
            if (sameFormat(native, input.format)) return reply;
            return {
              close: () => reply.close(),
              segment(text, signal) {
                const audio = reply.segment(text, signal);
                return (async function* () {
                  const codec = createTranscoder(plan(native, input.format)!);
                  for await (const bytes of audio) {
                    signal.throwIfAborted();
                    const output = codec.push(bytes);
                    if (output.length) yield output;
                  }
                  const tail = codec.flush();
                  if (tail.length) yield tail;
                })();
              },
            };
          },
        }
      : {}),
    ...(tts.warm
      ? {
          async warm(input) {
            let native: AudioFormat;
            try {
              native = nativeFor(tts, input.format);
            } catch {
              // swallow-ok: a format the provider cannot reach fails on the first utterance instead.
              return;
            }
            // swallow-ok: warming is best effort by contract; the first utterance connects itself.
            await tts.warm!({ ...input, format: native }).catch(() => undefined);
          },
        }
      : {}),
  };
}
