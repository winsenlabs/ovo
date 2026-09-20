import type {
  GatewayToWorkerMessage,
  MediaDuplex,
  MediaSessionIdentity,
  WorkerToGatewayMessage,
} from './ports.ts';

export interface WorkerGatewayClientConfig {
  url: string;
  workerId: string;
  token: string;
  maxBufferedBytes?: number;
  backpressureTimeoutMs?: number;
  maxAudioFrameBytes?: number;
  onDisconnect?: (reason: string) => void;
}

export class WorkerMediaSession implements MediaDuplex {
  readonly codec = 'audio/x-mulaw' as const;
  readonly sampleRate = 8000 as const;
  private readonly audioListeners = new Set<(audio: Uint8Array, timestampMs: number) => void>();
  private readonly markListeners = new Set<(name: string) => void>();
  private readonly dtmfListeners = new Set<(digit: string) => void>();
  private readonly closeListeners = new Set<(reason: string) => void>();
  private closed = false;

  constructor(
    readonly identity: MediaSessionIdentity,
    private readonly socket: WebSocket,
    private readonly limits: {
      maxBufferedBytes: number;
      backpressureTimeoutMs: number;
      maxAudioFrameBytes: number;
    },
  ) {}

  get sessionId(): string {
    return this.identity.callSid;
  }
  get bufferedBytes(): number {
    return this.socket.bufferedAmount;
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
    await this.send({ type: 'session.close', ...this.identity, reason });
    this.finish(reason);
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
    for (const listener of this.closeListeners) listener(reason);
    this.audioListeners.clear();
    this.markListeners.clear();
    this.dtmfListeners.clear();
    this.closeListeners.clear();
  }

  private async send(message: WorkerToGatewayMessage, signal?: AbortSignal): Promise<void> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN)
      throw new Error('media session is closed');
    const deadline = Date.now() + this.limits.backpressureTimeoutMs;
    while (this.socket.bufferedAmount > this.limits.maxBufferedBytes) {
      signal?.throwIfAborted();
      if (Date.now() >= deadline) throw new Error('worker media backpressure deadline exceeded');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    signal?.throwIfAborted();
    this.socket.send(JSON.stringify(message));
  }
}

export class WorkerGatewayClient {
  private socket?: WebSocket;
  private readonly sessions = new Map<string, WorkerMediaSession>();
  private readonly limits;

  constructor(
    private readonly config: WorkerGatewayClientConfig,
    private readonly onSession: (session: WorkerMediaSession) => void | Promise<void>,
  ) {
    this.limits = {
      maxBufferedBytes: config.maxBufferedBytes ?? 256 * 1024,
      backpressureTimeoutMs: config.backpressureTimeoutMs ?? 2_000,
      maxAudioFrameBytes: config.maxAudioFrameBytes ?? 8 * 1024,
    };
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.socket) throw new Error('worker gateway client already connected');
    const socket = new WebSocket(this.config.url);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal?.reason ?? new DOMException('aborted', 'AbortError'));
      signal?.addEventListener('abort', abort, { once: true });
      socket.addEventListener(
        'open',
        () => {
          signal?.removeEventListener('abort', abort);
          socket.send(
            JSON.stringify({
              type: 'worker.hello',
              workerId: this.config.workerId,
              token: this.config.token,
            }),
          );
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        'error',
        () => reject(new Error('worker WebSocket connection failed')),
        { once: true },
      );
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker authentication timed out')), 5_000);
      const onMessage = (event: MessageEvent) => {
        const message = JSON.parse(String(event.data)) as GatewayToWorkerMessage;
        if (message.type !== 'worker.ready' || message.workerId !== this.config.workerId) return;
        clearTimeout(timer);
        socket.removeEventListener('message', onMessage);
        resolve();
      };
      socket.addEventListener('message', onMessage);
      socket.addEventListener(
        'close',
        () => {
          clearTimeout(timer);
          reject(new Error('gateway closed before worker authentication'));
        },
        { once: true },
      );
    });
    socket.addEventListener('message', (event) => void this.receive(String(event.data)));
    socket.addEventListener('close', (event) => {
      const reason = event.reason || 'gateway disconnected';
      this.finish(reason);
      this.config.onDisconnect?.(reason);
    });
  }

  async close(reason = 'worker client closed'): Promise<void> {
    this.finish(reason);
    this.socket?.close(1000, reason);
    this.socket = undefined;
  }

  private async receive(raw: string): Promise<void> {
    const message = JSON.parse(raw) as GatewayToWorkerMessage;
    if (message.type === 'worker.ready') return;
    if (message.type === 'session.open') {
      if (message.ownerId !== this.config.workerId || this.sessions.has(message.streamSid)) return;
      const session = new WorkerMediaSession(
        {
          sessionId: message.sessionId,
          callSid: message.callSid,
          streamSid: message.streamSid,
          ownerId: message.ownerId,
          ownerEpoch: message.ownerEpoch,
          generation: message.generation,
        },
        this.socket!,
        this.limits,
      );
      this.sessions.set(message.streamSid, session);
      session.onClose(() => this.sessions.delete(message.streamSid));
      try {
        await this.onSession(session);
        this.socket!.send(
          JSON.stringify({
            type: 'session.accept',
            sessionId: message.sessionId,
            callSid: message.callSid,
            streamSid: message.streamSid,
            ownerId: message.ownerId,
            ownerEpoch: message.ownerEpoch,
            generation: message.generation,
          }),
        );
      } catch (error) {
        await session.close(
          error instanceof Error ? error.message : 'session initialization failed',
        );
      }
      return;
    }
    const session = this.sessions.get(message.streamSid);
    if (session && sameSession(session.identity, message)) session.receive(message);
  }

  private finish(reason: string): void {
    for (const session of this.sessions.values()) session.finish(reason);
    this.sessions.clear();
  }
}

function sameSession(a: MediaSessionIdentity, b: MediaSessionIdentity): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.callSid === b.callSid &&
    a.streamSid === b.streamSid &&
    a.ownerId === b.ownerId &&
    a.ownerEpoch === b.ownerEpoch &&
    a.generation === b.generation
  );
}
