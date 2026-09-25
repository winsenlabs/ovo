import { isAbortError } from './async.ts';
import type { StreamingSttSession } from './provider-types.ts';
import { bound, errorMessage } from './session-engine-guards.ts';

/** Compatibility ingress for direct v1 engine callers. The v2 path uses engine/ingress. */
export class LegacySessionIngress {
  private readonly queue: Uint8Array[] = [];
  private draining?: Promise<void>;
  private disposed = false;
  private acceptedFrames = 0;
  private acceptedBytes = 0;
  private pendingFrames = 0;
  private pendingBytes = 0;
  private overflows = 0;
  private readonly maxFrames: number;
  private readonly maxBytes: number;

  constructor(
    private readonly stt: StreamingSttSession,
    private readonly signal: AbortSignal,
    private readonly fail: (reason: string) => void,
    frames?: number,
    bytes?: number,
  ) {
    this.maxFrames = bound(frames ?? 100, 1, 1_000, 'maxIngressFrames');
    this.maxBytes = bound(bytes ?? 512 * 1024, 1, 8 * 1024 * 1024, 'maxIngressBytes');
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

  accept(audio: Uint8Array): void {
    if (this.disposed || this.signal.aborted) return;
    if (
      this.pendingFrames + 1 > this.maxFrames ||
      this.pendingBytes + audio.length > this.maxBytes
    ) {
      this.overflows++;
      this.fail('STT ingress capacity exceeded');
      return;
    }
    const owned = audio.slice();
    this.queue.push(owned);
    this.acceptedFrames++;
    this.acceptedBytes += owned.length;
    this.pendingFrames++;
    this.pendingBytes += owned.length;
    this.drain();
  }

  dispose(): void {
    this.disposed = true;
    const queued = this.queue.splice(0);
    this.pendingFrames -= queued.length;
    this.pendingBytes -= queued.reduce((total, audio) => total + audio.length, 0);
  }

  private drain(): void {
    if (this.draining || !this.queue.length || this.disposed) return;
    this.draining = (async () => {
      while (this.queue.length && !this.signal.aborted) {
        const audio = this.queue.shift()!;
        try {
          await this.stt.write(audio, this.signal);
        } finally {
          this.pendingFrames--;
          this.pendingBytes -= audio.length;
        }
      }
    })()
      .catch((error) => {
        if (!this.signal.aborted && !isAbortError(error))
          this.fail('STT input failed: ' + errorMessage(error));
      })
      .finally(() => {
        this.draining = undefined;
        if (this.queue.length && !this.disposed) this.drain();
      });
  }
}
