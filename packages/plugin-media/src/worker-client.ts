import type { GatewayToWorkerMessage, MediaSessionIdentity } from './ports.ts';

export interface WorkerGatewayClientConfig {
  url: string;
  workerId: string;
  token: string;
  maxBufferedBytes?: number;
  maxPendingFrames?: number;
  backpressureTimeoutMs?: number;
  maxAudioFrameBytes?: number;
  onDisconnect?: (reason: string) => void;
}

import { WorkerMediaSession } from './worker-media-session.ts';
export { WorkerMediaSession } from './worker-media-session.ts';

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
      maxPendingFrames: config.maxPendingFrames ?? 25,
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
        if (session.isClosed) return;
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
        await session.accept();
      } catch (error) {
        await session
          .close(error instanceof Error ? error.message : 'session initialization failed')
          .catch(() => undefined);
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
