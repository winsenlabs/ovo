import type {
  Clock,
  IncrementalTts,
  SynthesisInput,
  WebSocketLike,
} from '@winsendotai/ovo-contracts';
import { decimal, syntheticRequestId, usageOnce } from '@winsendotai/ovo-plugin-kit';
import type { SarvamTtsBinding } from './tts.ts';

type Input = Omit<SynthesisInput, 'text'>;

export class SarvamTtsError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'SarvamTtsError';
  }
}

export class SarvamTtsSession implements IncrementalTts {
  readonly ready;
  readonly audio: AsyncIterable<Uint8Array>;
  private readonly readyGate = Promise.withResolvers<void>();
  private readonly once;
  private readonly startedAt: number;
  private readonly queue: Uint8Array[] = [];
  private readonly offs: Array<() => void> = [];
  private wake?: () => void;
  private error?: Error;
  private cancelPing?: () => void;
  private requestId?: string;
  private characters = 0;
  private finished = false;
  private closed = false;

  constructor(
    private readonly socket: WebSocketLike,
    private readonly input: Input,
    private readonly binding: Readonly<SarvamTtsBinding>,
    private readonly clock: Clock,
  ) {
    this.startedAt = clock.now();
    this.once = usageOnce(input.onUsage);
    this.ready = this.readyGate.promise;
    void this.ready.catch(() => undefined);
    this.audio = this.iterate();
    this.offs.push(
      socket.on('open', () => this.opened()),
      socket.on('message', (raw, binary) => this.message(raw, binary)),
      socket.on('close', (code, reason) =>
        this.fail(new SarvamTtsError(`Sarvam TTS closed (${code}): ${reason}`, code === 1011)),
      ),
      socket.on('error', (error) => this.fail(error)),
    );
    const abort = () => this.fail(new DOMException('Sarvam TTS aborted', 'AbortError'));
    input.signal.addEventListener('abort', abort, { once: true });
    this.offs.push(() => input.signal.removeEventListener('abort', abort));
  }

  push(text: string): void {
    if (this.closed || this.finished || this.socket.readyState !== 1)
      throw new Error('Sarvam TTS session is closed');
    if (!text || this.characters + [...text].length > 2500)
      throw new TypeError('Sarvam TTS text must contain 1–2500 characters');
    this.characters += [...text].length;
    this.socket.send(JSON.stringify({ type: 'text', data: { text } }));
  }

  flush(): void {
    if (this.closed || this.finished || this.socket.readyState !== 1)
      throw new Error('Sarvam TTS session is closed');
    this.socket.send(JSON.stringify({ type: 'flush' }));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.emitUsage(this.finished ? 'reconciled' : 'estimated');
    this.dispose();
    this.wake?.();
    this.socket.close();
  }

  private opened(): void {
    try {
      this.socket.send(
        JSON.stringify({
          type: 'config',
          data: {
            speaker: this.input.voice ?? this.binding.speaker ?? 'shubh',
            language_code: this.input.language,
            output_audio_codec: this.input.format.encoding === 'mulaw' ? 'mulaw' : 'linear16',
            speech_sample_rate: this.input.format.sampleRate,
            ...(this.binding.pace !== undefined ? { pace: this.binding.pace } : {}),
            ...(this.binding.temperature !== undefined
              ? { temperature: this.binding.temperature }
              : {}),
            ...(this.binding.dictId ? { dict_id: this.binding.dictId } : {}),
          },
        }),
      );
      this.readyGate.resolve();
      this.schedulePing();
    } catch (error) {
      this.fail(error as Error);
    }
  }

  private message(raw: string | Uint8Array, binary: boolean): void {
    if (binary) return this.fail(new SarvamTtsError('binary TTS response', false));
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(String(raw)) as Record<string, unknown>;
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    } catch {
      return this.fail(new SarvamTtsError('malformed TTS response', false));
    }
    const data =
      value.data && typeof value.data === 'object' && !Array.isArray(value.data)
        ? (value.data as Record<string, unknown>)
        : undefined;
    if (value.type === 'audio') {
      if (typeof data?.audio !== 'string')
        return this.fail(new SarvamTtsError('audio frame has no audio', false));
      if (typeof data.request_id === 'string' && data.request_id) this.requestId = data.request_id;
      try {
        this.queue.push(decodeBase64(data.audio));
      } catch {
        return this.fail(new SarvamTtsError('invalid base64 audio', false));
      }
      this.wake?.();
    } else if (value.type === 'event' && data?.event_type === 'final') {
      this.finished = true;
      this.emitUsage('reconciled');
      this.wake?.();
    } else if (value.type === 'error') {
      this.fail(
        new SarvamTtsError(String(data?.message ?? value.message ?? 'Sarvam TTS error'), false),
      );
    }
  }

  private async *iterate(): AsyncIterable<Uint8Array> {
    for (;;) {
      this.input.signal.throwIfAborted();
      if (this.queue.length) {
        yield this.queue.shift()!;
        continue;
      }
      if (this.error) throw this.error;
      if (this.finished || this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }

  private fail(error: Error): void {
    if (this.closed || this.finished) return;
    this.error = error;
    this.closed = true;
    this.emitUsage('estimated');
    this.readyGate.reject(error);
    this.dispose();
    this.wake?.();
    this.socket.close();
  }

  private emitUsage(state: 'reconciled' | 'estimated'): void {
    this.once.emit({
      provider: 'sarvam',
      operation: 'tts',
      unit: 'characters',
      quantity: decimal(this.characters),
      state,
      requestId: this.requestId ?? syntheticRequestId('sarvam', this.input.sessionId, 1),
      elapsedMs: Math.max(0, this.clock.now() - this.startedAt),
    });
  }

  private schedulePing(): void {
    this.cancelPing?.();
    this.cancelPing = this.clock.setTimeout(() => {
      if (this.closed || this.finished || this.socket.readyState !== 1) return;
      try {
        this.socket.send(JSON.stringify({ type: 'ping' }));
      } catch (error) {
        return this.fail(error as Error);
      }
      this.schedulePing();
    }, 45_000);
  }

  private dispose(): void {
    this.cancelPing?.();
    for (const off of this.offs.splice(0)) off();
  }
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
