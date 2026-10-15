import { randomBytes } from 'node:crypto';
import {
  REASONS,
  SipHeaders,
  headerDisplay,
  type SipMessage,
  type SipRequest,
  type SipResponse,
} from './message.ts';

export const USER_AGENT = 'ovo-sip-gateway/1';

/** Content-Length is always rewritten from the body; nothing else is reordered. */
export function serialize(message: SipMessage): Buffer {
  const start =
    message.kind === 'request'
      ? `${message.method} ${message.uri} SIP/2.0`
      : `SIP/2.0 ${message.status} ${message.reason}`;
  const lines = [start];
  for (const [key, value] of message.headers.entries())
    if (key !== 'content-length') lines.push(`${headerDisplay(key)}: ${value}`);
  lines.push(`Content-Length: ${message.body.byteLength}`, '', '');
  return Buffer.concat([Buffer.from(lines.join('\r\n'), 'latin1'), message.body]);
}

/** RFC 3261 §8.1.1.7: a magic-cookie branch, unique per transaction. */
export function newBranch(): string {
  return `z9hG4bK${randomBytes(10).toString('hex')}`;
}

export function newTag(): string {
  return randomBytes(6).toString('hex');
}

/**
 * A response to `request` (RFC 3261 §8.2.6): Via, From, To, Call-ID and CSeq copied, the To tag
 * added when the UAS supplies one and the request had none.
 */
export function createResponse(
  request: SipRequest,
  status: number,
  options: {
    toTag?: string;
    reason?: string;
    headers?: [string, string][];
    body?: Uint8Array;
  } = {},
): SipResponse {
  const headers = new SipHeaders();
  for (const [key, value] of request.headers.entries())
    if (key === 'via' || key === 'record-route') headers.append(key, value);
  if (status === 100 || status >= 300) headers.delete('record-route');
  headers.append('from', request.headers.get('from') ?? '');
  const to = request.headers.get('to') ?? '';
  headers.append(
    'to',
    options.toTag && !/;\s*tag=/i.test(to) && status > 100 ? `${to};tag=${options.toTag}` : to,
  );
  headers.append('call-id', request.headers.get('call-id') ?? '');
  headers.append('cseq', request.headers.get('cseq') ?? '');
  headers.append('server', USER_AGENT);
  for (const [name, value] of options.headers ?? []) headers.append(name, value);
  return {
    kind: 'response',
    status,
    reason: options.reason ?? REASONS[status] ?? 'Unknown',
    headers,
    body: options.body ?? new Uint8Array(),
  };
}
