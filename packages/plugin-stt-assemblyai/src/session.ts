import { padWithSilence } from '@winsendotai/ovo-audio';
import {
  bytesPerSecond,
  type Clock,
  type SpeechToText,
  type SttSession,
  type WebSocketLike,
} from '@winsendotai/ovo-contracts';
import { decimal, syntheticRequestId, usageOnce } from '@winsendotai/ovo-plugin-kit';
import type { AssemblyAiBinding } from './provider.ts';
import {
  AssemblyAiProviderError,
  connectionDrop,
  milliseconds,
  numeric,
  record,
  retryable,
  turnSegment,
} from './protocol.ts';

export { AssemblyAiProviderError } from './protocol.ts';

type Start = Parameters<SpeechToText['start']>[0];

export class AssemblyAiSession implements SttSession {
  readonly ready: Promise<void>;
  private readonly done: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private resolveDone!: () => void;
  private rejectDone!: (error: Error) => void;
  private readonly once;
  private readonly offs: Array<() => void> = [];
  private revision = 0;
  private readonly completedTurns = new Set<number>();
  private readonly startedAt: number;
  private pending = new Uint8Array(0);
  private byteCount = 0;
  private providerId?: string;
  private duration?: number;
  private ending = false;
  private ended = false;
  private failure?: Error;

  constructor(
    private readonly socket: WebSocketLike,
    private readonly input: Start,
    private readonly binding: Readonly<AssemblyAiBinding>,
    private readonly clock: Clock,
    /** Distinguishes the estimated usage of each connect attempt or reconnect in one call. */
    private readonly attempt = 1,
  ) {
    this.startedAt = clock.now();
    this.once = usageOnce(input.onUsage);
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.done = new Promise<void>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
    // swallow-ok: whoever awaits ready/done gets the rejection; this only avoids an unhandled one.
    for (const settled of [this.ready, this.done]) void settled.catch(() => undefined);
    this.subscribe();
  }

  private subscribe(): void {
    this.offs.push(
      this.socket.on('message', (raw, binary) => this.message(raw, binary)),
      this.socket.on('close', (code, reason) => this.close(code, reason)),
      // After Begin a transport error (a reset) is a drop; during the handshake the connect
      // retry already handles it.
      this.socket.on('error', (error) =>
        this.fail(this.providerId ? connectionDrop(`transport error: ${error.message}`) : error),
      ),
    );
    const abort = () => this.fail(new DOMException('AssemblyAI session aborted', 'AbortError'));
    this.input.signal.addEventListener('abort', abort, { once: true });
    this.offs.push(() => this.input.signal.removeEventListener('abort', abort));
  }

  async write(frame: Uint8Array, signal?: AbortSignal): Promise<void> {
    this.writable(signal);
    if (!frame.byteLength) throw new TypeError('AssemblyAI audio frame is empty');
    this.byteCount += frame.byteLength;
    const joined = new Uint8Array(this.pending.byteLength + frame.byteLength);
    joined.set(this.pending);
    joined.set(frame, this.pending.byteLength);
    this.pending = joined;
    const minimum = Math.ceil(bytesPerSecond(this.input.format) * 0.05);
    const maximum = Math.floor(bytesPerSecond(this.input.format));
    while (this.pending.byteLength >= minimum) {
      const length = Math.min(maximum, this.pending.byteLength);
      this.socket.send(this.pending.slice(0, length));
      this.pending = this.pending.slice(length);
    }
  }

  async forceEndpoint(): Promise<void> {
    this.writable();
    this.flushPending();
    this.socket.send(JSON.stringify({ type: 'ForceEndpoint' }));
  }

