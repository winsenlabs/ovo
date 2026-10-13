import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  SipDialRequestSchema,
  SipHandoffRequestSchema,
  SipHangupRequestSchema,
} from '@winsendotai/ovo-sip-carrier-kit';
import { checkDial, dial } from '../call/dial.ts';
import { blockListOf, contains } from '../config/trunks.ts';
import type { SipGateway } from '../gateway.ts';

const MAX_BODY = 64 * 1024;

/** Constant-time bearer comparison over digests, so the token length does not leak either. */
export function bearerMatches(header: string | undefined, token: string): boolean {
  const match = /^Bearer (.+)$/.exec(header ?? '');
  if (!match) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(match[1]!), digest(token));
}

export function isLoopback(address: string): boolean {
  const v4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  return v4 === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new RangeError('too_large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * The control API workers reach through `Cap.sipTrunkControl` (§5.4): bearer token and source
 * CIDRs first, then dial, reconcile, hangup, handoff (refused in v1) and health. JSON in and out.
 */
export function createControlServer(gateway: SipGateway): Server {
  const { control } = gateway.config;
  const sources = blockListOf(control.sourceCidrs);
  return createServer((req, res) => {
    const address = req.socket.remoteAddress ?? '';
    if (!isLoopback(address) && !contains(sources, address))
      return send(res, 403, { error: 'forbidden' });
    if (!bearerMatches(req.headers.authorization, control.token))
      return send(res, 401, { error: 'unauthorized' });
    route(gateway, req).then(
      ({ status, body }) => send(res, status, body),
      (error: Error) => {
        const bad = error instanceof SyntaxError || error instanceof RangeError;
        if (!bad) gateway.logger.error('sip.control_failed', { error: error.message });
        send(res, bad ? 400 : 500, { error: bad ? 'bad_request' : 'internal' });
      },
    );
  });
}

async function route(
  gateway: SipGateway,
  req: IncomingMessage,
): Promise<{ status: number; body: unknown }> {
  const url = new URL(req.url ?? '/', 'http://control');
  const key = `${req.method} ${url.pathname}`;
  switch (key) {
    case 'POST /v1/calls': {
      const parsed = SipDialRequestSchema.safeParse(await readJson(req));
      if (!parsed.success)
        return {
          status: 422,
          body: { kind: 'rejected', reason: 'invalid_request', retryable: false },
        };
      const checked = checkDial(gateway, parsed.data);
      if (!('id' in checked)) {
        gateway.logger.info('sip.outbound', {
          requestId: parsed.data.requestId,
          result: checked.reason,
        });
        return {
          status: checked.status,
          body: { kind: 'rejected', reason: checked.reason, retryable: checked.retryable },
        };
      }
      return dial(gateway, parsed.data, checked);
    }
    case 'GET /v1/calls': {
      const requestId = url.searchParams.get('requestId');
      if (!requestId) return { status: 400, body: { error: 'requestId is required' } };
      return { status: 200, body: gateway.registry.reconcile(requestId) };
    }
    case 'POST /v1/calls/hangup': {
      const parsed = SipHangupRequestSchema.safeParse(await readJson(req));
      if (!parsed.success) return { status: 400, body: { error: 'bad_request' } };
      const call =
        gateway.registry.get(parsed.data.carrierCallId) ??
        (parsed.data.carrierRequestId
          ? gateway.registry.byRequest(parsed.data.carrierRequestId)
          : undefined);
      return { status: 200, body: { result: call ? gateway.hangup(call) : 'already_ended' } };
    }
    case 'POST /v1/calls/handoff': {
      const parsed = SipHandoffRequestSchema.safeParse(await readJson(req));
      if (!parsed.success) return { status: 400, body: { error: 'bad_request' } };
      return {
        status: 200,
        body: { kind: 'rejected', retryable: false, reason: 'handoff_unsupported' },
      };
    }
    case 'GET /v1/health':
      return {
        status: 200,
        body: {
          ready: !gateway.draining,
          draining: gateway.draining,
          calls: gateway.registry.size,
          trunks: gateway.pinger.snapshot(),
        },
      };
    default:
      return { status: 404, body: { error: 'not_found' } };
  }
}
