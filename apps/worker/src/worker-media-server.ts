import { WebSocket } from '@winsendotai/ovo-plugin-media';
import { asEndReason, createLogger, errorFields } from '@winsendotai/ovo-plugin-kit';
import {
  MULAW_8K,
  PCM16_8K,
  PCM16_16K,
  sameFormat,
  type EndReason,
} from '@winsendotai/ovo-contracts';
import {
  parseGatewayMessage,
  type GatewayToWorkerMessage,
  type MediaSessionIdentity,
  type WorkerMediaSession,
} from '@winsendotai/ovo-plugin-media';

import { PreSessionBuffer } from './pre-session-buffer.ts';

export { attachWorkerMediaServer } from '@winsendotai/ovo-plugin-media';

const logger = createLogger({ service: 'worker' });

export class WorkerMediaLink implements WorkerMediaSession {
  readonly identity: MediaSessionIdentity;
  readonly format: Extract<GatewayToWorkerMessage, { type: 'session.open' }>['format'];
  readonly playbackEvidence: WorkerMediaSession['playbackEvidence'];
  readonly clearFlushesMarkers: WorkerMediaSession['clearFlushesMarkers'];
  readonly codec: WorkerMediaSession['codec'];
  readonly sampleRate: WorkerMediaSession['sampleRate'];
  private socket?: WebSocket;
  private activated = false;
  private closed = false;
  private endedWith?: string;
  /** Set once the worker itself starts ending the call; a racing carrier close keeps it. */
  private ending?: string;
  private readonly pending: PreSessionBuffer;
  private disconnectTimer?: NodeJS.Timeout;
  private readonly audio = new Set<(bytes: Uint8Array, at: number) => void>();
  private readonly played = new Set<(name: string) => void>();
  private readonly cleared = new Set<() => void>();
  private readonly dtmf = new Set<(digit: string) => void>();
  private readonly answeredBy = new Set<(value: 'human' | 'machine' | 'unknown') => void>();
  private answered?: 'human' | 'machine' | 'unknown';
  private readonly closeListeners = new Set<(reason: string) => void>();

  constructor(
    open: Extract<GatewayToWorkerMessage, { type: 'session.open' }>,
    socket: WebSocket,
    private readonly maxBufferedBytes = 256 * 1_024,
    private readonly resumeWindowMs = 30_000,
  ) {
    if (![MULAW_8K, PCM16_8K, PCM16_16K].some((format) => sameFormat(open.format, format)))
      throw new Error('worker media format is unsupported');
    this.identity = {
      sessionId: open.sessionId,
      carrierId: open.carrierId,
      bindingId: open.bindingId,
      carrierCallId: open.carrierCallId,
      streamId: open.streamId,
      ownerEpoch: open.ownerEpoch,
      generation: open.generation,
    };
    this.format = open.format;
    this.pending = new PreSessionBuffer(open.format);
    this.playbackEvidence = open.playbackEvidence;
    this.clearFlushesMarkers = open.clearFlushesMarkers;
    this.codec = open.format.encoding === 'pcm_s16le' ? 'audio/pcm' : 'audio/x-mulaw';
    this.sampleRate = open.format.sampleRate === 16_000 ? 16_000 : 8_000;
    this.rebind(open, socket);
  }

  get sessionId(): string {
    return this.identity.sessionId;
  }
  get bufferedBytes(): number {
    return (this.socket?.bufferedAmount ?? 0) + this.pending.bytes;
  }
  get isClosed(): boolean {
    return this.closed;
  }
  get closedReason(): string | undefined {
    return this.endedWith;
  }

  rebind(open: Extract<GatewayToWorkerMessage, { type: 'session.open' }>, socket: WebSocket): void {
    if (this.closed || open.generation < this.identity.generation)
      throw new Error('stale media rebind');
    if (
      open.sessionId !== this.identity.sessionId ||
      open.ownerEpoch !== this.identity.ownerEpoch ||
      open.carrierCallId !== this.identity.carrierCallId ||
      open.carrierId !== this.identity.carrierId ||
      open.bindingId !== this.identity.bindingId ||
      !sameFormat(open.format, this.format)
    )
      throw new Error('media rebind identity mismatch');
    if (this.socket && this.socket !== socket) this.socket.close(1001, 'superseded');
    clearTimeout(this.disconnectTimer);
    this.identity.generation = open.generation;
    this.identity.streamId = open.streamId;
    this.socket = socket;
    socket.on('message', (data, binary) => {
      // A superseded gateway can still have frames in flight after rebind.
      if (this.socket !== socket || this.closed) return;
      if (binary) return this.finish('error:binary-media-frame');
      try {
        this.receive(parseGatewayMessage(data.toString(), 65_536));
      } catch (error) {
        this.log('invalid_media_frame', error);
        this.finish('error:invalid-media-frame');
      }
    });
    socket.on('error', (error) => {
      if (this.socket !== socket || this.closed) return;
      this.log('media_transport_error', error);
      this.finish('error:media-transport');
    });
    socket.once('close', () => {
      if (this.socket !== socket || this.closed) return;
      this.socket = undefined;
      this.disconnectTimer = setTimeout(() => this.finish('ownership_lost'), this.resumeWindowMs);
      this.disconnectTimer.unref?.();
    });
  }

