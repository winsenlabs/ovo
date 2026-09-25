import type {
  GatewayToWorkerMessage,
  MediaDuplex,
  MediaSessionIdentity,
  WorkerToGatewayMessage,
} from './ports.ts';

export class WorkerMediaSession implements MediaDuplex {
  readonly codec = 'audio/x-mulaw' as const;
  readonly sampleRate = 8000 as const;
  private readonly audioListeners = new Set<(audio: Uint8Array, timestampMs: number) => void>();
  private readonly markListeners = new Set<(name: string) => void>();
  private readonly dtmfListeners = new Set<(digit: string) => void>();
  private readonly closeListeners = new Set<(reason: string) => void>();
  private closed = false;
  private accepted = false;
  private readonly pending: { encoded: string; signal?: AbortSignal }[] = [];
  private pendingBytes = 0;
  private flushing: Promise<void> = Promise.resolve();

  constructor(
    readonly identity: MediaSessionIdentity,
    private readonly socket: WebSocket,
    private readonly limits: {
      maxBufferedBytes: number;
      maxPendingFrames: number;
      backpressureTimeoutMs: number;
      maxAudioFrameBytes: number;
    },
  ) {}

  get sessionId(): string {
    return this.identity.callSid;
  }
  get bufferedBytes(): number {
    return this.socket.bufferedAmount + this.pendingBytes;
  }
  get isClosed(): boolean {
    return this.closed;
  }

  /** Called immediately after session.accept is written to the worker socket. */
  async accept(): Promise<void> {
    if (this.closed) return;
    this.accepted = true;
    const pending = this.pending.splice(0);
    this.pendingBytes = 0;
    this.flushing = (async () => {
      for (const frame of pending) await this.write(frame.encoded, frame.signal);
    })();
    await this.flushing;
  }

  async sendAudio(audio: Uint8Array, signal?: AbortSignal): Promise<void> {
    if (audio.length === 0 || audio.length > this.limits.maxAudioFrameBytes)
      throw new Error('audio frame exceeds limit');
    await this.send(
      { type: 'media.audio', ...this.identity, payload: Buffer.from(audio).toString('base64') },
      signal,
    );
  }
  async sendMark(name: string, signal?: AbortSignal): Promise<void> {
    await this.send({ type: 'media.mark', ...this.identity, name }, signal);
  }
  async clear(signal?: AbortSignal): Promise<void> {
    if (this.closed) return;
    await this.send({ type: 'media.clear', ...this.identity }, signal);
  }
  async close(reason: string): Promise<void> {
    if (this.closed) return;
    try {
      await this.send({ type: 'session.close', ...this.identity, reason });
    } finally {
      this.finish(reason);
    }
  }
  onAudio(listener: (audio: Uint8Array, timestampMs: number) => void): () => void {
    this.audioListeners.add(listener);
    return () => this.audioListeners.delete(listener);
  }
  onMark(listener: (name: string) => void): () => void {
    this.markListeners.add(listener);
    return () => this.markListeners.delete(listener);
  }
  onDtmf(listener: (digit: string) => void): () => void {
    this.dtmfListeners.add(listener);
    return () => this.dtmfListeners.delete(listener);
  }
  onClose(listener: (reason: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  receive(message: GatewayToWorkerMessage): void {
    if (message.type === 'media.audio') {
      const bytes = Buffer.from(message.payload, 'base64');
      if (bytes.length > this.limits.maxAudioFrameBytes)
        return this.finish('inbound audio frame exceeds limit');
      for (const listener of this.audioListeners) listener(bytes, message.timestampMs);
    } else if (message.type === 'media.mark') {
      for (const listener of this.markListeners) listener(message.name);
    } else if (message.type === 'media.dtmf') {
      for (const listener of this.dtmfListeners) listener(message.digit);
    } else if (message.type === 'session.stop' || message.type === 'session.cancel') {
      this.finish(message.reason);
    }
  }

  finish(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.pending.length = 0;
    this.pendingBytes = 0;
    for (const listener of this.closeListeners) listener(reason);
    this.audioListeners.clear();
    this.markListeners.clear();
    this.dtmfListeners.clear();
    this.closeListeners.clear();
  }

  private async send(message: WorkerToGatewayMessage, signal?: AbortSignal): Promise<void> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN)
      throw new Error('media session is closed');
    signal?.throwIfAborted();
    const encoded = JSON.stringify(message);
    if (!this.accepted && message.type !== 'session.close') {
      const bytes = Buffer.byteLength(encoded);
      if (
        this.pending.length >= this.limits.maxPendingFrames ||
        this.pendingBytes + bytes > this.limits.maxBufferedBytes
      ) {
        await this.close('pre-accept media buffer exceeded');
        throw new Error('pre-accept media buffer exceeded');
      }
      this.pending.push({ encoded, signal });
      this.pendingBytes += bytes;
      return;
    }
    if (message.type === 'session.close') await this.flushing.catch(() => undefined);
    else await this.flushing;
    await this.write(encoded, signal);
  }

  private async write(encoded: string, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.limits.backpressureTimeoutMs;
    while (this.socket.bufferedAmount > this.limits.maxBufferedBytes) {
      if (this.closed) throw new Error('media session is closed');
      signal?.throwIfAborted();
      if (Date.now() >= deadline) throw new Error('worker media backpressure deadline exceeded');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (this.closed || this.socket.readyState !== WebSocket.OPEN)
      throw new Error('media session is closed');
    signal?.throwIfAborted();
    this.socket.send(encoded);
  }
}
