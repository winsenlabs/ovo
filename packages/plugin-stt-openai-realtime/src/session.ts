import {
  bytesPerSecond,
  type Clock,
  type SpeechToText,
  type SttSession,
  type WebSocketLike,
} from '@winsendotai/ovo-contracts';
import { createLogger, decimal, syntheticRequestId, usageOnce } from '@winsendotai/ovo-plugin-kit';
import { RealtimeOutbox } from './outbox.ts';
import { OpenAiRealtimeSttError, parseMessage, retryableClose } from './protocol.ts';
import { RealtimeSegments } from './segments.ts';

const logger = createLogger({ service: 'stt-openai-realtime' });

type Start = Parameters<SpeechToText['start']>[0];
type Phase = 'opening' | 'live' | 'draining' | 'closed';

/** How long a graceful finish waits for the transcript of the trailing audio. */
export const FINISH_TIMEOUT_MS = 3_000;

/** A latch whose rejection, when nobody is waiting on it, is not reported as unhandled. */
function latch() {
  const latch = Promise.withResolvers<void>();
  // swallow-ok: the session's awaiters receive the rejection; this only marks it handled.
  latch.promise.catch(() => undefined);
  return latch;
}

/**
 * One realtime transcription session. `ready` settles on `session.created`, and the configuration
 * (`session.update`) goes out at once; the outbox holds audio until `session.updated` confirms it.
 *
 * A manual-commit session commits on `forceEndpoint`; a server-VAD one is committed by the
 * provider and reports speech start and stop. The provider sends no termination event, so a
 * graceful finish commits the trailing audio, waits for its transcript and closes the socket.
 */
export class OpenAiRealtimeSession implements SttSession {
  private readonly created = latch();
  private readonly done = latch();
  /** Settles on `session.created`; the provider's session id names the usage. */
  readonly ready = this.created.promise;
  private readonly usage;
  private readonly outbox: RealtimeOutbox;
  private readonly segments: RealtimeSegments;
  private readonly openedAt: number;
  private readonly listeners: (() => void)[] = [];
  private phase: Phase = 'opening';
  private error?: Error;
  private sessionId?: string;
  private written = 0;
  private stopDraining?: () => void;

  constructor(
    private readonly socket: WebSocketLike,
    private readonly input: Start,
    /** The `session.update` event this session is configured with. */
    private readonly configuration: string,
    private readonly clock: Clock,
    /** Distinguishes the estimated usage of each connect attempt in one call. */
    private readonly attempt = 1,
  ) {
    this.openedAt = clock.now();
    this.usage = usageOnce(input.onUsage);
    this.segments = new RealtimeSegments(input.onEvent);
    this.outbox = new RealtimeOutbox(
      input.format,
      (event) => socket.send(event),
      () =>
        this.close(
          new OpenAiRealtimeSttError('OpenAI STT session.updated never arrived', 'configure', true),
        ),
    );
    const abort = () => this.close(new DOMException('OpenAI STT session aborted', 'AbortError'));
    input.signal.addEventListener('abort', abort, { once: true });
    this.listeners.push(
      () => input.signal.removeEventListener('abort', abort),
      socket.on('message', (raw, binary) => this.received(raw, binary)),
      socket.on('close', (code, reason) => this.dropped(code, reason)),
      // After session.created a transport error is a drop the host may reconnect from.
      socket.on('error', (cause) =>
        this.close(
          this.sessionId
            ? new OpenAiRealtimeSttError(`OpenAI STT transport error: ${cause.message}`, 1006, true)
            : cause,
        ),
      ),
    );
  }

  async write(frame: Uint8Array, signal?: AbortSignal): Promise<void> {
    this.assertWritable(signal);
    if (!frame.byteLength) throw new TypeError('OpenAI STT audio frame is empty');
    this.written += frame.byteLength;
    this.outbox.write(frame);
  }

  /** The manual commit: the buffered tail is appended, then the input buffer is committed. */
  async forceEndpoint(): Promise<void> {
    this.assertWritable();
    if (this.outbox.hasAudio) this.outbox.commit();
  }

