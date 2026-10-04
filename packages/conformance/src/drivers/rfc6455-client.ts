import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import {
  OPCODE,
  decodeFrames,
  encodeFrame,
  type RawFrame,
  type RawMessage,
} from './rfc6455-frames.ts';

export * from './rfc6455-frames.ts';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export class RawHandshakeError extends Error {
  constructor(
    readonly status: number,
    readonly head: string,
  ) {
    super(`WebSocket upgrade refused with HTTP ${status}`);
    this.name = 'RawHandshakeError';
  }
}

export interface RawWebSocket {
  readonly frames: readonly RawFrame[];
  sendFrame(
    opcode: number,
    payload: Uint8Array | string,
    options?: { fin?: boolean; mask?: boolean },
  ): void;
  /** Text split into `fragments` masked frames, optionally with a ping between each pair. */
  sendText(text: string, options?: { fragments?: number; pingBetween?: boolean }): void;
  sendBinary(bytes: Uint8Array, options?: { fragments?: number; pingBetween?: boolean }): void;
  ping(payload?: Uint8Array): void;
  close(code?: number, reason?: string): void;
  /** The next complete message or control frame (pings are also answered automatically). */
  next(timeoutMs?: number): Promise<RawMessage>;
  readonly closed: Promise<{ code: number; reason: string }>;
  destroy(): void;
}

export async function connectRawWebSocket(
  url: string,
  options: { headers?: Record<string, string>; ca?: string | Buffer; timeoutMs?: number } = {},
): Promise<RawWebSocket> {
  const target = new URL(url);
  const secure = target.protocol === 'wss:';
  const port = Number(target.port || (secure ? 443 : 80));
  const host = target.hostname.replace(/^\[|\]$/g, '');
  const socket = secure
    ? tls.connect({ host, port, ca: options.ca, servername: net.isIP(host) ? undefined : host })
    : net.connect({ host, port });
  const key = randomBytes(16).toString('base64');
  const extra = Object.entries(options.headers ?? {})
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join('');
  const request =
    `GET ${target.pathname}${target.search} HTTP/1.1\r\nHost: ${target.host}\r\n` +
    `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\n` +
    `Sec-WebSocket-Version: 13\r\n${extra}\r\n`;
  const { rest } = await new Promise<{ rest: Buffer }>((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('raw WebSocket handshake timed out'));
    }, options.timeoutMs ?? 5000);
    socket.once(secure ? 'secureConnect' : 'connect', () => socket.write(request));
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      clearTimeout(timer);
      socket.off('data', onData);
      const head = buffer.subarray(0, end).toString('latin1');
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 0);
      const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head)?.[1];
      const expected = createHash('sha1')
        .update(key + GUID)
        .digest('base64');
      if (status !== 101 || accept !== expected) {
        socket.destroy();
        reject(new RawHandshakeError(status, head));
      } else resolve({ rest: buffer.subarray(end + 4) });
    };
    socket.on('data', onData);
  });
  return rawClient(socket, rest);
}

function rawClient(socket: net.Socket, initial: Buffer): RawWebSocket {
  const frames: RawFrame[] = [];
  const inbox: RawMessage[] = [];
  const waiters: ((message: RawMessage) => void)[] = [];
  let buffer = initial;
  let fragments: RawFrame[] = [];
  let resolveClosed!: (value: { code: number; reason: string }) => void;
  const closed = new Promise<{ code: number; reason: string }>(
    (resolve) => (resolveClosed = resolve),
  );
  const deliver = (message: RawMessage) => {
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else inbox.push(message);
  };
  const write = (frame: Buffer) => {
    if (!socket.destroyed) socket.write(frame);
  };
  const onFrame = (frame: RawFrame) => {
    frames.push(frame);
    if (frame.opcode === OPCODE.ping) {
      write(encodeFrame(OPCODE.pong, frame.payload));
      return deliver({ type: 'ping', data: new Uint8Array(frame.payload) });
    }
    if (frame.opcode === OPCODE.pong)
      return deliver({ type: 'pong', data: new Uint8Array(frame.payload) });
    if (frame.opcode === OPCODE.close) {
      const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
      const reason = frame.payload.subarray(2).toString('utf8');
      write(encodeFrame(OPCODE.close, frame.payload.subarray(0, 2)));
      socket.end();
      resolveClosed({ code, reason });
      return deliver({ type: 'close', code, reason });
    }
    fragments.push(frame);
    if (!frame.fin) return;
    const data = Buffer.concat(fragments.map((f) => f.payload));
    const opcode = fragments[0]!.opcode;
    fragments = [];
    deliver(
      opcode === OPCODE.text
        ? { type: 'text', data: data.toString('utf8') }
        : { type: 'binary', data: new Uint8Array(data) },
    );
  };
  const consume = (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    const decoded = decodeFrames(buffer);
    buffer = decoded.rest;
    decoded.frames.forEach(onFrame);
  };
  socket.on('data', consume);
  socket.on('close', () => resolveClosed({ code: 1006, reason: 'socket closed' }));
  socket.on('error', () => undefined);
  if (initial.length) queueMicrotask(() => consume(Buffer.alloc(0)));

  const fragmented = (opcode: number, data: Buffer, fragmentsWanted = 1, pingBetween = false) => {
    const count = Math.max(1, Math.min(fragmentsWanted, data.length || 1));
    const size = Math.ceil(data.length / count);
    for (let i = 0; i < count; i += 1) {
      const part = data.subarray(i * size, (i + 1) * size);
      write(encodeFrame(i === 0 ? opcode : OPCODE.continuation, part, { fin: i === count - 1 }));
      if (pingBetween && i < count - 1) write(encodeFrame(OPCODE.ping, Buffer.from(`p${i}`)));
    }
  };
  return {
    frames,
    closed,
    sendFrame(opcode, payload, options) {
      write(
        encodeFrame(opcode, typeof payload === 'string' ? Buffer.from(payload) : payload, options),
      );
    },
    sendText: (text, options = {}) =>
      fragmented(OPCODE.text, Buffer.from(text), options.fragments, options.pingBetween),
    sendBinary: (bytes, options = {}) =>
      fragmented(OPCODE.binary, Buffer.from(bytes), options.fragments, options.pingBetween),
    ping: (payload = new Uint8Array(0)) => write(encodeFrame(OPCODE.ping, payload)),
    close(code = 1000, reason = '') {
      const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
      payload.writeUInt16BE(code, 0);
      payload.write(reason, 2);
      write(encodeFrame(OPCODE.close, payload));
    },
    next(timeoutMs = 5000) {
      const queued = inbox.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('no WebSocket message in time')),
          timeoutMs,
        );
        waiters.push((message) => {
          clearTimeout(timer);
          resolve(message);
        });
      });
    },
    destroy: () => socket.destroy(),
  };
}
