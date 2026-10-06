import type { IncrementalTts, SynthesisInput, UsageMeter } from '@winsendotai/ovo-contracts';
import { decimal, usageOnce, type UsageOnce } from '@winsendotai/ovo-plugin-kit';
import { ElevenLabsTtsError } from './errors.ts';

type Render = (input: SynthesisInput) => AsyncIterable<Uint8Array>;

/**
 * The incremental contract over one HTTP stream, for when the socket is unavailable: text is held
 * until `flush`, then rendered in one request. Slower to first byte, but the caller's
 * open/push/flush/close sequence keeps working.
 */
export class HttpIncrementalTts implements IncrementalTts {
  readonly audio: AsyncGenerator<Uint8Array>;
  private readonly flushed = Promise.withResolvers<void>();
  private readonly controller = new AbortController();
  private readonly usage: UsageOnce;
  private readonly detachAbort: () => void;
  private text = '';
  private inputEnded = false;
  private started = false;
  private closed = false;

  constructor(
    private readonly render: Render,
    private readonly input: Omit<SynthesisInput, 'text'>,
    private readonly requestId: string,
    private readonly limit: number,
  ) {
    this.usage = usageOnce(input.onUsage);
    const abort = () => this.controller.abort(input.signal.reason);
    if (input.signal.aborted) abort();
    input.signal.addEventListener('abort', abort, { once: true });
    this.detachAbort = () => input.signal.removeEventListener('abort', abort);
    this.audio = this.iterate();
  }

  push(text: string): void {
    if (this.closed || this.inputEnded)
      throw new ElevenLabsTtsError('ElevenLabs TTS context is closed', false);
    if ([...this.text].length + [...text].length > this.limit)
      throw new TypeError(`ElevenLabs TTS text must contain 1–${this.limit} characters`);
    this.text += text;
  }

  flush(): void {
    if (this.closed || this.inputEnded)
      throw new ElevenLabsTtsError('ElevenLabs TTS context is closed', false);
    this.inputEnded = true;
    this.flushed.resolve();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort(new DOMException('ElevenLabs TTS context closed', 'AbortError'));
    this.flushed.resolve();
    this.detachAbort();
    // A started stream emits its own meter when it unwinds; one that never started costs nothing.
    if (this.started) await this.audio.return?.(undefined).catch(() => undefined);
    this.usage.emit(zeroMeter(this.requestId));
  }

  private async *iterate(): AsyncGenerator<Uint8Array> {
    await this.flushed.promise;
    this.input.signal.throwIfAborted();
    if (this.closed || !this.text) {
      this.usage.emit(zeroMeter(this.requestId));
      return;
    }
    this.started = true;
    yield* this.render({
      ...this.input,
      text: this.text,
      signal: this.controller.signal,
      onUsage: (meter) => this.usage.emit(meter),
    });
  }
}

function zeroMeter(requestId: string): UsageMeter {
  return {
    provider: 'elevenlabs',
    operation: 'tts',
    unit: 'characters',
    quantity: decimal(0),
    state: 'estimated',
    requestId,
    elapsedMs: 0,
  };
}
