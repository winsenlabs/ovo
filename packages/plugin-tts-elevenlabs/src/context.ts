import type { Clock, IncrementalTts, SynthesisInput } from '@winsendotai/ovo-contracts';
import { abortError, decimal, usageOnce, type UsageOnce } from '@winsendotai/ovo-plugin-kit';
import type { ContextSink, MultiContextConnection } from './connection.ts';
import { ElevenLabsTtsError, SampleAligner } from './errors.ts';

export interface ContextInit {
  connection: MultiContextConnection;
  contextId: string;
  requestId: string;
  input: Omit<SynthesisInput, 'text'>;
  /** voice_settings and friends: sent once, on the context's first text frame. */
  opening: Record<string, unknown>;
  limit: number;
  clock: Pick<Clock, 'now'>;
  release: () => void;
}

/**
 * One utterance on the pooled socket. `push` streams text, `flush` ends the input (flush, then
 * close_context, after which the server finishes rendering and sends `isFinal`), `close` releases
 * it — before `isFinal` that is a barge-in, and only this context is closed on the server.
 */
export class ElevenLabsContext implements IncrementalTts, ContextSink {
  readonly audio: AsyncIterable<Uint8Array>;
  private readonly queue: Uint8Array[] = [];
  private readonly aligner: SampleAligner;
  private readonly usage: UsageOnce;
  private readonly startedAt: number;
  private readonly detachAbort: () => void;
  private wake?: () => void;
  private error?: Error;
  private characters = 0;
  private created = false;
  private inputEnded = false;
  private closeSent = false;
  private settled = false;
  private closed = false;

  constructor(private readonly init: ContextInit) {
    this.aligner = new SampleAligner(init.input.format);
    this.usage = usageOnce(init.input.onUsage);
    this.startedAt = init.clock.now();
    this.audio = this.iterate();
    init.connection.register(init.contextId, this);
    const abort = () => {
      this.sendClose();
      this.onError(abortError(init.input.signal));
    };
    init.input.signal.addEventListener('abort', abort, { once: true });
    this.detachAbort = () => init.input.signal.removeEventListener('abort', abort);
  }

  push(text: string): void {
    this.assertWritable();
    if (!text) return;
    const size = [...text].length;
    if (this.characters + size > this.init.limit)
      throw new TypeError(`ElevenLabs TTS text must contain 1–${this.init.limit} characters`);
    this.init.connection.send({
      text,
      context_id: this.init.contextId,
      ...(this.created ? {} : this.init.opening),
    });
    this.created = true;
    this.characters += size;
  }

  flush(): void {
    this.assertWritable();
    this.inputEnded = true;
    // Nothing was spoken, so no context exists on the server and no isFinal will come.
    if (!this.created) return this.onFinal();
    // The empty-text flush is the shape LiveKit's production plugin sends at end of input.
    this.init.connection.send({ context_id: this.init.contextId, text: '', flush: true });
    this.sendClose();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.settled) this.sendClose();
    this.settle();
    this.wake?.();
  }

  onAudio(bytes: Uint8Array): void {
    if (this.settled) return;
    const whole = this.aligner.push(bytes);
    if (!whole) return;
    this.queue.push(whole);
    this.wake?.();
  }

  onFinal(): void {
    if (this.settled) return;
    this.settle();
    this.wake?.();
  }

  onError(error: Error): void {
    if (this.settled) return;
    this.error = error;
    this.settle();
    this.wake?.();
  }

  private assertWritable(): void {
    if (this.closed || this.inputEnded || this.settled)
      throw new ElevenLabsTtsError('ElevenLabs TTS context is closed', false);
  }

  private sendClose(): void {
    if (!this.created || this.closeSent || !this.init.connection.usable) return;
    this.closeSent = true;
    try {
      this.init.connection.send({ context_id: this.init.contextId, close_context: true });
    } catch {
      // swallow-ok: a socket that cannot take the frame has already failed every context.
    }
  }

  /** Ends the context locally exactly once: slot, routing and the single usage meter. */
  private settle(): void {
    if (this.settled) return;
    this.settled = true;
    this.detachAbort();
    this.init.connection.unregister(this.init.contextId);
    this.init.release();
    this.usage.emit({
      provider: 'elevenlabs',
      operation: 'tts',
      unit: 'characters',
      quantity: decimal(this.characters),
      // The socket reports no billed count, so the sent characters stay an estimate.
      state: 'estimated',
      requestId: this.init.requestId,
      elapsedMs: Math.max(0, this.init.clock.now() - this.startedAt),
    });
  }

  private async *iterate(): AsyncIterable<Uint8Array> {
    for (;;) {
      this.init.input.signal.throwIfAborted();
      if (this.queue.length) {
        yield this.queue.shift()!;
        continue;
      }
      if (this.error) throw this.error;
      if (this.settled || this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }
}
