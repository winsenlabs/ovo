import type { AudioFilter, AudioFormat, MediaDuplex } from '@winsendotai/ovo-contracts';
import {
  alawToPcm16,
  bytesToPcm16,
  mulawToPcm16,
  pcm16ToAlaw,
  pcm16ToBytes,
  pcm16ToMulaw,
} from '@winsendotai/ovo-audio';

/**
 * Runs the selected `ovo.audio-filter` (rumble, hum, steady noise) over caller audio in its
 * carrier encoding, before the VAD and the STT hear it. No buffering: a split PCM sample's odd
 * byte waits for the next frame, nothing else does.
 */
export class IngressFilter {
  private odd?: number;

  constructor(
    private readonly format: AudioFormat,
    private readonly filter: AudioFilter,
  ) {
    filter.start(format.sampleRate);
  }

  apply(bytes: Uint8Array): Uint8Array {
    if (this.format.encoding === 'mulaw')
      return pcm16ToMulaw(this.filter.filter(mulawToPcm16(bytes)));
    if (this.format.encoding === 'alaw') return pcm16ToAlaw(this.filter.filter(alawToPcm16(bytes)));
    const joined = this.odd === undefined ? bytes : Uint8Array.of(this.odd, ...bytes);
    const even = joined.length & ~1;
    this.odd = even < joined.length ? joined[even] : undefined;
    return pcm16ToBytes(this.filter.filter(bytesToPcm16(joined.subarray(0, even))));
  }

  stop(): void {
    this.filter.stop();
  }
}

type AudioListener = (bytes: Uint8Array, tsMs: number) => void;

/**
 * `media` whose caller audio passes through `filter` first, once per frame however many listen;
 * everything else is the carrier's own. The filter stops when the call closes. Without a filter
 * the media is returned as is.
 */
export function filteredMedia(media: MediaDuplex, filter?: AudioFilter): MediaDuplex {
  if (!filter) return media;
  const ingress = new IngressFilter(media.format, filter);
  const listeners = new Set<AudioListener>();
  let unsubscribe: (() => void) | undefined;
  media.onClose(() => ingress.stop());
  const onAudio = (listener: AudioListener) => {
    listeners.add(listener);
    unsubscribe ??= media.onAudio((bytes, tsMs) => {
      const clean = ingress.apply(bytes);
      for (const each of listeners) each(clean, tsMs);
    });
    return () => {
      listeners.delete(listener);
      if (listeners.size) return;
      unsubscribe?.();
      unsubscribe = undefined;
    };
  };
  return new Proxy(media, {
    get(target, key) {
      if (key === 'onAudio') return onAudio;
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
