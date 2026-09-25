import type {
  MediaDuplex,
  SpeechToText,
  SttEvent,
  SttSession,
  UsageSink,
  VadAnalyzerFactory,
  VoiceEvent,
} from '@winsendotai/ovo-contracts';
import { mulawToPcm16 } from '../../../audio/src/g711.ts';

export interface IngressLimits {
  maxFrames: number;
  maxBytes: number;
  preSttBufferMs: number;
}

/** Registers before STT connects, then drains owned carrier-format frames in order. */
export class VoiceIngress {
  private readonly queued: Uint8Array[] = [];
  private readonly unsub: () => void;
  private stt?: SttSession;
  private draining?: Promise<void>;
  private disposed = false;
  private preSttBytes = 0;
  private vadActive = false;
  private acceptedFrames = 0;
  private acceptedBytes = 0;
  private pendingBytes = 0;
  private overflows = 0;

  constructor(
    private readonly media: MediaDuplex,
    private readonly limits: IngressLimits,
    private readonly signal: AbortSignal,
    private readonly observe: (event: VoiceEvent) => void,
    private readonly fail: () => void,
    private readonly vadFactory?: VadAnalyzerFactory,
  ) {
    this.unsub = media.onAudio((bytes, atMs) => this.accept(bytes, atMs));
  }

  get stats() {
    return {
      acceptedFrames: this.acceptedFrames,
      acceptedBytes: this.acceptedBytes,
      pendingFrames: this.queued.length,
      pendingBytes: this.pendingBytes,
      overflows: this.overflows,
    };
  }

  async connect(provider: SpeechToText, language: string, usage: UsageSink): Promise<void> {
    this.stt = await provider.start({
      sessionId: this.media.sessionId,
      format: this.media.format,
      language,
      signal: this.signal,
      onEvent: (event: SttEvent) => this.observe({ type: 'stt', event, atMs: Date.now() }),
      onUsage: usage,
    });
    this.drain();
  }

  async dispose(graceful = false): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsub();
    this.queued.length = 0;
    this.pendingBytes = 0;
    if (graceful) await this.stt?.finish().catch(() => undefined);
    else await this.stt?.cancel('engine disposed').catch(() => undefined);
  }

  forceEndpoint(): Promise<void> {
    return this.stt?.forceEndpoint?.() ?? Promise.resolve();
  }

  private accept(bytes: Uint8Array, atMs: number): void {
    if (this.disposed || this.signal.aborted) return;
    this.feedVad(bytes, atMs);
    const owned = bytes.slice();
    const preLimit =
      (this.media.format.sampleRate *
        this.limits.preSttBufferMs *
        (this.media.format.encoding === 'pcm_s16le' ? 2 : 1)) /
      1000;
    if (
      this.queued.length + 1 > this.limits.maxFrames ||
      this.pendingBytes + owned.length > this.limits.maxBytes ||
      (!this.stt && this.preSttBytes + owned.length > preLimit)
    ) {
      this.overflows++;
      this.fail();
      return;
    }
    this.queued.push(owned);
    this.acceptedFrames++;
    this.acceptedBytes += owned.length;
    this.pendingBytes += owned.length;
    if (!this.stt) this.preSttBytes += owned.length;
    else this.drain();
  }

  private drain(): void {
    if (this.draining || !this.stt || this.disposed) return;
    this.draining = (async () => {
      while (this.queued.length && !this.disposed && !this.signal.aborted) {
        const frame = this.queued.shift()!;
        try {
          await this.stt!.write(frame, this.signal);
        } finally {
          this.pendingBytes -= frame.length;
        }
      }
    })()
      .catch(() => this.fail())
      .finally(() => {
        this.draining = undefined;
        if (this.queued.length) this.drain();
      });
  }

  private feedVad(bytes: Uint8Array, atMs: number): void {
    if (!this.vadFactory) return;
    const rate = this.media.format.sampleRate;
    if (rate !== 8000 && rate !== 16000) return;
    const vad = (this.vad ??= this.vadFactory.create(rate));
    const samples = decodeForVad(bytes, this.media.format.encoding);
    const active =
      vad.confidence(samples) >= this.vadFactory.params.confidence &&
      vad.volume(samples) >= this.vadFactory.params.minVolume;
    if (active === this.vadActive) return;
    this.vadActive = active;
    this.observe({ type: active ? 'vad.start' : 'vad.stop', atMs });
  }

  private vad?: ReturnType<VadAnalyzerFactory['create']>;
}

/** Only the VAD copy is decoded. STT receives original carrier bytes. */
function decodeForVad(bytes: Uint8Array, encoding: string): Int16Array {
  if (encoding === 'pcm_s16le') {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const pcm = new Int16Array(Math.floor(bytes.length / 2));
    for (let i = 0; i < pcm.length; i++) pcm[i] = view.getInt16(i * 2, true);
    return pcm;
  }
  return mulawToPcm16(bytes);
}
