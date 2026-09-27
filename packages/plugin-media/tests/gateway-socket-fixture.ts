import { randomBytes } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';

export class RawWebSocket {
  readonly messages: string[] = [];
  closed = false;
  closeCode?: number;
  private buffer = Buffer.alloc(0);
  constructor(private readonly socket: Socket) {
    socket.on('data', (chunk) => this.consume(chunk));
    socket.on('close', () => (this.closed = true));
  }
  send(message: string): void {
    this.frame(1, Buffer.from(message));
  }
  fragment(message: string, splitAt: number): void {
    const payload = Buffer.from(message);
    this.frame(1, payload.subarray(0, splitAt), false);
    this.frame(9, Buffer.from('mid-fragment'));
    this.frame(0, payload.subarray(splitAt));
  }
  private frame(opcode: number, payload: Buffer, final = true): void {
    const mask = randomBytes(4);
    const lengthCode = payload.length < 126 ? payload.length : payload.length < 65536 ? 126 : 127;
    const maskOffset = lengthCode < 126 ? 2 : lengthCode === 126 ? 4 : 10;
    const header = Buffer.alloc(maskOffset + 4);
    header[0] = (final ? 0x80 : 0) | opcode;
    header[1] = 0x80 | lengthCode;
    if (lengthCode === 126) header.writeUInt16BE(payload.length, 2);
    if (lengthCode === 127) header.writeBigUInt64BE(BigInt(payload.length), 2);
    mask.copy(header, maskOffset);
    for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4]!;
    this.socket.write(Buffer.concat([header, payload]));
  }
  close(): void {
    this.socket.end();
  }
  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const lengthCode = this.buffer[1]! & 0x7f;
      const header = lengthCode < 126 ? 2 : lengthCode === 126 ? 4 : 10;
      if (this.buffer.length < header) return;
      const length =
        lengthCode < 126
          ? lengthCode
          : lengthCode === 126
            ? this.buffer.readUInt16BE(2)
            : Number(this.buffer.readBigUInt64BE(2));
      if (this.buffer.length < header + length) return;
      const opcode = this.buffer[0]! & 0x0f;
      const payload = this.buffer.subarray(header, header + length);
      this.buffer = this.buffer.subarray(header + length);
      if (opcode === 1) this.messages.push(payload.toString('utf8'));
      if (opcode === 8) {
        if (payload.length >= 2) this.closeCode = payload.readUInt16BE(0);
        this.socket.end();
      }
    }
  }
}

export async function connectRaw(
  port: number,
  path: string,
  signature: string,
): Promise<RawWebSocket> {
  const socket = createConnection({ host: '127.0.0.1', port });
  const key = randomBytes(16).toString('base64');
  socket.write(
    `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\nx-fixture-signature: ${signature}\r\n\r\n`,
  );
  const response = await new Promise<string>((resolve, reject) => {
    let value = '';
    const onData = (chunk: Buffer) => {
      value += chunk.toString('latin1');
      if (!value.includes('\r\n\r\n')) return;
      socket.off('data', onData);
      resolve(value);
    };
    socket.on('data', onData);
    socket.once('error', reject);
  });
  if (!response.startsWith('HTTP/1.1 101')) throw new Error(response.split('\r\n')[0]);
  return new RawWebSocket(socket);
}

export async function connectJsonRaw(port: number, path: string, signature: string) {
  const peer = await connectRaw(port, path, signature);
  return {
    messages: peer.messages,
    send: (message: unknown) => peer.send(JSON.stringify(message)),
    close: () => peer.close(),
  };
}
