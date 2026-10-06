import { padWithSilence } from '@winsendotai/ovo-audio';
import {
  bytesPerSecond,
  type Clock,
  type SpeechToText,
  type SttSession,
  type WebSocketLike,
} from '@winsendotai/ovo-contracts';
import { updateConfigurationMessage, type AssemblyAiConfigurationUpdate } from './endpointing.ts';
import type { AssemblyAiBinding } from './provider.ts';
import { AssemblyAiUsage, TERMINATION_GRACE_MS } from './session-usage.ts';
import {
  AssemblyAiProviderError,
  beginId,
  connectionDrop,
  milliseconds,
  providerError,
  retryable,
  sessionDuration,
  TurnEvents,
} from './protocol.ts';

export { AssemblyAiProviderError } from './protocol.ts';
export { TERMINATION_GRACE_MS } from './session-usage.ts';

type Start = Parameters<SpeechToText['start']>[0];

export class AssemblyAiSession implements SttSession {
  readonly ready: Promise<void>;
  private readonly done: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private resolveDone!: () => void;
  private rejectDone!: (error: Error) => void;
  private readonly meter: AssemblyAiUsage;
  private readonly offs: Array<() => void> = [];
  private readonly turns = new TurnEvents();
  private pending = new Uint8Array(0);
  private ending = false;
  private ended = false;
  private failure?: Error;
  private cancelGrace?: () => void;

  constructor(
    private readonly socket: WebSocketLike,
    private readonly input: Start,
    private readonly binding: Readonly<AssemblyAiBinding>,
    private readonly clock: Clock,
    /** Distinguishes the estimated usage of each connect attempt or reconnect in one call. */
    attempt = 1,
  ) {
    this.meter = new AssemblyAiUsage(input, clock, attempt);
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
        this.fail(
          this.meter.providerId ? connectionDrop(`transport error: ${error.message}`) : error,
        ),
      ),
    );
    // A hang-up aborts the session: it still asks for Termination so the billed duration arrives.
    const abort = () => {
      if (!this.terminate())
        this.fail(new DOMException('AssemblyAI session aborted', 'AbortError'));
    };
    this.input.signal.addEventListener('abort', abort, { once: true });
    this.offs.push(() => this.input.signal.removeEventListener('abort', abort));
  }

  async write(frame: Uint8Array, signal?: AbortSignal): Promise<void> {
    this.writable(signal);
    if (!frame.byteLength) throw new TypeError('AssemblyAI audio frame is empty');
    this.meter.sent(frame.byteLength);
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

  /** Tightens or relaxes endpointing mid-call, for example after a yes/no question. */
  async updateConfiguration(update: AssemblyAiConfigurationUpdate): Promise<void> {
    this.writable();
    this.socket.send(updateConfigurationMessage(update));
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

  /** Ends the session within {@link TERMINATION_GRACE_MS}, metering the billed duration if it comes. */
  async cancel(_reason: string): Promise<void> {
    if (this.ended) return;
    if (!this.terminate()) return this.settle();
    // swallow-ok: a provider failure while terminating has already been metered and reported.
    await this.done.catch(() => undefined);
  }

  /**
   * OPS-18: sends Terminate (once) so the provider's Termination reports the billed duration, and
   * settles with the estimate if it has not arrived within the grace. False when the session cannot
   * take one: before Begin, or once the socket is no longer open.
   */
  private terminate(): boolean {
    if (this.ended || !this.meter.providerId || this.socket.readyState !== 1) return false;
    if (!this.ending) {
      this.ending = true;
      try {
        this.socket.send(JSON.stringify({ type: 'Terminate' }));
      } catch {
        return false; // swallow-ok: the caller settles with the wall-clock estimate instead.
      }
    }
    this.cancelGrace ??= this.clock.setTimeout(() => this.settle(), TERMINATION_GRACE_MS);
    return true;
  }

  /** Ends the session now with the usage known so far: the estimate without a Termination. */
  private settle(): void {
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
      const id = beginId(value, this.binding.model ?? 'universal-streaming-english');
      if (typeof id !== 'string') return this.fail(id);
      this.meter.providerId = id;
      this.resolveReady();
      return;
    }
    if (!this.meter.providerId)
      return this.fail(new AssemblyAiProviderError('message before Begin', 'protocol', false));
    if (value.type === 'SpeechStarted') {
      this.input.onEvent({ type: 'speech-start', atMs: milliseconds(value.timestamp) });
    } else if (value.type === 'Turn') {
      const events = this.turns.of(value);
      if (!events) return this.fail(new AssemblyAiProviderError('invalid Turn', 'protocol', false));
      for (const event of events) this.input.onEvent(event);
    } else if (value.type === 'Termination') {
      const duration = sessionDuration(value);
      if (duration === undefined)
        return this.fail(
          new AssemblyAiProviderError('Termination has no duration', 'protocol', false),
        );
      this.meter.duration = duration;
      // A cancel or hang-up does not wait for the provider's own close after its Termination.
      const cancelled = this.cancelGrace !== undefined;
      this.ended = true;
      this.usage();
      this.dispose();
      this.resolveDone();
      if (cancelled) this.socket.close();
    } else if (value.type === 'Error') {
      this.fail(providerError(value));
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
    this.meter.emit();
  }

  private dispose(): void {
    this.cancelGrace?.();
    for (const off of this.offs.splice(0)) off();
  }
}
