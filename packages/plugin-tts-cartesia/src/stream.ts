import type { Clock, IncrementalTts, SynthesisInput } from '@winsendotai/ovo-contracts';
import { abortError, decimal, usageOnce, type UsageOnce } from '@winsendotai/ovo-plugin-kit';
import { AudioQueue } from './audio-queue.ts';
import type { CartesiaSocket, ContextSink } from './connection.ts';
import { CartesiaTtsError, WholeSamples, asTtsError } from './errors.ts';
import { RETRY_PAUSES_MS, pause, whenAborted, withinLimit } from './slots.ts';

export type OpenInput = Omit<SynthesisInput, 'text'>;

export interface StreamInit {
  /** `ovo-<n>`; a retry speaks on `ovo-<n>-r<k>`, since a refused context id is spent. */
  contextId: string;
  requestId: string;
  input: OpenInput;
  /** The generation fields every input of the context repeats (`requestFields`). */
  fields: Record<string, unknown>;
  limit: number;
  clock: Pick<Clock, 'now' | 'setTimeout'>;
  /** The session's pooled socket, reopened when the last one failed or idled out. */
  connect(signal: AbortSignal): Promise<CartesiaSocket>;
  /** Returns the context slot. */
  release(): void;
}

/**
 * One utterance as one Sonic context. `push` sends `{transcript, continue: true}`, `flush` ends the
 * input with `{transcript: "", continue: false}` and the context ends at `done`
 * (https://docs.cartesia.ai/use-the-api/tts-websocket/contexts.md, retrieved 2026-10-13).
 * `close` before `done` is a barge-in: `{context_id, cancel: true}`, and since cancel does not stop
 * a generation already under way, every later chunk for the context is dropped by the socket.
 * A retryable refusal or a dropped socket before the first audio replays the text on a fresh
 * context after a pause (`RETRY_PAUSES_MS`).
 */
export class CartesiaStream implements IncrementalTts, ContextSink {
  readonly audio: AsyncIterable<Uint8Array>;
  private readonly pieces: string[] = [];
  private readonly queue = new AudioQueue();
  private readonly samples: WholeSamples;
  private readonly usage: UsageOnce;
  private readonly startedAt: number;
  private readonly stopAbort: () => void;
  private socket?: CartesiaSocket;
  private contextId: string;
  private retries = 0;
  private characters = 0;
  private heard = false;
  private ended = false;
  private closed = false;
  private settled = false;

  private constructor(private readonly init: StreamInit) {
    this.contextId = init.contextId;
    this.samples = new WholeSamples(init.input.format);
    this.usage = usageOnce(init.input.onUsage);
    this.startedAt = init.clock.now();
    this.audio = this.queue.read(init.input.signal);
    this.stopAbort = whenAborted(init.input.signal, () => {
      this.cancelContext();
      this.settle(abortError(init.input.signal));
    });
  }

  /** A context whose socket is open; a refusal that outlives the retries rejects, unmetered. */
  static async open(init: StreamInit): Promise<CartesiaStream> {
    const stream = new CartesiaStream(init);
    try {
      await stream.attach();
    } catch (error) {
      stream.abandon();
      throw error;
    }
    return stream;
  }

  push(text: string): void {
    this.assertWritable();
    if (!text) return;
    this.characters = withinLimit(this.characters, text, this.init.limit);
    this.pieces.push(text);
    if (this.socket) this.sendInput({ transcript: text, continue: true });
  }

