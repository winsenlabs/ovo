import { sameFormat, type AudioEncoding, type AudioFormat } from '@winsendotai/ovo-contracts';
import { alawToPcm16, mulawToPcm16, pcm16ToAlaw, pcm16ToMulaw } from './g711.ts';
import { bytesToPcm16, pcm16ToBytes } from './pcm.ts';
import {
  PolyphaseResampler,
  RESAMPLER_RATES,
  canResample,
  type ResamplerOptions,
} from './polyphase-resampler.ts';

export type CodecStep =
  | { kind: 'decode'; from: 'mulaw' | 'alaw' }
  | { kind: 'resample'; from: number; to: number }
  | { kind: 'encode'; to: 'mulaw' | 'alaw' };

export interface CodecPlan {
  from: AudioFormat;
  to: AudioFormat;
  /** Empty when the formats are equal. */
  steps: readonly CodecStep[];
}

const ENCODINGS: readonly AudioEncoding[] = ['mulaw', 'alaw', 'pcm_s16le'];

/** decode → resample → encode, each only when needed. Undefined when the rate pair is unsupported. */
export function plan(from: AudioFormat, to: AudioFormat): CodecPlan | undefined {
  if (from.channels !== 1 || to.channels !== 1) return undefined;
  if (sameFormat(from, to)) return { from, to, steps: [] };
  if (from.sampleRate !== to.sampleRate && !canResample(from.sampleRate, to.sampleRate))
    return undefined;
  const steps: CodecStep[] = [];
  if (from.encoding !== 'pcm_s16le') steps.push({ kind: 'decode', from: from.encoding });
  if (from.sampleRate !== to.sampleRate)
    steps.push({ kind: 'resample', from: from.sampleRate, to: to.sampleRate });
  if (to.encoding !== 'pcm_s16le') steps.push({ kind: 'encode', to: to.encoding });
  return { from, to, steps };
}

/** The candidates reachable from `from`, in the candidates' order. */
export function reachable(from: AudioFormat, candidates: readonly AudioFormat[]): AudioFormat[] {
  return candidates.filter((candidate) => plan(from, candidate) !== undefined);
}

/** Every mono format reachable from `from` (the codec graph's closure). */
export function reachableFormats(from: AudioFormat): AudioFormat[] {
  const all: AudioFormat[] = [];
  for (const encoding of ENCODINGS)
    for (const sampleRate of RESAMPLER_RATES) all.push({ encoding, sampleRate, channels: 1 });
  return reachable(from, all);
}

/** The first candidate `from` can reach, preferring an identical format. */
export function firstReachable(
  from: AudioFormat,
  candidates: readonly AudioFormat[],
): AudioFormat | undefined {
  return candidates.find((c) => sameFormat(c, from)) ?? reachable(from, candidates)[0];
}

export interface Transcoder {
  readonly plan: CodecPlan;
  /** Bytes in `plan.from` → bytes in `plan.to`. Odd PCM bytes are carried to the next push. */
  push(bytes: Uint8Array): Uint8Array;
  /** Drains resampler history; a dangling odd byte is dropped. The stream then starts fresh. */
  flush(): Uint8Array;
}

function decodeTo(format: AudioFormat, bytes: Uint8Array): Int16Array {
  if (format.encoding === 'mulaw') return mulawToPcm16(bytes);
  if (format.encoding === 'alaw') return alawToPcm16(bytes);
  return bytesToPcm16(bytes);
}

function encodeFrom(format: AudioFormat, pcm: Int16Array): Uint8Array {
  if (format.encoding === 'mulaw') return pcm16ToMulaw(pcm);
  if (format.encoding === 'alaw') return pcm16ToAlaw(pcm);
  return pcm16ToBytes(pcm);
}

export function createTranscoder(codecPlan: CodecPlan, options: ResamplerOptions = {}): Transcoder {
  const { from, to } = codecPlan;
  const resample = codecPlan.steps.find((step) => step.kind === 'resample');
  const resampler = resample
    ? new PolyphaseResampler(from.sampleRate, to.sampleRate, options)
    : undefined;
  const pcmIn = from.encoding === 'pcm_s16le';
  let carry: number | undefined;

  const aligned = (bytes: Uint8Array): Uint8Array => {
    if (!pcmIn) return bytes;
    let input = bytes;
    if (carry !== undefined) {
      input = new Uint8Array(bytes.byteLength + 1);
      input[0] = carry;
      input.set(bytes, 1);
      carry = undefined;
    }
    if (input.byteLength % 2 === 1) {
      carry = input[input.byteLength - 1];
      input = input.subarray(0, input.byteLength - 1);
    }
    return input;
  };

  return {
    plan: codecPlan,
    push(bytes) {
      if (codecPlan.steps.length === 0) return bytes;
      const input = aligned(bytes);
      if (input.byteLength === 0) return new Uint8Array(0);
      const pcm = decodeTo(from, input);
      return encodeFrom(to, resampler ? resampler.push(pcm) : pcm);
    },
    flush() {
      carry = undefined;
      if (!resampler) return new Uint8Array(0);
      return encodeFrom(to, resampler.flush());
    },
  };
}
