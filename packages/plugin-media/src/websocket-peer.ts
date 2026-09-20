import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface WebSocketPeerOptions {
  maxMessageBytes: number;
  requireMasked: boolean;
}

export class WebSocketPeer {
  private buffer = Buffer.alloc(0);
  private closed = false;
  private readonly messageListeners = new Set<(message: string) => void>();
  private readonly closeListeners = new Set<(reason: string) => void>();

  constructor(
    private readonly socket: Duplex,
    private readonly options: WebSocketPeerOptions,
  ) {
    socket.on('data', (chunk: Buffer) => this.consume(chunk));
    socket.on('close', () => this.finish('socket closed'));
    socket.on('error', (error) => this.finish(error.message));
  }

  get bufferedBytes(): number {
    return this.socket.writableLength;
  }

  onMessage(listener: (message: string) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onClose(listener: (reason: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  send(message: string): boolean {
    if (this.closed) return false;
    const payload = Buffer.from(message);
    if (payload.length > this.options.maxMessageBytes)
      throw new Error('WebSocket message exceeds limit');
    return this.socket.write(frame(0x1, payload));
  }

  close(code = 1000, reason = 'closed'): void {
    if (this.closed) return;
    const text = Buffer.from(reason).subarray(0, 123);
    const payload = Buffer.alloc(2 + text.length);
    payload.writeUInt16BE(code);
    text.copy(payload, 2);
    this.socket.write(frame(0x8, payload));
    this.socket.end();
    this.finish(reason);
  }

  private consume(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      while (this.readFrame()) {}
    } catch (error) {
      this.close(1009, error instanceof Error ? error.message : 'invalid frame');
    }
  }

  private readFrame(): boolean {
    if (this.buffer.length < 2) return false;
    const first = this.buffer[0]!;
    const second = this.buffer[1]!;
    if ((first & 0x80) === 0) throw new Error('fragmented frames are unsupported');
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    if (masked !== this.options.requireMasked) throw new Error('invalid WebSocket masking');
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (this.buffer.length < 4) return false;
      length = this.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (this.buffer.length < 10) return false;
      const large = this.buffer.readBigUInt64BE(2);
      if (large > BigInt(this.options.maxMessageBytes)) throw new Error('message exceeds limit');
      length = Number(large);
      offset = 10;
    }
    if (length > this.options.maxMessageBytes) throw new Error('message exceeds limit');
    const maskBytes = masked ? 4 : 0;
    if (this.buffer.length < offset + maskBytes + length) return false;
    const mask = masked ? this.buffer.subarray(offset, offset + 4) : undefined;
    offset += maskBytes;
    const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
    this.buffer = this.buffer.subarray(offset + length);
    if (mask)
      for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4]!;
    if (opcode === 0x8) {
      this.socket.end();
      this.finish('peer closed');
    } else if (opcode === 0x9) this.socket.write(frame(0xa, payload));
    else if (opcode === 0x1) {
      const message = payload.toString('utf8');
      for (const listener of this.messageListeners) listener(message);
    } else if (opcode !== 0xa) throw new Error('unsupported WebSocket frame');
    return this.buffer.length > 0;
  }

  private finish(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) listener(reason);
    this.closeListeners.clear();
    this.messageListeners.clear();
  }
}

export function acceptWebSocket(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  options: WebSocketPeerOptions,
): WebSocketPeer | undefined {
  const key = request.headers['sec-websocket-key'];
  if (typeof key !== 'string' || request.headers['sec-websocket-version'] !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return undefined;
  }
  const accept = createHash('sha1')
    .update(key + GUID)
    .digest('base64');
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const peer = new WebSocketPeer(socket, options);
  if (head.length) socket.unshift(head);
  return peer;
}

function frame(opcode: number, payload: Buffer): Buffer {
  const header = payload.length < 126 ? 2 : payload.length <= 65_535 ? 4 : 10;
  const output = Buffer.allocUnsafe(header + payload.length);
  output[0] = 0x80 | opcode;
  if (header === 2) output[1] = payload.length;
  else if (header === 4) {
    output[1] = 126;
    output.writeUInt16BE(payload.length, 2);
  } else {
    output[1] = 127;
    output.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  payload.copy(output, header);
  return output;
}
