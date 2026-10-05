import type {
  EndReason,
  MediaDuplex,
  SpeechToText,
  SttEvent,
  SttSession,
  UsageSink,
  VadAnalyzerFactory,
  VoiceEvent,
} from '@winsendotai/ovo-contracts';
import { DEFAULT_KEEP_MS, IngressBacklog, type IngressLimits } from './ingress-backlog.ts';
import { IngressVad } from './ingress-vad.ts';
import { describeError, logVoiceEvent } from './log.ts';
import { MAX_STT_RECOVERIES, SttRecovery, sttFailure } from './stt-recovery.ts';

export type { IngressLimits } from './ingress-backlog.ts';

const DEFAULT_RECONNECT_ATTEMPTS = 2;

/** Registers before STT connects, then drains owned carrier-format frames in order. */
export class VoiceIngress {
  private readonly backlog: IngressBacklog;
  private readonly unsub: () => void;
  private stt?: SttSession;
  private cancelConnect?: () => void;
  private draining?: Promise<void>;
  private disposed = false;
  private readonly vad?: IngressVad;
  private acceptedFrames = 0;
  private acceptedBytes = 0;
  private provider?: { stt: SpeechToText; language: string; usage: UsageSink };
  private readonly recovery: SttRecovery;

  constructor(
    private readonly media: MediaDuplex,
    private readonly limits: IngressLimits,
    private readonly signal: AbortSignal,
    private readonly observe: (event: VoiceEvent) => void,
    private readonly fail: (reason: EndReason) => void,
    vadFactory?: VadAnalyzerFactory,
  ) {
    const { sampleRate: rate, encoding } = media.format;
    if (vadFactory && (rate === 8000 || rate === 16000))
      this.vad = new IngressVad(media.format, vadFactory, observe);
    const bytesPerMs = (rate * (encoding === 'pcm_s16le' ? 2 : 1)) / 1000;
    this.backlog = new IngressBacklog(limits, bytesPerMs);
    this.recovery = new SttRecovery(bytesPerMs * (limits.keepMs ?? DEFAULT_KEEP_MS));
    this.unsub = media.onAudio((bytes, atMs) => this.accept(bytes, atMs));
  }

  get stats() {
    return {
      acceptedFrames: this.acceptedFrames,
      acceptedBytes: this.acceptedBytes,
      pendingFrames: this.backlog.frames,
      pendingBytes: this.backlog.bytes,
      overflows: this.backlog.overflows,
      droppedFrames: this.backlog.droppedFrames,
    };
  }

  async connect(provider: SpeechToText, language: string, usage: UsageSink): Promise<void> {
    this.provider = { stt: provider, language, usage };
    this.adopt(await this.open());
  }

  /** Disposal can land between a connect resolving and its continuation running. */
  private adopt(session: SttSession): void {
    if (this.disposed || this.signal.aborted) {
      void Promise.resolve()
        .then(() => session.cancel('engine disposed'))
        .catch(() => undefined); // swallow-ok: the session was never used.
      throw this.signal.reason ?? new DOMException('engine disposed', 'AbortError');
    }
    this.stt = session;
    this.drain();
  }

