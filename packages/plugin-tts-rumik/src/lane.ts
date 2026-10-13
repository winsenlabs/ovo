import type { AudioFormat } from '@winsendotai/ovo-contracts';
import { abortError, decimal, untilAborted, usageOnce } from '@winsendotai/ovo-plugin-kit';
import { RumikTtsError, httpMayHelp } from './errors.ts';
import { Generation, runOnSocket, type Submission } from './generation.ts';
import { renderHttp, type HttpPort } from './http.ts';
import { mintLease } from './mint.ts';
import { connectSocket, type RumikSocket } from './socket.ts';

export { CANCEL_ACK_MS, type Submission } from './generation.ts';

/** After a failed mint or connect, generations use HTTP for this long instead of waiting again. */
const SOCKET_RETRY_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;

/**
 * The session's generation queue for one output format (R3). Silk renders one generation at a time
 * per socket, and a second text frame would interrupt the first ("latest-wins"), so `synthesize`
 * and reply segments wait here in order and each is sent only after the previous one's `done`,
 * `cancelled` or error. The socket is minted lazily (or by `warm`) and minted again after any
 * close, timeout or fatal error. HTTP covers a socket that cannot be had.
 */
export class GenerationLane {
  private readonly queue: Generation[] = [];
  private readonly closing = new AbortController();
  private current?: Generation;
  private socket?: RumikSocket;
  private opening?: Promise<RumikSocket>;
  private busy = false;
  private downUntil = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly port: HttpPort,
    private readonly format: AudioFormat,
  ) {}

  /** Queues one generation; its audio is buffered as it arrives, read or not. */
  submit(request: Submission): AsyncIterable<Uint8Array> {
    const job = new Generation(request);
    const onAbort = () => this.stop(job, abortError(request.signal));
    const onQuiet = () => this.stop(job);
    request.signal.addEventListener('abort', onAbort, { once: true });
    request.quiet?.addEventListener('abort', onQuiet, { once: true });
    job.detach = () => {
      request.signal.removeEventListener('abort', onAbort);
      request.quiet?.removeEventListener('abort', onQuiet);
    };
    this.queue.push(job);
    if (request.signal.aborted) onAbort();
    else if (request.quiet?.aborted) onQuiet();
    void this.pump();
    return job.out.read(() => this.stop(job));
  }

  /** Mints and connects ahead of the first generation. Rejects on failure; the caller swallows. */
  async warm(): Promise<void> {
    if (this.port.binding.transport !== 'http') await this.open();
  }

  /** Session end: queued generations end, the running one stops, the socket gets `close`. */
  dispose(): void {
    const closed = new RumikTtsError('Rumik TTS session closed', true);
    this.closing.abort(closed);
    for (const job of this.queue.splice(0)) this.stop(job, closed, false);
    if (this.current) this.stop(this.current, closed, false);
    this.socket?.close();
  }

  /** Ends a generation's audio now; a running one is cancelled at Rumik (`{"type":"cancel"}`). */
  private stop(job: Generation, error?: unknown, cancelAtProvider = true): void {
    job.out.stop(error);
    if (job.state === 'queued') {
      job.state = 'ended';
      job.detach();
    } else if (job.state === 'running') {
      job.controller.abort(error ?? new DOMException('Rumik TTS reply closed', 'AbortError'));
      if (cancelAtProvider) job.cancel?.();
    }
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (let job = this.queue.shift(); job; job = this.queue.shift())
        if (job.state === 'queued') await this.run(job);
    } finally {
      this.busy = false;
    }
  }

  private async run(job: Generation): Promise<void> {
    const { binding, clock } = this.port;
    this.current = job;
    job.state = 'running';
    job.startedAt = clock.now();
    const signal = job.controller.signal;
    try {
      const socket = await this.socketFor(job);
      const run = { binding, clock, format: this.format };
      if (socket && (await runOnSocket(socket, job, run)) === 'done') return;
      signal.throwIfAborted();
      this.closing.signal.throwIfAborted();
      await renderHttp(this.port, {
        spoken: job.request.spoken,
        ...(job.request.voice ? { voice: job.request.voice } : {}),
        format: this.format,
        requestId: job.request.requestId,
        signal,
        accepted: () => (job.sent = true),
        audio: (bytes) => {
          job.heard = true;
          job.out.push(bytes);
        },
      });
      job.out.end();
    } catch (error) {
      if (!signal.aborted) {
        this.port.logger?.warn('rumik.tts.failed', {
          requestId: job.request.requestId,
          ...(error instanceof RumikTtsError ? { status: error.status, code: error.code } : {}),
          transport: binding.transport ?? 'websocket',
        });
        job.out.stop(error);
      }
    } finally {
      this.settle(job);
    }
  }

  /** Exactly one estimated meter per billed generation, whatever ended it. */
  private settle(job: Generation): void {
    job.state = 'ended';
    job.detach();
    if (this.current === job) this.current = undefined;
    if (!job.out.closed) job.out.end();
    if (!job.sent) return;
    usageOnce(job.request.onUsage).emit({
      provider: 'rumik',
      operation: 'tts',
      unit: 'characters',
      quantity: decimal(job.free ? 0 : job.request.characters),
      state: 'estimated',
      requestId: job.request.requestId,
      elapsedMs: Math.max(0, this.port.clock.now() - job.startedAt),
    });
  }

  /** The open socket, or undefined when this generation goes over HTTP. */
  private async socketFor(job: Generation): Promise<RumikSocket | undefined> {
    const { binding, clock } = this.port;
    if (binding.transport === 'http' || clock.now() < this.downUntil) return undefined;
    try {
      return await untilAborted(this.open(), job.controller.signal);
    } catch (error) {
      if (job.controller.signal.aborted || binding.httpFallback === false || !httpMayHelp(error))
        throw error;
      this.downUntil = clock.now() + SOCKET_RETRY_MS;
      this.port.logger?.warn('rumik.tts.socket_unavailable', {
        ...(error instanceof RumikTtsError ? { status: error.status, code: error.code } : {}),
      });
      return undefined;
    }
  }

  private open(): Promise<RumikSocket> {
    if (this.socket?.usable) return Promise.resolve(this.socket);
    if (!this.opening) {
      const opening = this.connect();
      const clear = () => {
        if (this.opening === opening) this.opening = undefined;
      };
      opening.then(clear, clear);
      this.opening = opening;
    }
    return this.opening;
  }

  private async connect(): Promise<RumikSocket> {
    const { binding, clock } = this.port;
    const timeoutMs = binding.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const signal = this.closing.signal;
    const mint = () => mintLease(this.port, this.format, signal, timeoutMs);
    let lease = await mint();
    // The token is single-use and redeemable for `expires_in` seconds: a stale one is minted again.
    if (clock.now() >= lease.expiresAt) lease = await mint();
    if (clock.now() >= lease.expiresAt)
      throw new RumikTtsError('Rumik ws-connect returned an expired token', true);
    const socket = await connectSocket(
      this.port.net,
      lease.url,
      { clock, timeoutMs, signal },
      this.port.logger,
    );
    if (signal.aborted) socket.close();
    else this.socket = socket;
    return socket;
  }
}