  flush(): void {
    this.assertWritable();
    this.ended = true;
    // Nothing was said, so the provider holds no context and no `done` will come.
    if (!this.pieces.length) return this.settle();
    if (this.socket) this.sendInput({ transcript: '', continue: false });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.settled) return;
    this.cancelContext();
    this.settle();
  }

  chunk(audio: Uint8Array): void {
    if (this.settled) return;
    this.heard = true;
    this.queue.push(this.samples.take(audio));
  }

  flushed(): void {
    // A stream never flushes mid-context; its end is `done`.
  }

  done(): void {
    if (this.settled) return;
    if (this.samples.partial)
      return this.settle(new CartesiaTtsError('Cartesia TTS ended mid-sample', false));
    this.settle();
  }

  failed(error: CartesiaTtsError): void {
    if (this.settled) return;
    this.unbind();
    if (!this.mayRetry(error)) return this.settle(error);
    pause(this.init.clock, RETRY_PAUSES_MS[this.retries - 1]!, this.init.input.signal)
      .then(() => this.attach())
      .catch((caught: unknown) => this.settle(asTtsError(caught)));
  }

  private async attach(): Promise<void> {
    for (;;) {
      try {
        const socket = await this.init.connect(this.init.input.signal);
        if (this.settled) return;
        this.bind(socket);
        return;
      } catch (error) {
        this.unbind();
        if (!this.mayRetry(error)) throw error;
        await pause(this.init.clock, RETRY_PAUSES_MS[this.retries - 1]!, this.init.input.signal);
      }
    }
  }

  /** Attaches to `socket` under a fresh id after a retry and replays the text said so far. */
  private bind(socket: CartesiaSocket): void {
    this.contextId = this.retries ? `${this.init.contextId}-r${this.retries}` : this.init.contextId;
    socket.attach(this.contextId, this);
    this.socket = socket;
    for (const piece of this.pieces) socket.send(this.frame({ transcript: piece, continue: true }));
    if (this.ended && this.pieces.length)
      socket.send(this.frame({ transcript: '', continue: false }));
  }

  private unbind(): void {
    this.socket?.detach(this.contextId, this);
    this.socket = undefined;
  }

  private mayRetry(error: unknown): boolean {
    if (this.heard || this.closed || this.settled || this.init.input.signal.aborted) return false;
    if (!(error instanceof CartesiaTtsError) || !error.retryable) return false;
    if (this.retries >= RETRY_PAUSES_MS.length) return false;
    this.retries += 1;
    return true;
  }

  private frame(extra: Record<string, unknown>): Record<string, unknown> {
    return { ...this.init.fields, context_id: this.contextId, ...extra };
  }

  private sendInput(extra: Record<string, unknown>): void {
    try {
      this.socket!.send(this.frame(extra));
    } catch (error) {
      this.failed(
        error instanceof CartesiaTtsError ? error : new CartesiaTtsError(String(error), true),
      );
    }
  }

  private cancelContext(): void {
    if (!this.socket || !this.pieces.length || this.settled) return;
    try {
      this.socket.send({ context_id: this.contextId, cancel: true });
    } catch {
      // swallow-ok: a socket that cannot take the frame has failed, and with it this context.
    }
  }

  private assertWritable(): void {
    if (this.closed || this.ended || this.settled)
      throw new CartesiaTtsError('Cartesia TTS context is closed', false);
  }

  /** Releases slot and routing without a meter: the context never reached the provider. */
  private abandon(): void {
    this.settled = true;
    this.stopAbort();
    this.unbind();
    this.init.release();
  }

  /** Ends the context exactly once: routing, slot, the reader and the single usage meter. */
  private settle(error?: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.stopAbort();
    this.unbind();
    this.init.release();
    this.queue.end(error);
    // "Credits are only used by successful requests" (https://docs.cartesia.ai/pricing.md): a
    // context the provider refused before any audio is metered at zero, the rest at the code
    // points sent. No billed count comes back, so the meter stays an estimate.
    const refused = error instanceof CartesiaTtsError && !this.heard;
    this.usage.emit({
      provider: 'cartesia',
      operation: 'tts',
      unit: 'characters',
      quantity: decimal(refused ? 0 : this.characters),
      state: 'estimated',
      requestId: this.init.requestId,
      elapsedMs: Math.max(0, this.init.clock.now() - this.startedAt),
    });
  }
}
