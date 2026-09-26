import type {
  AudioFormat,
  VadAnalyzer,
  VadAnalyzerFactory,
  VoiceEvent,
} from '@winsendotai/ovo-contracts';
import { alawToPcm16, mulawToPcm16 } from '../../../audio/src/g711.ts';

/** Owns only the VAD copy; carrier bytes, including split PCM samples, keep their STT boundaries. */
export class IngressVad {
  private readonly analyzer: VadAnalyzer;
  private readonly frame: Uint8Array;
  private readonly bytesPerMs: number;
  private readonly startFrames: number;
  private readonly stopFrames: number;
  private buffered = 0;
  private frameAtMs = 0;
  private active = false;
  private consecutive = 0;

  constructor(
    private readonly format: AudioFormat,
    private readonly factory: VadAnalyzerFactory,
    private readonly observe: (event: VoiceEvent) => void,
  ) {
    const rate = format.sampleRate;
    if (rate !== 8000 && rate !== 16000) throw new RangeError('unsupported VAD sample rate');
    this.analyzer = factory.create(rate);
    if (
      this.analyzer.sampleRate !== rate ||
      !Number.isInteger(this.analyzer.frameSamples) ||
      this.analyzer.frameSamples < 1
    )
      throw new RangeError('invalid VAD analyzer frame format');
    const bytesPerSample = format.encoding === 'pcm_s16le' ? 2 : 1;
    this.frame = new Uint8Array(this.analyzer.frameSamples * bytesPerSample);
    this.bytesPerMs = (rate * bytesPerSample) / 1000;
    const frameMs = (this.analyzer.frameSamples * 1000) / rate;
    this.startFrames = Math.max(1, Math.round(factory.params.startMs / frameMs));
    this.stopFrames = Math.max(1, Math.round(factory.params.stopMs / frameMs));
  }

  feed(bytes: Uint8Array, atMs: number): void {
    let offset = 0;
    while (offset < bytes.length) {
      if (!this.buffered) this.frameAtMs = atMs + offset / this.bytesPerMs;
      const length = Math.min(bytes.length - offset, this.frame.length - this.buffered);
      this.frame.set(bytes.subarray(offset, offset + length), this.buffered);
      this.buffered += length;
      offset += length;
      if (this.buffered === this.frame.length) {
        this.analyze();
        this.buffered = 0;
      }
    }
  }

  reset(): void {
    this.buffered = 0;
    this.consecutive = 0;
    this.active = false;
    this.analyzer.reset();
  }

  private analyze(): void {
    const pcm = decode(this.frame, this.format.encoding);
    const confidence = this.analyzer.confidence(pcm);
    const volume = this.analyzer.volume(pcm);
    const candidate =
      confidence >= this.factory.params.confidence && volume >= this.factory.params.minVolume;
    if (candidate === this.active) {
      this.consecutive = 0;
      return;
    }
    if (++this.consecutive < (candidate ? this.startFrames : this.stopFrames)) return;
    this.active = candidate;
    this.consecutive = 0;
    this.observe({ type: candidate ? 'vad.start' : 'vad.stop', atMs: this.frameAtMs });
  }
}

function decode(bytes: Uint8Array, encoding: AudioFormat['encoding']): Int16Array {
  if (encoding === 'mulaw') return mulawToPcm16(bytes);
  if (encoding === 'alaw') return alawToPcm16(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pcm = new Int16Array(bytes.length / 2);
  for (let index = 0; index < pcm.length; index++) pcm[index] = view.getInt16(index * 2, true);
  return pcm;
}
