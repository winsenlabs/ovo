import { createHash } from 'node:crypto';
import {
  MULAW_8K,
  ROUTING_AUDIO_LIMITS,
  type RoutingAudioSource,
} from '@winsendotai/ovo-contracts';
import {
  WavDecodeError,
  decodeWav,
  downmixToMono,
  pcm16ToMulaw,
  resampleClip,
} from '@winsendotai/ovo-audio';
import { encodeRecordingWav } from '@winsendotai/ovo-plugin-recordings';

/** Hold clips are stored once as 8 kHz μ-law (design 5.1): one byte per sample. */
const RATE = 8000;
const { minBytes: MIN_SAMPLES, maxBytes: MAX_SAMPLES } = ROUTING_AUDIO_LIMITS;

export interface ConvertedRoutingAudio {
  audio: Uint8Array;
  durationMs: number;
  sha256: string;
  source: RoutingAudioSource;
}

/** Why an upload was refused: 415 for a format outside the list, 422 for a malformed or out-of-bounds clip. */
export class RoutingAudioRefusal extends Error {
  constructor(
    readonly status: 415 | 422,
    readonly code: 'routing_audio_unsupported' | 'routing_audio_invalid',
    message: string,
  ) {
    super(message);
    this.name = 'RoutingAudioRefusal';
  }
}

const tooLongOrShort = () =>
  new RoutingAudioRefusal(
    422,
    'routing_audio_invalid',
    'A hold clip must be between 0.1 and 300 seconds long',
  );

/**
 * An uploaded WAV as the worker plays it: decoded strictly, downmixed to mono, resampled to 8 kHz
 * (polyphase) and G.711 μ-law encoded, with the sha256 of the stored bytes. Operator bytes are
 * never stored or sent to a carrier as they came.
 */
export function convertRoutingAudio(wav: Uint8Array): ConvertedRoutingAudio {
  let decoded;
  try {
    decoded = decodeWav(wav);
  } catch (error) {
    if (!(error instanceof WavDecodeError)) throw error;
    throw error.kind === 'unsupported'
      ? new RoutingAudioRefusal(415, 'routing_audio_unsupported', error.message)
      : new RoutingAudioRefusal(422, 'routing_audio_invalid', error.message);
  }
  // Refused before resampling, so an over-long upload costs no conversion work.
  const seconds = decoded.frames / decoded.sampleRate;
  if (seconds * RATE > MAX_SAMPLES + 1 || seconds * RATE < MIN_SAMPLES - 1) throw tooLongOrShort();
  const pcm = resampleClip(downmixToMono(decoded), decoded.sampleRate, RATE);
  if (pcm.length < MIN_SAMPLES || pcm.length > MAX_SAMPLES) throw tooLongOrShort();
  const audio = pcm16ToMulaw(pcm);
  return {
    audio,
    durationMs: Math.round((audio.byteLength * 1000) / RATE),
    sha256: createHash('sha256').update(audio).digest('hex'),
    source: {
      container: 'wav',
      encoding: decoded.encoding,
      sampleRate: decoded.sampleRate,
      channels: decoded.channels,
    },
  };
}

/** The stored clip as a WAV file for preview (8 kHz μ-law, mono). */
export function routingAudioWav(audio: Uint8Array): Uint8Array {
  return encodeRecordingWav(MULAW_8K, audio);
}
