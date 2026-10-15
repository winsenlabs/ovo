import { createSocket, type Socket } from 'node:dgram';
import type { Clock } from '@winsendotai/ovo-contracts';

/** One RTP/RTCP pair: an even RTP port and RTCP on the next odd port (RFC 3550 §11). */
export interface RtpPair {
  port: number;
  rtp: Socket;
  rtcp: Socket;
}

export interface PoolStats {
  inUse: number;
  free: number;
  quarantined: number;
}

export const QUARANTINE_MS = 10_000;

function bind(socket: Socket, port: number, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    socket.once('error', onError);
    socket.bind({ port, address, exclusive: true }, () => {
      socket.off('error', onError);
      resolve();
    });
  });
}

function safeClose(socket: Socket): void {
  try {
    socket.close();
  } catch {
    // swallow-ok: a socket that failed to bind or errored is already closed.
  }
}

/**
 * Even ports from [min, max] with a free list. A released pair is quarantined for 10 s so late
 * packets of the old call cannot reach the next one; a port the OS refuses is skipped.
 */
export class RtpSocketPool {
  private readonly free: number[] = [];
  private readonly quarantine = new Map<number, () => void>();
  private readonly used = new Map<number, RtpPair>();

  constructor(
    private readonly options: { address: string; min: number; max: number; clock: Clock },
  ) {
    const first = options.min % 2 === 0 ? options.min : options.min + 1;
    for (let port = first; port + 1 <= options.max; port += 2) this.free.push(port);
    if (!this.free.length) throw new RangeError('The RTP port range holds no even/odd pair');
  }

  stats(): PoolStats {
    return { inUse: this.used.size, free: this.free.length, quarantined: this.quarantine.size };
  }

  get capacity(): number {
    return this.free.length + this.used.size + this.quarantine.size;
  }

  async acquire(): Promise<RtpPair | undefined> {
    for (let attempts = this.free.length; attempts > 0; attempts -= 1) {
      const port = this.free.shift()!;
      const rtp = createSocket({ type: 'udp4', recvBufferSize: 256 * 1024 });
      const rtcp = createSocket('udp4');
      try {
        await bind(rtp, port, this.options.address);
        await bind(rtcp, port + 1, this.options.address);
        const pair = { port, rtp, rtcp };
        this.used.set(port, pair);
        return pair;
      } catch {
        safeClose(rtp);
        safeClose(rtcp);
        this.free.push(port);
      }
    }
    return undefined;
  }

  release(pair: RtpPair): void {
    if (!this.used.delete(pair.port)) return;
    for (const socket of [pair.rtp, pair.rtcp]) {
      socket.removeAllListeners('message');
      safeClose(socket);
    }
    this.quarantine.set(
      pair.port,
      this.options.clock.setTimeout(() => {
        this.quarantine.delete(pair.port);
        this.free.push(pair.port);
      }, QUARANTINE_MS),
    );
  }

  close(): void {
    for (const pair of [...this.used.values()]) this.release(pair);
    for (const cancel of this.quarantine.values()) cancel();
  }
}
