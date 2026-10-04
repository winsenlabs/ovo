// RFC 6455 frame encoding and decoding for the raw loopback client (tests only).
import { randomBytes } from 'node:crypto';

export const OPCODE = { continuation: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 } as const;

export interface RawFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

export type RawMessage =
  | { type: 'text'; data: string }
  | { type: 'binary'; data: Uint8Array }
  | { type: 'ping' | 'pong'; data: Uint8Array }
  | { type: 'close'; code: number; reason: string };

/** Encodes one frame. Clients MUST mask (RFC 6455 §5.3); `mask: false` exists to test rejection. */
export function encodeFrame(
  opcode: number,
  payload: Uint8Array,
  options: { fin?: boolean; mask?: boolean; rsv?: number } = {},
): Buffer {
  const fin = options.fin ?? true;
  const mask = options.mask ?? true;
  const length = payload.byteLength;
  const lengthBytes = length < 126 ? 0 : length < 65536 ? 2 : 8;
  const header = Buffer.alloc(2 + lengthBytes + (mask ? 4 : 0));
  header[0] = (fin ? 0x80 : 0) | ((options.rsv ?? 0) << 4) | opcode;
  header[1] = (mask ? 0x80 : 0) | (length < 126 ? length : length < 65536 ? 126 : 127);
  if (lengthBytes === 2) header.writeUInt16BE(length, 2);
  if (lengthBytes === 8) header.writeBigUInt64BE(BigInt(length), 2);
  const body = Buffer.from(payload);
  if (mask) {
    const key = randomBytes(4);
    key.copy(header, 2 + lengthBytes);
    for (let i = 0; i < body.length; i += 1) body[i] = body[i]! ^ key[i % 4]!;
  }
  return Buffer.concat([header, body]);
}

/** Parses as many complete frames as `buffer` holds; returns them and the unconsumed rest. */
export function decodeFrames(buffer: Buffer): { frames: RawFrame[]; rest: Buffer } {
  const frames: RawFrame[] = [];
  let offset = 0;
  for (;;) {
    if (buffer.length - offset < 2) break;
    const first = buffer[offset]!;
    const second = buffer[offset + 1]!;
    let length = second & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (buffer.length - cursor < 2) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break;
      length = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }
    const masked = (second & 0x80) !== 0;
    const key = masked ? buffer.subarray(cursor, cursor + 4) : undefined;
    if (masked) cursor += 4;
    if (buffer.length - cursor < length) break;
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (key) for (let i = 0; i < payload.length; i += 1) payload[i] = payload[i]! ^ key[i % 4]!;
    frames.push({ fin: (first & 0x80) !== 0, opcode: first & 0x0f, payload });
    offset = cursor + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}
