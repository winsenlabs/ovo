import {
  sameFormat,
  type AudioFormat,
  type SpeechToText,
  type SttSession,
} from '@winsendotai/ovo-contracts';
import { FrameAggregator, createTranscoder, plan } from '@winsendotai/ovo-audio';

function nativeFor(stt: SpeechToText, source: AudioFormat): AudioFormat {
  const formats = stt.capabilities.inputFormats ?? [];
  const identical = formats.find((format) => sameFormat(format, source));
  const native = identical ?? formats.find((format) => plan(source, format));
  if (!native) throw new Error('No reachable native STT format');
  return native;
}

/** Host-side format and frame adaptation; one stateful transcoder per STT session. */
export function adaptSpeechToText(stt: SpeechToText): SpeechToText {
  return {
    capabilities: stt.capabilities,
    async start(input) {
      const native = nativeFor(stt, input.format);
      const codec = sameFormat(input.format, native)
        ? undefined
        : createTranscoder(plan(input.format, native)!);
      const frameMs = stt.capabilities.frameMs;
      const aggregator = frameMs ? new FrameAggregator(native, frameMs.preferred) : undefined;
      const session = await stt.start({ ...input, format: native });
      let closed = false;
      const emit = async (bytes: Uint8Array, signal?: AbortSignal) => {
        const converted = codec ? codec.push(bytes) : bytes;
        for (const frame of aggregator ? aggregator.push(converted) : [converted])
          if (frame.length) await session.write(frame, signal);
      };
      const drain = async (signal?: AbortSignal) => {
        const tail = codec?.flush();
        if (tail?.length)
          for (const frame of aggregator ? aggregator.push(tail) : [tail])
            if (frame.length) await session.write(frame, signal);
        const last = aggregator?.flush({ padToMs: frameMs?.min });
        if (last?.length) await session.write(last, signal);
      };
      const adapted: SttSession = {
        async write(bytes, signal) {
          if (closed) throw new Error('STT session is closed');
          await emit(bytes, signal);
        },
        async forceEndpoint() {
          if (closed) throw new Error('STT session is closed');
          const last = aggregator?.flush({ padToMs: frameMs?.min });
          if (last?.length) await session.write(last);
          await session.forceEndpoint?.();
        },
        async finish(signal) {
          if (closed) return;
          closed = true;
          await drain(signal);
          await session.finish(signal);
        },
        async cancel(reason) {
          if (closed) return;
          closed = true;
          aggregator?.reset();
          await session.cancel(reason);
        },
      };
      return adapted;
    },
  };
}
