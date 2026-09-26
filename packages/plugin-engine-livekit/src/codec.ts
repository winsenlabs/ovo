import { AudioFrame } from '@livekit/rtc-node';
import { bytesToPcm16, pcm16ToBytes, mulawToPcm16, pcm16ToMulaw } from '@winsendotai/ovo-audio';
import type { AudioFormat } from '@winsendotai/ovo-contracts';

export function assertFormat(format: AudioFormat): void {
  if (
    format.sampleRate !== 8000 ||
    format.channels !== 1 ||
    !['mulaw', 'pcm_s16le'].includes(format.encoding)
  )
    throw new Error('LiveKit requires host-adapted mono 8 kHz mulaw or PCM16');
}
export function encode(frame: AudioFrame, format: AudioFormat): Uint8Array {
  assertFormat(format);
  if (frame.sampleRate !== 8000 || frame.channels !== 1)
    throw new Error('Unexpected LiveKit audio format');
  return format.encoding === 'mulaw' ? pcm16ToMulaw(frame.data) : pcm16ToBytes(frame.data);
}
/** Reframes only the LiveKit boundary; preserves partial PCM samples between carrier chunks. */
export class FrameDecoder {
  private pending = new Uint8Array();
  constructor(private readonly format: AudioFormat) {
    assertFormat(format);
  }
  push(bytes: Uint8Array, segmentId?: string): AudioFrame[] {
    const next = new Uint8Array(this.pending.length + bytes.length);
    next.set(this.pending);
    next.set(bytes, this.pending.length);
    const size = this.format.encoding === 'mulaw' ? 160 : 320;
    const frames: AudioFrame[] = [];
    let offset = 0;
    for (; offset + size <= next.length; offset += size)
      frames.push(this.frame(next.slice(offset, offset + size), segmentId));
    this.pending = next.slice(offset);
    return frames;
  }
  finish(segmentId?: string): AudioFrame[] {
    if (!this.pending.length) return [];
    if (this.format.encoding === 'pcm_s16le' && this.pending.length % 2)
      throw new Error('Truncated PCM16 sample');
    const frame = this.frame(this.pending, segmentId);
    this.pending = new Uint8Array();
    return [frame];
  }
  private frame(bytes: Uint8Array, segmentId?: string): AudioFrame {
    const pcm = this.format.encoding === 'mulaw' ? mulawToPcm16(bytes) : bytesToPcm16(bytes);
    return new AudioFrame(pcm, 8000, 1, pcm.length, segmentId ? { segmentId } : undefined);
  }
}
