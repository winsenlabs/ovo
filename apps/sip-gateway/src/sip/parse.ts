import { SipHeaders, parseCSeq, type SipMessage } from './message.ts';

/** Hard limits (§4.2): enforced before any header is interpreted. */
export const SIP_LIMITS = Object.freeze({
  udpBytes: 4096,
  tcpBytes: 64 * 1024,
  headers: 100,
  lineBytes: 8192,
});

/**
 * A message that breaks the profile. `respondable` is true only when the request still carries
 * enough (Via, From, To, Call-ID, CSeq) for a 400 to reach its sender; otherwise it is dropped.
 */
export class SipParseError extends Error {
  constructor(
    readonly reason: string,
    readonly respondable = false,
    readonly partial?: SipMessage,
  ) {
    super(reason);
    this.name = 'SipParseError';
  }
}

const TOKEN = /^[A-Za-z0-9.!%*_+`'~-]+$/;
const REQUIRED = ['via', 'from', 'to', 'call-id', 'cseq'] as const;

interface Head {
  lines: string[];
  bodyStart: number;
}

/** Locates the header block; undefined while a TCP stream has not delivered it yet. */
function splitHead(data: Uint8Array, maxBytes: number): Head | undefined {
  let end = -1;
  let bodyStart = -1;
  for (let i = 0; i + 1 < data.length; i += 1) {
    if (data[i] === 10 && data[i + 1] === 10) {
      end = i;
      bodyStart = i + 2;
      break;
    }
    if (data[i] === 13 && data[i + 1] === 10 && data[i + 2] === 13 && data[i + 3] === 10) {
      end = i;
      bodyStart = i + 4;
      break;
    }
  }
  if (end < 0) {
    if (data.length > maxBytes) throw new SipParseError('oversize');
    return undefined;
  }
  const head = Buffer.from(data.buffer, data.byteOffset, end).toString('latin1');
  const raw = head.split(/\r?\n/);
  const lines: string[] = [];
  for (const line of raw) {
    if (Buffer.byteLength(line, 'latin1') > SIP_LIMITS.lineBytes)
      throw new SipParseError('line_too_long');
    if (/^[ \t]/.test(line) && lines.length > 1) lines[lines.length - 1] += ` ${line.trim()}`;
    else lines.push(line);
  }
  if (lines.length - 1 > SIP_LIMITS.headers) throw new SipParseError('too_many_headers');
  return { lines, bodyStart };
}

function headersOf(lines: string[]): SipHeaders {
  const headers = new SipHeaders();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    const name = colon < 0 ? '' : line.slice(0, colon).trim();
    if (!name || !TOKEN.test(name)) throw new SipParseError('bad_header');
    headers.append(name, line.slice(colon + 1));
  }
  return headers;
}

function contentLength(headers: SipHeaders): number | undefined {
  const value = headers.get('content-length');
  if (value === undefined) return undefined;
  if (!/^\d{1,7}$/.test(value)) throw new SipParseError('bad_content_length');
  return Number(value);
}

/**
 * TCP framing: the byte length of the first complete message in `data`, or undefined when more
 * bytes are needed. Content-Length is mandatory on stream transports (RFC 3261 §18.3).
 */
export function frameLength(data: Uint8Array): number | undefined {
  const head = splitHead(data, SIP_LIMITS.tcpBytes);
  if (!head) return undefined;
  let length: number | undefined;
  try {
    length = contentLength(headersOf(head.lines));
  } catch (error) {
    throw error instanceof SipParseError ? error : new SipParseError('bad_header');
  }
  if (length === undefined) throw new SipParseError('missing_content_length');
  const total = head.bodyStart + length;
  if (total > SIP_LIMITS.tcpBytes) throw new SipParseError('oversize');
  return data.length >= total ? total : undefined;
}

/** Parses one complete datagram or one framed TCP message. */
export function parseMessage(data: Uint8Array, transport: 'udp' | 'tcp'): SipMessage {
  const max = transport === 'udp' ? SIP_LIMITS.udpBytes : SIP_LIMITS.tcpBytes;
  if (data.length > max) throw new SipParseError('oversize');
  const head = splitHead(data, max);
  if (!head) throw new SipParseError('incomplete');
  const start = head.lines[0] ?? '';
  const headers = headersOf(head.lines);
  const request = /^([A-Za-z]+) (\S+) SIP\/2\.0$/.exec(start);
  const response = /^SIP\/2\.0 ([1-6]\d\d) ?(.*)$/.exec(start);
  if (!request && !response) throw new SipParseError('bad_start_line');
  const message: SipMessage = request
    ? {
        kind: 'request',
        method: request[1]!.toUpperCase(),
        uri: request[2]!,
        headers,
        body: new Uint8Array(),
      }
    : {
        kind: 'response',
        status: Number(response![1]),
        reason: response![2] ?? '',
        headers,
        body: new Uint8Array(),
      };
  const complete = REQUIRED.every((name) => headers.has(name));
  const fail = (reason: string): never => {
    throw new SipParseError(reason, message.kind === 'request' && complete, message);
  };
  if (!complete) fail('missing_header');
  let length: number | undefined;
  try {
    length = contentLength(headers);
  } catch {
    fail('bad_content_length');
  }
  if (length === undefined && transport === 'tcp') fail('missing_content_length');
  const available = data.length - head.bodyStart;
  if (length !== undefined && length > available) fail('truncated_body');
  message.body = data.slice(head.bodyStart, head.bodyStart + (length ?? available));
  const cseq = parseCSeq(headers.get('cseq'));
  if (!cseq) fail('bad_cseq');
  if (message.kind === 'request' && cseq!.method !== message.method) fail('cseq_method_mismatch');
  return message;
}
