import { FrameAggregator } from '@winsendotai/ovo-audio';
import {
  bytesPerSecond,
  type Clock,
  type SpeechToText,
  type SttSession,
  type WebSocketLike,
} from '@winsendotai/ovo-contracts';
import { decimal, syntheticRequestId, usageOnce } from '@winsendotai/ovo-plugin-kit';
import type { SarvamSttBinding } from './stt.ts';

type Input = Parameters<SpeechToText['start']>[0];
type SessionState = 'connecting' | 'active' | 'finishing' | 'ended';

export class SarvamSttError extends Error {
  constructor(
    message: string,
    readonly code: number | string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'SarvamSttError';
  }
}

/** JSON audio and events share one closure so socket, abort and idle timer terminate together. */
export function createSarvamSttSession(
  socket: WebSocketLike,
  input: Input,
  binding: Readonly<SarvamSttBinding>,
  clock: Clock,
): SttSession & { ready: Promise<void> } {
  const startedAt = clock.now();
  const usage = usageOnce(input.onUsage);
  const frames = new FrameAggregator(input.format, 100);
  const ready = Promise.withResolvers<void>();
  const done = Promise.withResolvers<void>();
  void ready.promise.catch(() => undefined);
  void done.promise.catch(() => undefined);
  const offs: Array<() => void> = [];
  let cancelPing: (() => void) | undefined;
  let state: SessionState = 'connecting';
  let bytes = 0;
  let revision = 0;
  let turn = 0;
  let requestId: string | undefined;
  let billedDuration: number | undefined;

  const meter = () =>
    usage.emit({
      provider: 'sarvam',
      operation: 'stt',
      unit: 'audio_seconds',
      quantity: decimal(billedDuration ?? bytes / bytesPerSecond(input.format)),
      state: billedDuration === undefined ? 'estimated' : 'reconciled',
      requestId: requestId ?? syntheticRequestId('sarvam', input.sessionId, 1),
      elapsedMs: Math.max(0, clock.now() - startedAt),
    });
  const dispose = () => {
    cancelPing?.();
    for (const off of offs.splice(0)) off();
  };
  const stop = (error?: Error, closeSocket = false) => {
    if (state === 'ended') return;
    const wasConnecting = state === 'connecting';
    state = 'ended';
    meter();
    dispose();
    if (error) {
      if (wasConnecting) ready.reject(error);
      done.reject(error);
    } else {
      if (wasConnecting) ready.resolve();
      done.resolve();
    }
    if (closeSocket) socket.close();
  };
  const sendAudio = (audio: Uint8Array) => {
    let raw = '';
    for (const byte of audio) raw += String.fromCharCode(byte);
    socket.send(JSON.stringify({ event: 'audio_input', audio: btoa(raw) }));
  };
  const flushAudio = () => {
    const tail = frames.flush({ padToMs: 20 });
    if (tail) sendAudio(tail);
  };
  const ping = () => {
    if (state === 'ended' || socket.readyState !== 1) return;
    try {
      socket.send(JSON.stringify({ event: 'ping' }));
      cancelPing = clock.setTimeout(ping, 45_000);
    } catch (error) {
      stop(error as Error, true);
    }
  };
  const sessionEnd = (value: Record<string, unknown>) => {
    const duration = positiveDuration(value.audio_duration_s);
    if (duration === undefined) {
      stop(new SarvamSttError('session.end has no audio_duration_s', 'protocol', false), true);
      return;
    }
    billedDuration = duration;
    stop();
  };
  const parse = (raw: string | Uint8Array, binary: boolean) => {
    if (binary) return stop(new SarvamSttError('binary response', 'protocol', false), true);
    let value: Record<string, unknown>;
    try {
      value = readJsonObject(String(raw));
    } catch {
      return stop(new SarvamSttError('malformed response', 'protocol', false), true);
    }
    if (value.event === 'session.begin') {
      if (state !== 'connecting')
        return stop(new SarvamSttError('duplicate session.begin', 'protocol', false), true);
      if (typeof value.session_id === 'string' && value.session_id) requestId = value.session_id;
      state = 'active';
      ready.resolve();
      cancelPing = clock.setTimeout(ping, 45_000);
      return;
    }
    if (state === 'connecting')
      return stop(new SarvamSttError('message before session.begin', 'protocol', false), true);
    if (value.event === 'vad.speech_start') input.onEvent({ type: 'speech-start' });
    else if (value.event === 'vad.speech_end') input.onEvent({ type: 'speech-end' });
    else if (value.event === 'transcript.partial' || value.event === 'transcript.final') {
      if (typeof value.text !== 'string')
        return stop(new SarvamSttError('transcript has no text', 'protocol', false), true);
      const final = value.event === 'transcript.final';
      input.onEvent({
        type: 'transcript',
        segment: {
          segmentId: String(turn),
          revision: ++revision,
          text: value.text,
          stability: final ? 'final' : 'interim',
          ...(typeof value.language === 'string' ? { language: value.language } : {}),
        },
      });
      if (final) {
        input.onEvent({ type: 'end-of-turn' });
        turn += 1;
      }
    } else if (value.event === 'session.end') sessionEnd(value);
    else if (value.event === 'ping') socket.send(JSON.stringify({ event: 'pong' }));
    else if (value.event === 'error') {
      if (value.is_fatal !== false) stop(providerFailure(value), true);
    }
  };
  offs.push(
    socket.on('message', parse),
    socket.on('close', (code, reason) =>
      stop(new SarvamSttError(`Sarvam STT closed (${code}): ${reason}`, code, code === 1011)),
    ),
    socket.on('error', (error) => stop(error, true)),
  );
  const abort = () => stop(new DOMException('Sarvam STT aborted', 'AbortError'), true);
  input.signal.addEventListener('abort', abort, { once: true });
  offs.push(() => input.signal.removeEventListener('abort', abort));

  const writable = (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    input.signal.throwIfAborted();
    if (state !== 'active' || socket.readyState !== 1)
      throw new Error('Sarvam STT session is no longer writable');
  };
  const session: SttSession & { ready: Promise<void> } = {
    ready: ready.promise,
    async write(frame, signal) {
      writable(signal);
      if (!frame.byteLength) throw new TypeError('Sarvam STT audio frame is empty');
      bytes += frame.byteLength;
      for (const audio of frames.push(frame)) sendAudio(audio);
    },
    async finish(signal) {
      signal?.throwIfAborted();
      if (state === 'active') {
        state = 'finishing';
        flushAudio();
        socket.send(JSON.stringify({ event: 'end' }));
      }
      const onAbort = () => stop(new DOMException('Sarvam STT finish aborted', 'AbortError'), true);
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        await done.promise;
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    },
    async cancel() {
      stop(undefined, true);
    },
  };
  if (binding.endpointing === 'manual')
    session.forceEndpoint = async () => {
      writable();
      flushAudio();
      socket.send(JSON.stringify({ event: 'flush' }));
    };
  return session;
}

function positiveDuration(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function providerFailure(frame: Record<string, unknown>): SarvamSttError {
  const code =
    typeof frame.code === 'string' || typeof frame.code === 'number' ? frame.code : 'unknown';
  return new SarvamSttError(
    String(frame.message ?? 'Sarvam STT error'),
    code,
    frame.is_fatal === false,
  );
}

function readJsonObject(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw);
  if (value === null || Array.isArray(value) || typeof value !== 'object')
    throw new TypeError('Sarvam STT expected a JSON object');
  return value as Record<string, unknown>;
}
