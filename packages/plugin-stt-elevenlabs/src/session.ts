import { FrameAggregator, silence } from '@winsendotai/ovo-audio';
import {
  bytesPerSecond,
  type Clock,
  type SpeechToText,
  type SttSession,
  type WebSocketLike,
} from '@winsendotai/ovo-contracts';
import { createLogger, decimal, syntheticRequestId, usageOnce } from '@winsendotai/ovo-plugin-kit';
import { deferred, onAbort } from './lifecycle.ts';
import { ElevenLabsSttError, audioChunk, parseMessage, retryableClose } from './protocol.ts';
import { ScribeSegments } from './segments.ts';

const logger = createLogger({ service: 'stt-elevenlabs' });

type Start = Parameters<SpeechToText['start']>[0];

/** Audio is sent in chunks of this length; a commit flushes whatever is buffered at once. */
const CHUNK_MS = 50;
/** The shortest chunk a commit carries; an empty remainder is sent as this much silence. */
const COMMIT_PAD_MS = 20;
/** How long a graceful finish waits for the committed transcript of the trailing audio. */
export const FINISH_TIMEOUT_MS = 3_000;

/**
 * One Scribe v2 realtime session; ScribeSegments maps its transcripts to segments. The provider
 * sends no termination frame, so a graceful finish commits the trailing audio, waits for its
 * transcript and closes the socket itself.
 *
 * It has no `updateConfiguration` (STT-4): the only client message is `input_audio_chunk`, and
 * VAD and commit settings are fixed by the connect query
 * (https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime,
 * retrieved 2026-10-06). The engine reports such a provider as not reconfigurable.
 *
 * The same reference documents no idle limit for a session that receives no audio (unverified
 * against a live socket), so the worker does not open one while an outbound call rings (STT-7).
 */
export class ScribeSession implements SttSession {
  private readonly started = deferred();
  private readonly closed = deferred();
  readonly ready = this.started.promise;
  private readonly once;
  private readonly detach: Array<() => void>;
  private readonly frames: FrameAggregator;
  private readonly segments: ScribeSegments;
  private readonly startedAt: number;
  private state: 'connecting' | 'active' | 'finishing' | 'ended' = 'connecting';
  private failure?: Error;
  private providerId?: string;
  private bytes = 0;
  /** Audio written since the last commit, so a commit without new audio is never sent. */
  private uncommitted = false;
  private pendingCommits = 0;
  private cancelFinish?: () => void;

  constructor(
    private readonly socket: WebSocketLike,
    private readonly input: Start,
    private readonly clock: Clock,
    /** Distinguishes the estimated usage of each connect attempt or reconnect in one call. */
    private readonly attempt = 1,
  ) {
    this.startedAt = clock.now();
    this.once = usageOnce(input.onUsage);
    this.frames = new FrameAggregator(input.format, CHUNK_MS);
    this.segments = new ScribeSegments(input.onEvent, () => clock.now());
    this.detach = [
      socket.on('message', (raw, binary) => this.message(raw, binary)),
      socket.on('close', (code, reason) => this.onClose(code, reason)),
      // After session_started a transport error is a drop; during the handshake the connect
      // retry already handles it.
      socket.on('error', (error) =>
        this.fail(
          this.providerId
            ? new ElevenLabsSttError(`ElevenLabs STT transport error: ${error.message}`, 1006, true)
            : error,
        ),
      ),
      onAbort(input.signal, () =>
        this.fail(new DOMException('ElevenLabs STT session aborted', 'AbortError')),
      ),
    ];
  }

  async write(frame: Uint8Array, signal?: AbortSignal): Promise<void> {
    this.writable(signal);
    if (!frame.byteLength) throw new TypeError('ElevenLabs STT audio frame is empty');
    this.bytes += frame.byteLength;
    this.uncommitted = true;
    for (const chunk of this.frames.push(frame)) this.send(chunk, false);
  }

  /** The manual commit: buffered audio goes out with `commit: true`. */
  async forceEndpoint(): Promise<void> {
    this.writable();
    if (this.uncommitted) this.commit();
  }

  async finish(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason;
    if (this.state === 'active') {
      this.state = 'finishing';
      if (this.uncommitted) this.commit();
      if (!this.pendingCommits) this.end();
      else this.cancelFinish = this.clock.setTimeout(() => this.end(), FINISH_TIMEOUT_MS);
    }
    const off =
      signal &&
      onAbort(signal, () =>
        this.fail(new DOMException('ElevenLabs STT finish aborted', 'AbortError')),
      );
    try {
      await this.closed.promise;
    } finally {
      off?.();
    }
  }

  async cancel(_reason: string): Promise<void> {
    this.end();
  }

