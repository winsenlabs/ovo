import { createSocket, type Socket } from 'node:dgram';
import { SIP_LIMITS } from './parse.ts';

export interface DatagramHandler {
  /** Checked on the raw source before any byte is parsed (§4.7); false drops silently. */
  allow(address: string): boolean;
  onDatagram(data: Buffer, source: { address: string; port: number }): void;
  onDrop(reason: 'unknown_source' | 'oversize', address: string): void;
}

/** SIP over UDP on one socket; responses and requests both leave from it (symmetric, RFC 3581). */
export class UdpTransport {
  private readonly socket: Socket;

  private constructor(socket: Socket) {
    this.socket = socket;
  }

  static listen(address: string, port: number, handler: DatagramHandler): Promise<UdpTransport> {
    const socket = createSocket({ type: 'udp4', recvBufferSize: 1 << 20 });
    return new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.bind({ address, port, exclusive: true }, () => {
        socket.off('error', reject);
        socket.on('error', () => undefined);
        socket.on('message', (data, rinfo) => {
          if (!handler.allow(rinfo.address)) return handler.onDrop('unknown_source', rinfo.address);
          if (data.length > SIP_LIMITS.udpBytes) return handler.onDrop('oversize', rinfo.address);
          handler.onDatagram(data, { address: rinfo.address, port: rinfo.port });
        });
        resolve(new UdpTransport(socket));
      });
    });
  }

  get port(): number {
    return this.socket.address().port;
  }

  send(bytes: Uint8Array, address: string, port: number): void {
    this.socket.send(bytes, port, address);
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      try {
        this.socket.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }
}
