import { concatBytes, createTranscoder, plan } from '@winsendotai/ovo-audio';
import { MULAW_8K, type AudioFormat } from '@winsendotai/ovo-contracts';

/** Converts captured fixture carrier frames to the durable recording service's 8 kHz μ-law. */
export function fixtureTrackToMulaw(from: AudioFormat, chunks: readonly Uint8Array[]): Uint8Array {
  const codec = plan(from, MULAW_8K);
  if (!codec)
    throw new Error(
      `fixture_unavailable: recording cannot convert ${from.encoding}@${from.sampleRate}`,
    );
  const transcoder = createTranscoder(codec);
  return concatBytes([...chunks.map((chunk) => transcoder.push(chunk)), transcoder.flush()]);
}
