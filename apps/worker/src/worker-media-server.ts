import { WebSocket } from '@winsendotai/ovo-plugin-media';
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
export { attachWorkerMediaServer } from '@winsendotai/ovo-plugin-media';

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
  private readonly pending: GatewayToWorkerMessage[] = [];
  private pendingAudioBytes = 0;
  private disconnectTimer?: NodeJS.Timeout;
  private readonly audio = new Set<(bytes: Uint8Array, at: number) => void>();
  private readonly played = new Set<(name: string) => void>();
  private readonly cleared = new Set<() => void>();
  private readonly dtmf = new Set<(digit: string) => void>();
  private readonly answeredBy = new Set<(value: 'human' | 'machine' | 'unknown') => void>();
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
    return (this.socket?.bufferedAmount ?? 0) + this.pendingAudioBytes;
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
      } catch {
        this.finish('error:invalid-media-frame');
      }
    });
    socket.on('error', () => {
      if (this.socket === socket && !this.closed) this.finish('error:media-transport');
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
    for (const event of this.pending.splice(0))
      if (event.type !== 'session.open') this.dispatch(event);
    this.pendingAudioBytes = 0;
  }

  receive(message: GatewayToWorkerMessage): void {
    if (this.closed) return;
    if (message.type === 'session.open') throw new Error('duplicate session.open');
    if (message.type === 'session.close') return this.finish(message.reason);
    if (!this.activated) {
      const size =
        message.type === 'media.audio' ? Buffer.from(message.payload, 'base64').length : 0;
      const limit = Math.min(
        this.format.sampleRate * (this.format.encoding === 'pcm_s16le' ? 6 : 3),
        196_608,
      );
      if (this.pendingAudioBytes + size > limit || this.pending.length >= 1_024)
        return this.finish('error:worker-input-buffer-overflow');
      this.pending.push(message);
      this.pendingAudioBytes += size;
      return;
    }
    this.dispatch(message);
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
      for (const listener of this.answeredBy) listener(message.value);
    } else if (message.type === 'session.close') this.finish(message.reason);
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
    try {
      await this.send({ type: 'session.end', reason });
    } finally {
      this.finish(reason);
    }
  }
  async terminate(reason: EndReason): Promise<void> {
    if (this.closed) return;
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
  onAnsweredBy(fn: (value: 'human' | 'machine' | 'unknown') => void): () => void {
    return this.subscribe(this.answeredBy, fn);
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
}
