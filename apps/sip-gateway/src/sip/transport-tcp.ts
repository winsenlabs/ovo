import { connect, createServer, type Server, type Socket } from 'node:net';
import { SipParseError, SIP_LIMITS, frameLength } from './parse.ts';

export interface StreamHandler {
  /** Checked on accept, before any byte is read; false closes the socket silently. */
  allow(address: string): boolean;
  onMessage(data: Buffer, source: { address: string; port: number }, connectionId: number): void;
  onDrop(
    reason: 'unknown_source' | 'malformed' | 'oversize' | 'too_many_connections',
    address: string,
  ): void;
}

interface Connection {
  id: number;
  socket: Socket;
  buffer: Buffer;
  remote: { address: string; port: number };
}

const CRLF = Buffer.from('\r\n');

/**
 * SIP over TCP (RFC 3261 §18): Content-Length framing, CRLF keep-alives, one connection reused
 * per remote ip:port in both directions, idle connections closed, a per-source connection cap.
 */
export class TcpTransport {
  private readonly connections = new Map<number, Connection>();
  private readonly byRemote = new Map<string, number>();
  private nextId = 1;

  private constructor(
    private readonly server: Server,
    private readonly handler: StreamHandler,
    private readonly options: { idleMs: number; maxPerSource: number },
  ) {
    server.on('connection', (socket) => this.accept(socket));
  }

  static listen(
    address: string,
    port: number,
    handler: StreamHandler,
    options: { idleMs?: number; maxPerSource?: number } = {},
  ): Promise<TcpTransport> {
    const server = createServer({ noDelay: true });
    const transport = new TcpTransport(server, handler, {
      idleMs: options.idleMs ?? 120_000,
      maxPerSource: options.maxPerSource ?? 8,
    });
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: address, port, exclusive: true }, () => {
        server.off('error', reject);
        resolve(transport);
      });
    });
  }

  get port(): number {
    const address = this.server.address();
    return typeof address === 'object' && address ? address.port : 0;
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  private accept(socket: Socket): void {
    const address = socket.remoteAddress ?? '';
    if (!this.handler.allow(address)) {
      this.handler.onDrop('unknown_source', address);
      socket.destroy();
      return;
    }
    const open = [...this.connections.values()].filter((c) => c.remote.address === address).length;
    if (open >= this.options.maxPerSource) {
      this.handler.onDrop('too_many_connections', address);
      socket.destroy();
      return;
    }
    this.register(socket, { address, port: socket.remotePort ?? 0 });
  }

  private register(socket: Socket, remote: { address: string; port: number }): Connection {
    const connection: Connection = { id: this.nextId++, socket, buffer: Buffer.alloc(0), remote };
    this.connections.set(connection.id, connection);
    this.byRemote.set(`${remote.address}:${remote.port}`, connection.id);
    socket.setTimeout(this.options.idleMs, () => socket.destroy());
    socket.on('error', () => undefined);
    socket.on('close', () => {
      this.connections.delete(connection.id);
      if (this.byRemote.get(`${remote.address}:${remote.port}`) === connection.id)
        this.byRemote.delete(`${remote.address}:${remote.port}`);
    });
    socket.on('data', (chunk: Buffer) => this.read(connection, chunk));
    return connection;
  }

  private read(connection: Connection, chunk: Buffer): void {
    connection.buffer = Buffer.concat([connection.buffer, chunk]);
    for (;;) {
      // RFC 5626 keep-alive: a double CRLF ping gets a single CRLF pong; stray CRLFs are skipped.
      let skip = 0;
      while (connection.buffer[skip] === 13 && connection.buffer[skip + 1] === 10) skip += 2;
      if (skip >= 4) connection.socket.write(CRLF);
      if (skip) connection.buffer = connection.buffer.subarray(skip);
      if (!connection.buffer.length) return;
      let length: number | undefined;
      try {
        length = frameLength(connection.buffer);
      } catch (error) {
        const reason =
          error instanceof SipParseError && error.reason === 'oversize' ? 'oversize' : 'malformed';
        this.handler.onDrop(reason, connection.remote.address);
        connection.socket.destroy();
        return;
      }
      if (length === undefined) {
        if (connection.buffer.length > SIP_LIMITS.tcpBytes) {
          this.handler.onDrop('oversize', connection.remote.address);
          connection.socket.destroy();
        }
        return;
      }
      const message = connection.buffer.subarray(0, length);
      connection.buffer = connection.buffer.subarray(length);
      this.handler.onMessage(Buffer.from(message), connection.remote, connection.id);
    }
  }

  /** Writes on the pinned connection, else reuses or opens one to `address:port`. */
  async send(
    bytes: Uint8Array,
    address: string,
    port: number,
    connectionId?: number,
  ): Promise<void> {
    const pinned = connectionId !== undefined ? this.connections.get(connectionId) : undefined;
    const reused = this.connections.get(this.byRemote.get(`${address}:${port}`) ?? -1);
    const connection = pinned ?? reused ?? (await this.open(address, port));
    connection.socket.write(bytes);
  }

  private open(address: string, port: number): Promise<Connection> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: address, port, noDelay: true });
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.off('error', reject);
        resolve(this.register(socket, { address, port }));
      });
    });
  }

  close(): Promise<void> {
    for (const connection of this.connections.values()) connection.socket.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
