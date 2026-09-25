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

type QueuedIngress =
  | { kind: 'audio'; bytes: Uint8Array }
  | { kind: 'endpoint'; resolve: () => void; reject: (reason: unknown) => void };

/** Registers before STT connects, then drains owned carrier-format frames in order. */
export class VoiceIngress {
  private readonly queued: QueuedIngress[] = [];
  private readonly unsub: () => void;
  private stt?: SttSession;
  private draining?: Promise<void>;
  private disposed = false;
  private preSttBytes = 0;
  private vadActive = false;
  private acceptedFrames = 0;
  private acceptedBytes = 0;
  private pendingBytes = 0;
  private pendingFrames = 0;
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
      pendingFrames: this.pendingFrames,
      pendingBytes: this.pendingBytes,
      overflows: this.overflows,
    };
  }

  async connect(provider: SpeechToText, language: string, usage: UsageSink): Promise<void> {
    const session = await provider.start({
      sessionId: this.media.sessionId,
      format: this.media.format,
      language,
      signal: this.signal,
      onEvent: (event: SttEvent) => this.observe({ type: 'stt', event, atMs: Date.now() }),
      onUsage: usage,
    });
    if (this.disposed || this.signal.aborted) {
      await session.cancel('engine disposed').catch(() => undefined);
      return;
    }
    this.stt = session;
    this.drain();
  }

  async dispose(graceful = false): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsub();
    for (const item of this.queued) if (item.kind === 'endpoint') item.resolve();
    this.queued.length = 0;
    this.pendingBytes = 0;
    this.pendingFrames = 0;
    if (graceful) await this.stt?.finish().catch(() => undefined);
    else await this.stt?.cancel('engine disposed').catch(() => undefined);
  }

  forceEndpoint(): Promise<void> {
    if (this.disposed || this.signal.aborted) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.queued.push({ kind: 'endpoint', resolve, reject });
      this.drain();
    });
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
      this.pendingFrames + 1 > this.limits.maxFrames ||
      this.pendingBytes + owned.length > this.limits.maxBytes ||
      (!this.stt && this.preSttBytes + owned.length > preLimit)
    ) {
      this.overflows++;
      this.fail();
      return;
    }
    this.queued.push({ kind: 'audio', bytes: owned });
    this.acceptedFrames++;
    this.acceptedBytes += owned.length;
    this.pendingBytes += owned.length;
    this.pendingFrames++;
    if (!this.stt) this.preSttBytes += owned.length;
    else this.drain();
  }

  private drain(): void {
    if (this.draining || !this.stt || this.disposed) return;
    this.draining = (async () => {
      while (this.queued.length && !this.disposed && !this.signal.aborted) {
        const item = this.queued.shift()!;
        if (item.kind === 'endpoint') {
          try {
            await this.stt!.forceEndpoint?.();
            item.resolve();
          } catch (error) {
            item.reject(error);
            throw error;
          }
          continue;
        }
        const frame = item.bytes;
        this.pendingFrames--;
        try {
          await this.stt!.write(frame, this.signal);
        } finally {
          this.pendingBytes = Math.max(0, this.pendingBytes - frame.length);
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
