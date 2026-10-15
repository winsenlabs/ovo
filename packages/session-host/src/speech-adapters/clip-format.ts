import { sameFormat, type AudioFormat } from '@winsendotai/ovo-contracts';
import { createTranscoder, plan } from '@winsendotai/ovo-audio';

/**
 * Converts one whole clip between two formats the host's codec graph connects (a stored 8 kHz
 * mu-law hold clip for a PCM carrier leg). The clip is returned as is when the formats match;
 * undefined when no conversion exists.
 */
export function convertClip(
  audio: Uint8Array,
  from: AudioFormat,
  to: AudioFormat,
): Uint8Array | undefined {
  if (sameFormat(from, to)) return audio;
  const route = plan(from, to);
  if (!route) return undefined;
  const codec = createTranscoder(route);
  const head = codec.push(audio);
  const tail = codec.flush();
  const joined = new Uint8Array(head.byteLength + tail.byteLength);
  joined.set(head);
  joined.set(tail, head.byteLength);
  return joined;
}
