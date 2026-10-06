import type { IncrementalTts, UsageMeter, UsageSink } from '@winsendotai/ovo-contracts';
import { ElevenLabsTtsError } from './errors.ts';
import type { HttpRender } from './reply-part.ts';

/**
 * An `open()` utterance on the socket that replays over HTTP when the socket drops before the first
 * byte (Wave 2 review note: only `synthesize` used to retry). The socket context's meter is held
 * until the outcome is known, so one utterance still emits exactly one meter: the socket's estimate,
 * or the HTTP request's own.
 */
export class ReplayingContext implements IncrementalTts {
  readonly audio: AsyncIterable<Uint8Array>;
  private readonly flushed = Promise.withResolvers<void>();
  private readonly controller = new AbortController();
  private readonly held: UsageMeter[] = [];
  private inner!: IncrementalTts;
  private text = '';
  private replayed = false;
  private inputEnded = false;
  private closed = false;

  constructor(
    open: (onUsage: UsageSink) => IncrementalTts,
    private readonly render: HttpRender,
    private readonly signal: AbortSignal,
    private readonly onUsage: UsageSink,
  ) {
    this.inner = open((meter) => (this.replayed ? undefined : this.held.push(meter)));
    this.audio = this.iterate();
    const abort = () => this.controller.abort(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  }

  push(text: string): void {
    this.assertWritable();
    this.text += text;
    // After a drop the socket context refuses text; it is still kept here for the replay.
    if (!this.replayed) this.tryInner(() => this.inner.push(text));
  }

  flush(): void {
    this.assertWritable();
    this.inputEnded = true;
    this.flushed.resolve();
    if (!this.replayed) this.tryInner(() => this.inner.flush());
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.flushed.resolve();
    this.controller.abort(new DOMException('ElevenLabs TTS context closed', 'AbortError'));
    await this.inner.close();
    this.release();
  }

  private assertWritable(): void {
    if (this.closed || this.inputEnded)
      throw new ElevenLabsTtsError('ElevenLabs TTS context is closed', false);
  }

  /**
   * A send refused because the socket just dropped (the context is then closed) surfaces through
   * `audio`, which decides whether to replay; a bad argument still throws here.
   */
  private tryInner(send: () => void): void {
    try {
      send();
    } catch (error) {
      if (!(error instanceof ElevenLabsTtsError)) throw error;
    }
  }

  private release(): void {
    for (const meter of this.held.splice(0)) this.onUsage(meter);
  }

  private async *iterate(): AsyncIterable<Uint8Array> {
    let received = false;
    try {
      for await (const chunk of this.inner.audio) {
        received = true;
        yield chunk;
      }
      return;
    } catch (error) {
      const retry =
        !received &&
        !this.closed &&
        !this.signal.aborted &&
        error instanceof ElevenLabsTtsError &&
        error.retryable;
      if (!retry) throw error;
    }
    // The dropped socket's estimate is replaced by the HTTP request's own meter.
    this.replayed = true;
    this.held.length = 0;
    await this.flushed.promise;
    this.signal.throwIfAborted();
    if (this.closed || !this.text.trim()) return;
    yield* this.render(this.text, this.controller.signal, this.onUsage);
  }
}
