import type {
  StreamingStt,
  StreamingSttSession,
  TranscriptRevision,
} from '@winsendotai/ovo-plugin-voice';
import WebSocket, { type RawData } from 'ws';
import { abortError, decimal, type OperationSignal } from './abort.ts';
import {
  ProviderBufferError,
  ProviderProtocolError,
  type DeepgramBinding,
  type ProviderUsage,
  type ProviderUsageSink,
} from './types.ts';

type StreamingSttRequest = Parameters<StreamingStt['start']>[0];

export function createDeepgramSession(
  socket: WebSocket,
  request: StreamingSttRequest,
  binding: Readonly<DeepgramBinding>,
  lifetime: OperationSignal,
  usageSink: ProviderUsageSink | undefined,
): StreamingSttSession {
  return new DeepgramSession(socket, request, binding, lifetime, usageSink);
}

class DeepgramSession implements StreamingSttSession {
  private readonly terminal = deferred<void>();
  private readonly startedAt = performance.now();
  private readonly keepAlive: NodeJS.Timeout;
  private revision = 0;
  private speechStartPending = true;
  private finished = false;
  private requestId: string | undefined;
  private durationSeconds: number | undefined;
  private usageEmitted = false;
  private terminalError: Error | undefined;

  constructor(
    private readonly socket: WebSocket,
    private readonly request: StreamingSttRequest,
    private readonly binding: Readonly<DeepgramBinding>,
    private readonly lifetime: OperationSignal,
    private readonly usageSink: ProviderUsageSink | undefined,
  ) {
    void this.terminal.promise.catch(() => undefined);
    socket.on('message', (data, isBinary) => this.onMessage(data, isBinary));
    socket.once('error', (error) =>
      this.fail(new ProviderProtocolError(`Deepgram socket error: ${error.message}`)),
    );
    socket.once('close', (code, reason) => this.onClose(code, reason.toString()));
    lifetime.signal.addEventListener('abort', () => this.fail(abortError(lifetime.signal)), {
      once: true,
    });
    this.keepAlive = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: 'KeepAlive' }), (error) => {
          if (error) this.fail(error);
        });
    }, binding.keepAliveMs);
  }

  async write(audio: Uint8Array, signal?: AbortSignal): Promise<void> {
    if (this.finished) throw new ProviderProtocolError('Deepgram stream is already finishing');
    if (signal?.aborted) throw abortError(signal);
    if (this.lifetime.signal.aborted) throw abortError(this.lifetime.signal);
    if (audio.byteLength < 1 || audio.byteLength > this.binding.maxInputChunkBytes)
      throw new ProviderBufferError(
        'Deepgram audio chunk is empty or exceeds the configured limit',
      );
    if (this.socket.bufferedAmount + audio.byteLength > this.binding.maxBufferedBytes) {
      const error = new ProviderBufferError(
        'Deepgram WebSocket buffer exceeded the configured limit',
      );
      this.fail(error);
      throw error;
    }
    const send = new Promise<void>((resolve, reject) => {
      this.socket.send(audio, { binary: true }, (error) => (error ? reject(error) : resolve()));
    });
    await raceAbort(send, signal, (error) => this.fail(error));
  }

  async finish(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortError(signal);
    if (!this.finished) {
      this.finished = true;
      clearInterval(this.keepAlive);
      if (this.socket.readyState === WebSocket.OPEN)
        this.socket.send(JSON.stringify({ type: 'CloseStream' }), (error) => {
          if (error) this.fail(error);
        });
    }
    const finish = raceTimeout(this.terminal.promise, this.binding.finishTimeoutMs, () => {
      this.fail(new DOMException('Deepgram finish deadline exceeded', 'TimeoutError'));
    });
    await raceAbort(finish, signal, (error) => this.fail(error));
  }

  async close(reason: string): Promise<void> {
    this.fail(new DOMException(reason || 'Deepgram stream closed', 'AbortError'));
    await this.terminal.promise.catch(() => undefined);
  }

  private onMessage(data: RawData, isBinary: boolean): void {
    if (isBinary)
      return this.fail(new ProviderProtocolError('Deepgram returned an unexpected binary frame'));
    let message: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(data.toString());
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      message = value as Record<string, unknown>;
    } catch {
      return this.fail(new ProviderProtocolError('Deepgram returned malformed JSON'));
    }
    if (message.type === 'Error')
      return this.fail(new ProviderProtocolError('Deepgram returned a protocol error'));
    this.captureMetadata(message);
    if (message.type === 'SpeechStarted') {
      this.speechStartPending = true;
      return;
    }
    if (message.type !== 'Results') return;
    const channel = record(message.channel);
    const alternatives = Array.isArray(channel?.alternatives) ? channel.alternatives : [];
    const alternative = record(alternatives[0]);
    if (typeof alternative?.transcript !== 'string' || !alternative.transcript) return;
    const revision: TranscriptRevision = {
      revision: ++this.revision,
      text: alternative.transcript,
      isFinal: message.is_final === true,
      speechFinal: message.speech_final === true,
      confidence: confidence(alternative.confidence),
      startMs: secondsToMilliseconds(message.start),
      durationMs: secondsToMilliseconds(message.duration),
      ...(this.speechStartPending ? { speechStarted: true } : {}),
    };
    this.speechStartPending = message.speech_final === true;
    try {
      this.request.onTranscript(revision);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error('Transcript callback failed'));
    }
  }

  private captureMetadata(message: Record<string, unknown>): void {
    const metadata = record(message.metadata) ?? message;
    if (typeof metadata.request_id === 'string') this.requestId = metadata.request_id;
    const duration = finiteNonnegative(message.duration ?? metadata.duration);
    if (duration !== undefined)
      this.durationSeconds = Math.max(this.durationSeconds ?? 0, duration);
  }

  private onClose(code: number, reason: string): void {
    clearInterval(this.keepAlive);
    this.emitUsage();
    this.lifetime.dispose();
    if (this.terminalError) this.terminal.reject(this.terminalError);
    else if (code === 1000 || (code === 1005 && this.finished)) this.terminal.resolve();
    else
      this.terminal.reject(
        new ProviderProtocolError(
          `Deepgram closed unexpectedly (${code}${reason ? `: ${reason}` : ''})`,
        ),
      );
  }

  private fail(error: Error): void {
    if (this.terminal.settled()) return;
    this.terminalError = error;
    clearInterval(this.keepAlive);
    this.emitUsage();
    this.lifetime.dispose();
    this.terminal.reject(error);
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    )
      this.socket.close(1000, 'client closing');
  }

  private emitUsage(): void {
    if (this.usageEmitted) return;
    this.usageEmitted = true;
    const common = {
      provider: 'deepgram' as const,
      operation: 'streaming-stt' as const,
      requestId: this.requestId,
      elapsedMs: performance.now() - this.startedAt,
    };
    const usage: ProviderUsage =
      this.durationSeconds === undefined
        ? { ...common, state: 'unavailable', unit: 'audio_seconds', missing: 'provider-omitted' }
        : {
            ...common,
            quantity: decimal(this.durationSeconds),
            unit: 'audio_seconds',
            state: 'reconciled',
          };
    this.usageSink?.(usage);
  }
}

function raceAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort: (error: Error) => void,
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    void operation.catch(() => undefined);
    const error = abortError(signal);
    onAbort(error);
    return Promise.reject(error);
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      const error = abortError(signal);
      onAbort(error);
      reject(error);
    };
    signal.addEventListener('abort', abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function raceTimeout(
  operation: Promise<void>,
  timeoutMs: number,
  timeout: () => void,
): Promise<void> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    operation,
    new Promise<void>((_, reject) => {
      timer = setTimeout(() => {
        timeout();
        reject(new DOMException('Deepgram finish deadline exceeded', 'TimeoutError'));
      }, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function confidence(value: unknown): number | undefined {
  return typeof value === 'number' && value >= 0 && value <= 1 ? value : undefined;
}

function finiteNonnegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function secondsToMilliseconds(value: unknown): number | undefined {
  const seconds = finiteNonnegative(value);
  return seconds === undefined ? undefined : Math.round(seconds * 1_000);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  let done = false;
  const promise = new Promise<T>((res, rej) => {
    resolve = (value) => {
      done = true;
      res(value);
    };
    reject = (reason) => {
      done = true;
      rej(reason);
    };
  });
  return { promise, resolve, reject, settled: () => done };
}
