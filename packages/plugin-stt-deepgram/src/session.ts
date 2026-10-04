import {
  bytesPerSecond,
  type Clock,
  type SpeechToText,
  type SttSession,
  type TranscriptSegment,
  type WebSocketLike,
} from '@winsendotai/ovo-contracts';
import { decimal, usageOnce } from '@winsendotai/ovo-plugin-kit';

type Start = Parameters<SpeechToText['start']>[0];

export class DeepgramSession implements SttSession {
  private readonly startedAt: number;
  private readonly once;
  private readonly done: Promise<void>;
  private resolveDone!: () => void;
  private rejectDone!: (reason: Error) => void;
  private cancelKeepalive: () => void = () => undefined;
  private readonly offs: (() => void)[] = [];
  private revision = 0;
  private segment = 0;
  private bytes = 0;
  private metadata?: { duration: number; requestId: string };
  private ended = false;
  private finishing = false;

  constructor(
    private readonly socket: WebSocketLike,
    private readonly input: Start,
    private readonly clock: Clock,
    private readonly fallbackRequestId: string,
  ) {
    this.startedAt = clock.now();
    this.once = usageOnce(input.onUsage);
    this.done = new Promise<void>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
    void this.done.catch(() => undefined);
    this.offs.push(
      socket.on('message', (data, binary) => this.onMessage(data, binary)),
      socket.on('close', (code, reason) => this.onClose(code, reason)),
      socket.on('error', (error) => this.fail(error)),
    );
    const abort = () => this.fail(new DOMException('Deepgram session aborted', 'AbortError'));
    input.signal.addEventListener('abort', abort, { once: true });
    this.offs.push(() => input.signal.removeEventListener('abort', abort));
    this.scheduleKeepalive();
  }

  async write(frame: Uint8Array, signal?: AbortSignal): Promise<void> {
    this.assertWritable(signal);
    if (!frame.byteLength) throw new TypeError('Deepgram audio frame is empty');
    try {
      this.socket.send(frame);
      this.bytes += frame.byteLength;
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error('Deepgram write failed'));
      throw error;
    }
  }

  async forceEndpoint(): Promise<void> {
    this.assertWritable();
    try {
      this.socket.send(JSON.stringify({ type: 'Finalize' }));
    } catch (error) {
      this.fail(asError(error, 'Deepgram Finalize failed'));
      throw error;
    }
  }

  async finish(signal?: AbortSignal): Promise<void> {
    const abort = () => this.fail(asError(signal?.reason, 'Deepgram finish aborted'));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    try {
      if (!this.finishing && !this.ended) {
        this.finishing = true;
        try {
          this.socket.send(JSON.stringify({ type: 'CloseStream' }));
        } catch (error) {
          this.fail(asError(error, 'Deepgram CloseStream failed'));
        }
      }
      await this.done;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  async cancel(_reason: string): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.emitUsage();
    this.dispose();
    this.resolveDone();
    this.socket.close();
  }

  private assertWritable(signal?: AbortSignal): void {
    if (signal?.aborted) throw signal.reason;
    if (this.input.signal.aborted) throw this.input.signal.reason;
    if (this.ended || this.finishing || this.socket.readyState !== 1)
      throw new Error('Deepgram stream is no longer writable');
  }

  private onMessage(data: string | Uint8Array, binary: boolean): void {
    if (binary) return this.fail(new Error('Deepgram returned binary data'));
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(data as string) as Record<string, unknown>;
      if (!message || typeof message !== 'object') throw new Error();
    } catch {
      return this.fail(new Error('Deepgram returned malformed JSON'));
    }
    if (message.type === 'Metadata') {
      const duration = message.duration;
      if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0)
        return this.fail(new Error('Deepgram Metadata has no valid duration'));
      this.metadata = {
        duration,
        requestId:
          typeof message.request_id === 'string' && message.request_id
            ? message.request_id
            : this.fallbackRequestId,
      };
      this.emitUsage();
      this.ended = true;
      this.dispose();
      this.resolveDone();
      return;
    }
    if (message.type === 'SpeechStarted') {
      this.input.onEvent({ type: 'speech-start', atMs: millis(message.timestamp) });
      return;
    }
    if (message.type === 'UtteranceEnd') {
      this.input.onEvent({ type: 'utterance-end', atMs: millis(message.last_word_end) });
      return;
    }
    if (message.type !== 'Results') return;
    const channel = asRecord(message.channel);
    const alternatives = Array.isArray(channel?.alternatives) ? channel.alternatives : [];
    const alternative = asRecord(alternatives[0]);
    if (typeof alternative?.transcript === 'string' && alternative.transcript) {
      const startMs = millis(message.start);
      const durationMs = millis(message.duration);
      const segment: TranscriptSegment = {
        segmentId: `${this.input.sessionId}:${this.segment}`,
        revision: ++this.revision,
        text: alternative.transcript,
        stability: message.is_final === true ? 'final' : 'interim',
        formatted: true,
        ...(startMs === undefined ? {} : { startMs }),
        ...(startMs === undefined || durationMs === undefined
          ? {}
          : { endMs: startMs + durationMs }),
        ...(typeof alternative.confidence === 'number'
          ? { confidence: alternative.confidence }
          : {}),
        words: wordsOf(alternative.words),
      };
      this.input.onEvent({ type: 'transcript', segment });
      if (message.is_final === true) this.segment += 1;
    }
    if (message.speech_final === true) this.input.onEvent({ type: 'end-of-turn' });
  }

  private onClose(code: number, reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.emitUsage();
    this.dispose();
    this.rejectDone(
      new Error(`Deepgram closed before Metadata (${code}${reason ? `: ${reason}` : ''})`),
    );
  }

  private fail(error: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.emitUsage();
    this.dispose();
    this.rejectDone(error);
    try {
      this.socket.close();
    } catch {
      /* already closing */
    }
  }

  private emitUsage(): void {
    const reconciled = this.metadata !== undefined;
    this.once.emit({
      provider: 'deepgram',
      operation: 'stt',
      unit: 'audio_seconds',
      quantity: decimal(this.metadata?.duration ?? this.bytes / bytesPerSecond(this.input.format)),
      state: reconciled ? 'reconciled' : 'estimated',
      requestId: this.metadata?.requestId ?? this.fallbackRequestId,
      elapsedMs: Math.max(0, this.clock.now() - this.startedAt),
    });
  }

  private scheduleKeepalive(): void {
    this.cancelKeepalive = this.clock.setTimeout(() => {
      if (this.ended || this.finishing) return;
      try {
        this.socket.send(JSON.stringify({ type: 'KeepAlive' }));
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error('Deepgram keepalive failed'));
        return;
      }
      this.scheduleKeepalive();
    }, 5000);
  }

  private dispose(): void {
    this.cancelKeepalive();
    for (const off of this.offs.splice(0)) off();
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}
function millis(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value * 1000)
    : undefined;
}
function wordsOf(value: unknown): TranscriptSegment['words'] {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((entry) => {
    const word = asRecord(entry);
    const startMs = millis(word?.start);
    const endMs = millis(word?.end);
    if (!word || typeof word.word !== 'string' || startMs === undefined || endMs === undefined)
      return [];
    return [{ text: String(word.punctuated_word ?? word.word), startMs, endMs, final: true }];
  });
}
