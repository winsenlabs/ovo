import {
  MULAW_8K,
  PCM16_8K,
  PCM16_24K,
  type AudioFormat,
  type StreamingTts,
  type TextToSpeech,
  type UsageMeter,
} from '@winsendotai/ovo-contracts';
import { abortError, withDeadline, ProviderProtocolError } from '../../plugin-kit/src/index.ts';
import { adaptTextToSpeech } from '../../session-host/src/speech-adapters/tts-format.ts';
import type { NormalizedTts } from '../../plugin-speech-cache/src/types.ts';
import type { OpenAiTtsBinding } from './types.ts';

/** Transitional v1 services; the selected v2 package remains native PCM16_24K only. */
export function legacyTtsPorts(
  native: TextToSpeech,
  binding: Readonly<OpenAiTtsBinding>,
  onUsage: (meter: UsageMeter) => void,
): { streaming: StreamingTts; cached: NormalizedTts } {
  validateBinding(binding);
  const bounded: TextToSpeech = {
    capabilities: native.capabilities,
    cacheIdentity: (format, voice) => native.cacheIdentity(format, voice),
    async *synthesize(input) {
      let total = 0;
      for await (const bytes of native.synthesize(input)) {
        total += bytes.byteLength;
        if (total > binding.maxResponseBytes)
          throw new ProviderProtocolError('OpenAI TTS response exceeded the configured byte limit');
        yield bytes;
      }
    },
  };
  const adapted = adaptTextToSpeech(bounded);

  async function* render(
    text: string,
    format: AudioFormat,
    voice: string | undefined,
    sessionId: string,
    signal: AbortSignal,
    usage: (meter: UsageMeter) => void,
  ): AsyncIterable<Uint8Array> {
    if (!text || [...text].length > binding.maxInputCharacters)
      throw new TypeError(`TTS text must contain 1-${binding.maxInputCharacters} characters`);
    if (voice && voice !== binding.voice)
      throw new TypeError('TTS request voice does not match the immutable provider binding');
    const deadline = withDeadline(signal, binding.requestTimeoutMs, 'OpenAI TTS deadline exceeded');
    let total = 0;
    try {
      for await (const bytes of adapted.synthesize({
        sessionId,
        text,
        format,
        language: 'en',
        voice,
        signal: deadline.signal,
        onUsage: usage,
      })) {
        total += bytes.byteLength;
        if (total > binding.maxResponseBytes)
          throw new ProviderProtocolError(
            'Normalized TTS audio exceeded the configured byte limit',
          );
        const alignment = format.encoding === 'pcm_s16le' ? 2 : 1;
        const chunkSize = Math.max(
          alignment,
          Math.floor(binding.maxOutputChunkBytes / alignment) * alignment,
        );
        for (let offset = 0; offset < bytes.length; offset += chunkSize)
          yield bytes.slice(offset, offset + chunkSize);
      }
    } catch (error) {
      throw deadline.signal.aborted ? abortError(deadline.signal) : error;
    } finally {
      deadline.dispose();
    }
  }

  return {
    streaming: {
      synthesize(input) {
        return render(
          input.text,
          formatFor(input.codec, input.sampleRate),
          input.voice,
          input.sessionId,
          input.signal,
          onUsage,
        );
      },
    },
    cached: {
      async synthesize(request, options) {
        if (
          request.workspaceId !== binding.workspaceId ||
          request.bindingVersion !== binding.bindingVersion ||
          request.model !== binding.model ||
          request.voice !== binding.voice
        )
          throw new TypeError('TTS request does not match the immutable provider binding');
        const meters: UsageMeter[] = [];
        const chunks: Uint8Array[] = [];
        let total = 0;
        for await (const bytes of render(
          request.text,
          formatFor(request.codec, request.sampleRate),
          request.voice,
          `cached:${binding.bindingVersion}`,
          options.signal,
          (meter) => {
            meters.push(meter);
            onUsage(meter);
          },
        )) {
          total += bytes.byteLength;
          chunks.push(bytes);
        }
        const first = meters[0];
        if (!first) throw new ProviderProtocolError('OpenAI TTS returned no usage');
        const audio = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          audio.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return {
          audio,
          usage: {
            provider: first.provider,
            unit: first.unit,
            quantity: first.quantity,
            state: first.state,
            requestId: first.requestId,
          },
        };
      },
    },
  };
}

function formatFor(codec: string, sampleRate: number): AudioFormat {
  if (codec === 'audio/x-mulaw' && sampleRate === 8000) return MULAW_8K;
  if (codec === 'audio/pcm' && sampleRate === 8000) return PCM16_8K;
  if (codec === 'audio/pcm' && sampleRate === 24000) return PCM16_24K;
  throw new TypeError('Unsupported TTS codec or sample rate');
}

function validateBinding(binding: Readonly<OpenAiTtsBinding>): void {
  if (!binding.voice.trim()) throw new TypeError('voice must not be empty');
  if (binding.speed < 0.25 || binding.speed > 4)
    throw new TypeError('speed must be between 0.25 and 4');
  for (const field of [
    'requestTimeoutMs',
    'maxInputCharacters',
    'maxResponseBytes',
    'maxOutputChunkBytes',
  ] as const)
    if (!Number.isSafeInteger(binding[field]) || binding[field] < 1)
      throw new TypeError(`${field} must be a positive integer`);
}
