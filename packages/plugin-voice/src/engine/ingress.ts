import type {
  MediaDuplex,
  SpeechToText,
  SttEvent,
  SttSession,
  UsageSink,
  VadAnalyzerFactory,
  VoiceEvent,
} from '@winsendotai/ovo-contracts';
import { IngressVad } from './ingress-vad.ts';

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
  private cancelConnect?: () => void;
  private draining?: Promise<void>;
  private disposed = false;
  private preSttBytes = 0;
  private readonly vad?: IngressVad;
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
    vadFactory?: VadAnalyzerFactory,
  ) {
    const rate = media.format.sampleRate;
    if (vadFactory && (rate === 8000 || rate === 16000))
      this.vad = new IngressVad(media.format, vadFactory, observe);
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
    this.signal.throwIfAborted();
    if (this.disposed) throw new DOMException('engine disposed', 'AbortError');
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.signal.removeEventListener('abort', abort);
        if (this.cancelConnect === abort) this.cancelConnect = undefined;
      };
      const abort = () => {
        cleanup();
        reject(this.signal.reason ?? new DOMException('engine disposed', 'AbortError'));
      };
      this.cancelConnect = abort;
      this.signal.addEventListener('abort', abort, { once: true });
      void Promise.resolve()
        .then(() => {
          if (this.disposed || this.signal.aborted)
            throw this.signal.reason ?? new DOMException('engine disposed', 'AbortError');
          return provider.start({
            sessionId: this.media.sessionId,
            format: this.media.format,
            language,
            signal: this.signal,
            onEvent: (event: SttEvent) => {
              if (!this.disposed && !this.signal.aborted)
                this.observe({ type: 'stt', event, atMs: Date.now() });
            },
            onUsage: usage,
          });
        })
        .then((session) => {
          if (this.disposed || this.signal.aborted) {
            void Promise.resolve()
              .then(() => session.cancel('engine disposed'))
              .catch(() => undefined);
            abort();
            return;
          }
          this.stt = session;
          this.drain();
          cleanup();
          resolve();
        })
        .catch((error: unknown) => {
          cleanup();
          reject(error);
        });
    });
  }

  async dispose(graceful = false): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelConnect?.();
    this.unsub();
    this.vad?.reset();
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
    // A VAD-stop observer may synchronously request forceEndpoint. Its triggering
    // carrier bytes must already precede that endpoint in the STT queue.
    this.vad?.feed(owned, atMs);
    this.drain();
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
}