  async dispose(graceful = false): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelConnect?.();
    this.unsub();
    this.vad?.reset();
    this.backlog.clear();
    const stt = this.stt;
    if (!stt) return;
    try {
      if (graceful) await stt.finish();
      else await stt.cancel('engine disposed');
    } catch (error) {
      // The call is already ending; the provider's own close reason is only evidence.
      this.log('stt_close_failed', { graceful, error: describeError(error) });
    }
  }

  forceEndpoint(): Promise<void> {
    if (this.disposed || this.signal.aborted) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.backlog.items.push({ kind: 'endpoint', resolve, reject });
      this.drain();
    });
  }

  /** Starts one provider session, cancelling it if the engine is disposed while it connects. */
  private open(): Promise<SttSession> {
    this.signal.throwIfAborted();
    if (this.disposed) throw new DOMException('engine disposed', 'AbortError');
    const { stt, language, usage } = this.provider!;
    const generation = this.recovery.generation;
    return new Promise<SttSession>((resolve, reject) => {
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
          return stt.start({
            sessionId: this.media.sessionId,
            format: this.media.format,
            language,
            signal: this.signal,
            onEvent: (event: SttEvent) => {
              // A replaced session's late events must not reach the turn controller.
              if (this.disposed || this.signal.aborted) return;
              if (generation !== this.recovery.generation) return;
              this.observe({ type: 'stt', event: this.recovery.remap(event), atMs: Date.now() });
            },
            onUsage: usage,
          });
        })
        .then((session) => {
          if (this.disposed || this.signal.aborted) {
            void Promise.resolve()
              .then(() => session.cancel('engine disposed'))
              .catch(() => undefined); // swallow-ok: the session was never used.
            abort();
            return;
          }
          cleanup();
          resolve(session);
        })
        .catch((error: unknown) => {
          cleanup();
          reject(error);
        });
    });
  }

  private accept(bytes: Uint8Array, atMs: number): void {
    if (this.disposed || this.signal.aborted) return;
    const owned = bytes.slice();
    const dropped = this.backlog.admit(owned.length, Boolean(this.stt));
    // Only a frame larger than the whole buffer, or a queue of endpoints, cannot be admitted.
    if (!dropped) return this.fail('error:ingress_overflow');
    if (dropped.frames)
      this.log('ingress_audio_dropped', { ...dropped, keptBytes: this.backlog.bytes });
    this.backlog.push(owned);
    this.acceptedFrames++;
    this.acceptedBytes += owned.length;
    // A VAD-stop observer may synchronously request forceEndpoint. Its triggering
    // carrier bytes must already precede that endpoint in the STT queue.
    this.vad?.feed(owned, atMs);
    this.drain();
  }

  private drain(): void {
    if (this.draining || !this.stt || this.disposed) return;
    const stt = this.stt;
    this.draining = (async () => {
      while (this.backlog.items.length && this.stt === stt) {
        if (this.disposed || this.signal.aborted) break;
        const item = this.backlog.shift()!;
        if (item.kind === 'endpoint') {
          try {
            await stt.forceEndpoint?.();
            item.resolve();
          } catch (error) {
            // A reconnected session receives the endpoint after the replayed audio.
            this.backlog.items.unshift(item);
            throw error;
          }
          continue;
        }
        this.recovery.written(item.bytes);
        await stt.write(item.bytes, this.signal);
      }
    })()
      .catch((error: unknown) => this.sttFailed(stt, error))
      .finally(() => {
        this.draining = undefined;
        if (this.backlog.items.length) this.drain();
      });
  }

  /**
   * A retryable provider drop reconnects and replays the unfinalized audio; anything else ends
   * the call with `error:stt:<code>`, never an ingress overflow.
   */
  private sttFailed(failed: SttSession, error: unknown): void {
    if (this.disposed || this.signal.aborted || this.stt !== failed) return;
    const { code, retryable } = sttFailure(error);
    this.stt = undefined;
    void Promise.resolve()
      .then(() => failed.cancel('provider failed'))
      .catch(() => undefined); // swallow-ok: the failed session already closed.
    const { recoveries } = this.recovery;
    this.log('stt_session_failed', { code, retryable, recoveries, error: describeError(error) });
    if (!retryable || recoveries >= MAX_STT_RECOVERIES || !this.provider)
      return this.fail(`error:stt:${code}`);
    this.recovery.recoveries++;
    void this.reconnect(code);
  }

  private async reconnect(code: string): Promise<void> {
    const replay = this.recovery.takeUnfinalized();
    this.backlog.replay(replay);
    const attempts = this.limits.reconnectAttempts ?? DEFAULT_RECONNECT_ATTEMPTS;
    let lastCode = code;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (this.disposed || this.signal.aborted) return;
      this.recovery.next();
      const started = Date.now();
      try {
        this.adopt(await this.open());
        const elapsedMs = Date.now() - started;
        this.log('stt_reconnected', { code, attempt, elapsedMs, replayed: replay.length });
        return;
      } catch (error) {
        if (this.disposed || this.signal.aborted) return;
        const next = sttFailure(error);
        lastCode = next.code;
        this.log('stt_reconnect_failed', { attempt, code: lastCode, error: describeError(error) });
        if (!next.retryable) break;
      }
    }
    this.fail(`error:stt:${lastCode}`);
  }

  private log(event: string, fields: Record<string, unknown>): void {
    logVoiceEvent('warn', event, { sessionId: this.media.sessionId, ...fields });
  }
}