  /** Fails a session whose handshake the provider abandoned, such as a missed deadline. */
  abandon(error: Error): void {
    this.fail(error);
  }

  private commit(): void {
    const tail =
      this.frames.flush({ padToMs: COMMIT_PAD_MS }) ?? silence(this.input.format, COMMIT_PAD_MS);
    this.send(tail, true);
    this.uncommitted = false;
    this.pendingCommits++;
  }

  private send(audio: Uint8Array, commit: boolean): void {
    this.socket.send(audioChunk(audio, this.input.format.sampleRate, commit));
  }

  private writable(signal?: AbortSignal): void {
    signal?.throwIfAborted();
    this.input.signal.throwIfAborted();
    // A provider close surfaces on the next write with its code, so the host can tell a
    // retryable drop from its own ingress limits.
    if (this.failure) throw this.failure;
    if (this.state !== 'active') throw new Error('ElevenLabs STT session is no longer writable');
    if (this.socket.readyState !== 1) {
      // `ws` reports CLOSING before it emits 'close' with the code; a write in that window is a
      // provider drop the host may reconnect from.
      const error = new ElevenLabsSttError('ElevenLabs STT socket closing', 1006, true);
      this.fail(error);
      throw error;
    }
  }

  private message(raw: string | Uint8Array, binary: boolean): void {
    if (binary)
      return this.fail(new ElevenLabsSttError('ElevenLabs STT binary response', 'protocol', false));
    const message = parseMessage(String(raw));
    if (message.kind === 'failure') return this.fail(message.error);
    if (message.kind === 'started') {
      if (this.state !== 'connecting')
        return this.fail(new ElevenLabsSttError('duplicate session_started', 'protocol', false));
      this.providerId = message.sessionId;
      this.state = 'active';
      this.started.resolve();
      return;
    }
    if (this.state === 'connecting')
      return this.fail(
        new ElevenLabsSttError('ElevenLabs STT message before session_started', 'protocol', false),
      );
    if (message.kind === 'notice') this.notice(message.type, message.detail);
    else if (message.kind === 'partial') this.segments.onPartial(message.text);
    else if (message.kind === 'committed') this.onCommitted(message.text);
    else if (message.kind === 'language')
      logger.info('stt_language_detected', {
        sessionId: this.input.sessionId,
        language: message.language,
        expected: this.input.language,
      });
  }

  private notice(type: string, detail: string): void {
    logger.warn('stt_provider_notice', { sessionId: this.input.sessionId, type, detail });
    if (type !== 'commit_throttled') return;
    // The refused audio is still uncommitted. It gets no transcript, so a finish must not wait
    // out its deadline for one.
    this.uncommitted = true;
    this.segments.onThrottled();
    this.answered();
  }

  private onCommitted(text: string): void {
    this.segments.onCommitted(text);
    this.answered();
  }

  private answered(): void {
    this.pendingCommits = Math.max(0, this.pendingCommits - 1);
    if (this.state === 'finishing' && !this.pendingCommits) this.end();
  }

  private onClose(code: number, reason: string): void {
    if (this.state === 'ended') return;
    if (this.state === 'finishing') return this.end();
    this.fail(
      new ElevenLabsSttError(
        `ElevenLabs STT closed (${code}): ${reason}`,
        code,
        retryableClose(code),
      ),
    );
  }

  /** The graceful or cancelled end: usage once, then the socket closes normally. */
  private end(): void {
    if (this.state === 'ended') return;
    const connecting = this.state === 'connecting';
    this.settle();
    if (connecting) this.started.reject(new DOMException('ElevenLabs STT cancelled', 'AbortError'));
    this.closed.resolve();
    this.closeSocket(1000);
  }

  private fail(error: Error): void {
    if (this.state === 'ended') return;
    this.failure = error;
    this.settle();
    this.started.reject(error);
    this.closed.reject(error);
    this.closeSocket();
  }

  private settle(): void {
    this.state = 'ended';
    this.cancelFinish?.();
    this.once.emit({
      provider: 'elevenlabs',
      operation: 'stt',
      unit: 'audio_seconds',
      quantity: decimal(this.bytes / bytesPerSecond(this.input.format)),
      state: 'estimated',
      requestId:
        this.providerId ?? syntheticRequestId('elevenlabs', this.input.sessionId, this.attempt),
      elapsedMs: Math.max(0, this.clock.now() - this.startedAt),
    });
    for (const off of this.detach.splice(0)) off();
  }

  private closeSocket(code?: number): void {
    try {
      this.socket.close(code);
    } catch {
      // swallow-ok: a socket still connecting may refuse a close; it is discarded either way.
    }
  }
}