  async finish(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason;
    if (!this.ending && !this.ended) {
      this.ending = true;
      this.flushPending();
      this.socket.send(JSON.stringify({ type: 'Terminate' }));
    }
    const abort = () => this.fail(new DOMException('AssemblyAI finish aborted', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await this.done;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  async cancel(_reason: string): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.usage();
    this.dispose();
    this.resolveDone();
    this.socket.close();
  }

  /** Fails a session whose handshake the provider abandoned, such as a missed Begin deadline. */
  abandon(error: Error): void {
    this.fail(error);
  }

  private flushPending(): void {
    if (!this.pending.byteLength) return;
    const minimum = Math.ceil(bytesPerSecond(this.input.format) * 0.05);
    const frame = padWithSilence(this.pending, minimum, this.input.format);
    this.socket.send(frame);
    this.pending = new Uint8Array(0);
  }

  private writable(signal?: AbortSignal): void {
    signal?.throwIfAborted();
    this.input.signal.throwIfAborted();
    // A provider close surfaces on the next write with its code, so the host can tell a
    // retryable drop from its own ingress limits.
    if (this.failure) throw this.failure;
    if (this.ending || this.ended) throw new Error('AssemblyAI session is no longer writable');
    if (this.socket.readyState !== 1) {
      // `ws` reports CLOSING as soon as the provider's close frame arrives, but emits 'close' with
      // its code only once TCP closes, about a round trip later (~200 ms from the India VM). A
      // write in that window is a provider drop the host may reconnect from, not a host error.
      const error = connectionDrop('socket closing');
      this.fail(error);
      throw error;
    }
  }

  private message(raw: string | Uint8Array, binary: boolean): void {
    if (binary) return this.fail(new AssemblyAiProviderError('binary response', 'protocol', false));
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(String(raw)) as Record<string, unknown>;
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    } catch {
      // swallow-ok: a malformed frame becomes the session's typed protocol failure.
      return this.fail(new AssemblyAiProviderError('malformed response', 'protocol', false));
    }
    if (value.type === 'Begin') {
      const model = record(value.configuration)?.model;
      if (
        typeof model === 'string' &&
        model !== (this.binding.model ?? 'universal-streaming-english')
      )
        return this.fail(
          new AssemblyAiProviderError(
            `AssemblyAI model mismatch: ${model}`,
            'model-mismatch',
            false,
          ),
        );
      if (typeof value.id !== 'string' || !value.id)
        return this.fail(new AssemblyAiProviderError('Begin has no id', 'protocol', false));
      this.providerId = value.id;
      this.resolveReady();
      return;
    }
    if (!this.providerId)
      return this.fail(new AssemblyAiProviderError('message before Begin', 'protocol', false));
    if (value.type === 'SpeechStarted') {
      this.input.onEvent({ type: 'speech-start', atMs: milliseconds(value.timestamp) });
    } else if (value.type === 'Turn') {
      this.turn(value);
    } else if (value.type === 'Termination') {
      if (
        typeof value.session_duration_seconds !== 'number' ||
        !Number.isFinite(value.session_duration_seconds) ||
        value.session_duration_seconds < 0
      )
        return this.fail(
          new AssemblyAiProviderError('Termination has no duration', 'protocol', false),
        );
      this.duration = value.session_duration_seconds;
      this.ended = true;
      this.usage();
      this.dispose();
      this.resolveDone();
    } else if (value.type === 'Error') {
      const code = typeof value.error_code === 'number' ? value.error_code : 1011;
      this.fail(
        new AssemblyAiProviderError(
          String(value.error ?? 'AssemblyAI error'),
          code,
          retryable(code),
        ),
      );
    }
  }

  private turn(value: Record<string, unknown>): void {
    const segment = turnSegment(value, this.revision + 1);
    if (!segment) return this.fail(new AssemblyAiProviderError('invalid Turn', 'protocol', false));
    this.revision = segment.revision;
    const index = value.turn_order as number;
    this.input.onEvent({ type: 'transcript', segment });
    if (value.end_of_turn === true && !this.completedTurns.has(index)) {
      this.completedTurns.add(index);
      this.input.onEvent({
        type: 'end-of-turn',
        confidence: numeric(value.end_of_turn_confidence),
      });
    }
  }

  private close(code: number, reason: string): void {
    if (this.ended) return;
    this.fail(
      new AssemblyAiProviderError(`AssemblyAI closed (${code}): ${reason}`, code, retryable(code)),
    );
  }

  private fail(error: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.failure = error;
    this.usage();
    this.dispose();
    this.rejectReady(error);
    this.rejectDone(error);
    try {
      this.socket.close();
    } catch {
      // swallow-ok: a socket still connecting may refuse a close; it is discarded either way.
    }
  }

  private usage(): void {
    this.once.emit({
      provider: 'assemblyai',
      operation: 'stt',
      unit: 'session_seconds',
      quantity: decimal(this.duration ?? Math.max(0, this.clock.now() - this.startedAt) / 1000),
      state: this.duration === undefined ? 'estimated' : 'reconciled',
      requestId:
        this.providerId ?? syntheticRequestId('assemblyai', this.input.sessionId, this.attempt),
      elapsedMs: Math.max(0, this.clock.now() - this.startedAt),
    });
  }

  private dispose(): void {
    for (const off of this.offs.splice(0)) off();
  }
}