  async finish(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason;
    if (this.phase === 'live') {
      this.phase = 'draining';
      if (this.outbox.hasAudio) this.outbox.commit();
      if (this.outbox.waiting)
        this.stopDraining = this.clock.setTimeout(() => this.close(), FINISH_TIMEOUT_MS);
      else this.close();
    }
    const abort = () => this.close(new DOMException('OpenAI STT finish aborted', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await this.done.promise;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  async cancel(_reason: string): Promise<void> {
    this.close();
  }

  /** Fails a session whose handshake the provider abandoned, such as a missed deadline. */
  abandon(error: Error): void {
    this.close(error);
  }

  private assertWritable(signal?: AbortSignal): void {
    signal?.throwIfAborted();
    this.input.signal.throwIfAborted();
    // A provider close surfaces on the next write with its code, so the host can tell a
    // retryable drop from its own ingress limits.
    if (this.error) throw this.error;
    if (this.phase !== 'live') throw new Error('OpenAI STT session is no longer writable');
    if (this.socket.readyState === 1) return;
    const closing = new OpenAiRealtimeSttError('OpenAI STT socket closing', 1006, true);
    this.close(closing);
    throw closing;
  }

  private received(raw: string | Uint8Array, binary: boolean): void {
    const message = binary
      ? ({ kind: 'binary' } as const)
      : parseMessage(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    if (message.kind === 'binary')
      return this.close(new OpenAiRealtimeSttError('OpenAI STT binary event', 'protocol', false));
    if (message.kind === 'failure') return this.close(message.error);
    if (message.kind === 'error') return this.providerError(message);
    if (message.kind === 'created') return this.opened(message.sessionId);
    if (this.phase === 'opening')
      return this.close(
        new OpenAiRealtimeSttError('OpenAI STT event before session.created', 'protocol', false),
      );
    if (message.kind === 'updated') return this.outbox.configure();
    if (message.kind === 'committed') return this.segments.committed(message.itemId);
    if (message.kind === 'delta') return this.segments.delta(message.itemId, message.delta);
    if (message.kind === 'speech')
      return this.input.onEvent({
        type: message.phase === 'started' ? 'speech-start' : 'speech-end',
      });
    if (message.kind === 'completed') this.transcribed(message.itemId, message.transcript);
    if (message.kind === 'item-failed') {
      logger.warn('stt_transcription_failed', {
        sessionId: this.input.sessionId,
        detail: message.detail,
      });
      this.transcribed(message.itemId, undefined);
    }
  }

  private opened(sessionId: string): void {
    if (this.phase !== 'opening')
      return this.close(new OpenAiRealtimeSttError('duplicate session.created', 'protocol', false));
    this.sessionId = sessionId;
    this.phase = 'live';
    this.socket.send(this.configuration);
    this.created.resolve();
  }

  private transcribed(itemId: string, transcript: string | undefined): void {
    this.segments.completed(itemId, transcript);
    this.outbox.answered();
    this.drained();
  }

  /**
   * The provider keeps most sessions open after an error. One about a commit means that commit
   * gets no transcript; before the configuration is confirmed, the session cannot be used at all.
   */
  private providerError(error: { detail: string; code: string; eventId?: string }): void {
    if (!this.outbox.isConfigured)
      return this.close(
        new OpenAiRealtimeSttError(`OpenAI STT ${error.code}: ${error.detail}`, error.code, false),
      );
    logger.warn('stt_provider_error', {
      sessionId: this.input.sessionId,
      code: error.code,
      detail: error.detail,
    });
    if (this.outbox.refused(error.eventId)) this.drained();
  }

  /** A finish that was waiting on transcripts closes once none is outstanding. */
  private drained(): void {
    if (this.phase === 'draining' && !this.outbox.waiting) this.close();
  }

  private dropped(code: number, reason: string): void {
    if (this.phase === 'closed') return;
    if (this.phase === 'draining') return this.close();
    this.close(
      new OpenAiRealtimeSttError(
        `OpenAI STT closed (${code}): ${reason}`,
        code,
        retryableClose(code),
      ),
    );
  }

  /**
   * Every end goes through here exactly once: usage is emitted, listeners detach, and the socket is
   * closed (normally, unless `error`). With an error, `ready`, `finish` and later writes reject.
   */
  private close(error?: Error): void {
    if (this.phase === 'closed') return;
    const opening = this.phase === 'opening';
    this.phase = 'closed';
    this.error = error;
    this.stopDraining?.();
    this.outbox.discard();
    this.usage.emit({
      provider: 'openai',
      operation: 'stt',
      unit: 'audio_seconds',
      quantity: decimal(this.written / bytesPerSecond(this.input.format)),
      state: 'estimated',
      requestId: this.sessionId ?? syntheticRequestId('openai', this.input.sessionId, this.attempt),
      elapsedMs: Math.max(0, this.clock.now() - this.openedAt),
    });
    for (const detach of this.listeners.splice(0)) detach();
    if (error) {
      this.created.reject(error);
      this.done.reject(error);
    } else {
      if (opening) this.created.reject(new DOMException('OpenAI STT cancelled', 'AbortError'));
      this.done.resolve();
    }
    try {
      this.socket.close(error ? undefined : 1000);
    } catch {
      // swallow-ok: a socket still connecting may refuse a close; it is discarded either way.
    }
  }
}