  activate(): void {
    this.activated = true;
    for (const event of this.pending.release()) {
      if (this.closed) return;
      this.dispatch(event);
    }
  }

  receive(message: GatewayToWorkerMessage): void {
    if (this.closed) return;
    if (message.type === 'session.open') throw new Error('duplicate session.open');
    if (message.type === 'session.close') return this.gatewayClosed(message.reason);
    // Only caller input is held until the voice session opens. The verdict gates the opening, which
    // plays before activation, and marks and clears answer that opening's output.
    if (this.activated || (message.type !== 'media.audio' && message.type !== 'media.dtmf'))
      return this.dispatch(message);
    const dropped = this.pending.hold(message);
    if (dropped === false) return this.finish('error:worker-input-buffer-overflow');
    if (dropped)
      logger.warn('pre_session_audio_dropped', {
        sessionId: this.identity.sessionId,
        generation: this.identity.generation,
        droppedBytes: dropped,
        keptBytes: this.pending.bytes,
      });
  }

  private dispatch(message: Exclude<GatewayToWorkerMessage, { type: 'session.open' }>): void {
    if (message.type === 'media.audio') {
      const bytes = Buffer.from(message.payload, 'base64');
      for (const listener of this.audio) listener(bytes, message.timestampMs);
    } else if (message.type === 'media.played') {
      for (const listener of this.played) listener(message.name);
    } else if (message.type === 'media.cleared') {
      for (const listener of this.cleared) listener();
    } else if (message.type === 'media.dtmf') {
      for (const listener of this.dtmf) listener(message.digit);
    } else if (message.type === 'call.answered-by') {
      this.answer(message.value);
    } else if (message.type === 'session.close') this.gatewayClosed(message.reason);
  }

  /**
   * The gateway forwards the carrier's stop reason, `carrier stream-ended` on a hang-up, which
   * finalization must see as caller_hangup rather than an error. A call the worker was already
   * ending keeps the worker's own reason.
   */
  private gatewayClosed(reason: string): void {
    this.finish(this.ending ?? asEndReason(reason));
  }

  async sendAudio(bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    if (!bytes.length || bytes.length > 65_536) throw new Error('audio frame exceeds limit');
    await this.send({ type: 'audio', payload: Buffer.from(bytes).toString('base64') }, signal);
  }
  mark(name: string, signal?: AbortSignal): Promise<void> {
    return this.send({ type: 'mark', name }, signal);
  }
  sendMark(name: string, signal?: AbortSignal): Promise<void> {
    return this.mark(name, signal);
  }
  clear(signal?: AbortSignal): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.send({ type: 'clear' }, signal);
  }
  async close(reason: string): Promise<void> {
    if (this.closed) return;
    this.ending ??= reason;
    try {
      await this.send({ type: 'session.end', reason });
    } finally {
      this.finish(reason);
    }
  }
  async terminate(reason: EndReason): Promise<void> {
    if (this.closed) return;
    this.ending ??= reason;
    try {
      await this.send({ type: 'session.end', reason: 'terminate' });
    } finally {
      this.finish(reason);
    }
  }
  private async send(message: object, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const socket = this.socket;
    if (this.closed || !socket || socket.readyState !== WebSocket.OPEN)
      throw new Error('media link is unavailable');
    if (socket.bufferedAmount > this.maxBufferedBytes) throw new Error('media backpressure limit');
    await new Promise<void>((resolve, reject) =>
      socket.send(JSON.stringify(message), (error) => (error ? reject(error) : resolve())),
    );
  }
  private subscribe<T>(listeners: Set<T>, listener: T): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
  onAudio(fn: (bytes: Uint8Array, at: number) => void): () => void {
    return this.subscribe(this.audio, fn);
  }
  onPlayed(fn: (name: string) => void): () => void {
    return this.subscribe(this.played, fn);
  }
  onMark(fn: (name: string) => void): () => void {
    return this.onPlayed(fn);
  }
  onCleared(fn: () => void): () => void {
    return this.subscribe(this.cleared, fn);
  }
  onDtmf(fn: (digit: string) => void): () => void {
    return this.subscribe(this.dtmf, fn);
  }
  /** The carrier's answering-machine verdict, once; a subscriber that arrives later still hears it. */
  onAnsweredBy(fn: (value: 'human' | 'machine' | 'unknown') => void): () => void {
    const known = this.answered;
    if (known) queueMicrotask(() => this.answeredBy.has(fn) && fn(known));
    return this.subscribe(this.answeredBy, fn);
  }
  private answer(value: 'human' | 'machine' | 'unknown'): void {
    if (this.answered) return;
    this.answered = value;
    for (const listener of this.answeredBy) listener(value);
  }
  onClose(fn: (reason: string) => void): () => void {
    return this.subscribe(this.closeListeners, fn);
  }
  finish(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.endedWith = reason;
    clearTimeout(this.disconnectTimer);
    // Reserve three bytes for a replacement character at a truncated UTF-8 boundary.
    try {
      this.socket?.close(1000, Buffer.from(reason).subarray(0, 120).toString());
    } finally {
      this.socket = undefined;
      for (const listener of this.closeListeners) listener(reason);
    }
  }

  private log(event: string, error: unknown): void {
    logger.error(event, {
      sessionId: this.identity.sessionId,
      generation: this.identity.generation,
      ...errorFields(error),
    });
  }
}
