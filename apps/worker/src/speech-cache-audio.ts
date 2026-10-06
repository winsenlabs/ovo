import type { SynthesisInput, TextToSpeech } from '@winsendotai/ovo-contracts';

/**
 * One segment's audio through the provider's best path (TTS-4). A provider that streams text in
 * (`incrementalText` + `open`) is driven open → push → flush → close, exactly as the native output
 * drives it; turning the speech cache on must never downgrade it to one-shot `synthesize()`.
 */
export async function* segmentAudio(
  tts: TextToSpeech,
  input: SynthesisInput,
): AsyncIterable<Uint8Array> {
  if (!tts.capabilities?.incrementalText || !tts.open) {
    yield* tts.synthesize(input);
    return;
  }
  const { text, ...open } = input;
  const session = await tts.open(open);
  try {
    session.push(text);
    session.flush();
    yield* session.audio;
  } finally {
    await session.close();
  }
}

export class SpeechClipTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Cached speech exceeds ${maxBytes} bytes`);
    this.name = 'SpeechClipTooLargeError';
  }
}

/** Collects a clip under a hard byte ceiling, handing each chunk on as it arrives. */
export async function collectClip(
  audio: AsyncIterable<Uint8Array>,
  maxBytes: number,
  onChunk?: (chunk: Uint8Array) => Promise<void>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of audio) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new SpeechClipTooLargeError(maxBytes);
    chunks.push(chunk.slice());
    await onChunk?.(chunk);
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}
