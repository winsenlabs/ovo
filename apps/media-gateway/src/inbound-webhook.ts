import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  InboundCarrierGateUnarmedError,
  type InboundGatewayDecision,
  type OperationsService,
} from '@winsendotai/ovo-plugin-operations';

export interface TwilioInboundWebhookOptions {
  operations: OperationsService;
  accountSid: string;
  authToken: string;
  externalBaseUrl: string;
  mediaStreamUrl: string;
  routeTokenSecret: string;
  path?: string;
  handshakeTtlMs?: number;
}

export type TwilioInboundWebhookHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<boolean>;

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function send(
  response: ServerResponse,
  statusCode: number,
  body: string,
  contentType = 'text/xml',
): void {
  response.writeHead(statusCode, {
    'content-type': `${contentType}; charset=utf-8`,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += next.length;
    if (size > 16_384) throw new Error('Inbound webhook body is too large');
    chunks.push(next);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parameters(raw: string): Record<string, string> {
  const search = new URLSearchParams(raw);
  const result: Record<string, string> = {};
  for (const [key, value] of search) {
    if (key in result) throw new Error('Duplicate form parameter');
    if (key.length > 100 || value.length > 2_000) throw new Error('Invalid form parameter');
    result[key] = value;
  }
  return result;
}

function signatureIsValid(
  token: string,
  signature: string | undefined,
  externalUrl: string,
  values: Record<string, string>,
): boolean {
  if (!signature || !externalUrl.startsWith('https://')) return false;
  const signed = Object.keys(values)
    .sort()
    .reduce((value, key) => value + key + values[key], externalUrl);
  const expected = createHmac('sha1', token).update(signed, 'utf8').digest('base64');
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function required(values: Record<string, string>, name: string, pattern: RegExp): string {
  const value = values[name];
  if (!value || !pattern.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}

function twimlReserved(streamUrl: string, sessionId: string, token: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${xml(streamUrl)}"><Parameter name="sessionId" value="${xml(sessionId)}"/><Parameter name="routeToken" value="${xml(token)}"/></Stream></Connect></Response>`;
}

function twimlBusy(): string {
  return '<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="busy"/></Response>';
}

function twimlHuman(target: string, announcement: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${xml(announcement)}</Say><Dial><Number>${xml(target)}</Number></Dial></Response>`;
}

function twimlWait(
  announcement: string,
  redirectUrl: string,
  pollAfterMs: number,
  announce: boolean,
): string {
  const seconds = Math.max(1, Math.min(10, Math.ceil(pollAfterMs / 1_000)));
  const say = announce ? `<Say>${xml(announcement)}</Say>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${say}<Pause length="${seconds}"/><Redirect method="POST">${xml(redirectUrl)}</Redirect></Response>`;
}

function twimlWaitExpired(): string {
  return '<?xml version="1.0" encoding="UTF-8"?><Response><Say>No agent became available. Please call again later.</Say><Hangup/></Response>';
}

function twimlActionFailure(): string {
  return '<?xml version="1.0" encoding="UTF-8"?><Response><Say>We could not complete this request.</Say><Hangup/></Response>';
}

function twimlCallbackPrompt(announcement: string, actionUrl: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Gather action="${xml(actionUrl)}" method="POST" numDigits="1" timeout="5"><Say>${xml(announcement)} Press 1 to request a callback.</Say></Gather><Say>No callback was requested.</Say><Hangup/></Response>`;
}

function twimlCallbackResult(state: 'queued' | 'declined' | 'suppressed'): string {
  const message =
    state === 'queued'
      ? 'Your callback request has been queued.'
      : state === 'suppressed'
        ? 'A callback cannot be scheduled for this number.'
        : 'No callback was requested.';
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${message}</Say><Hangup/></Response>`;
}

export function createTwilioInboundWebhookHandler(
  options: TwilioInboundWebhookOptions,
): TwilioInboundWebhookHandler {
  const path = options.path ?? '/twilio/inbound';
  const externalBase = new URL(options.externalBaseUrl);
  if (
    externalBase.protocol !== 'https:' ||
    externalBase.username ||
    externalBase.password ||
    externalBase.search ||
    externalBase.hash
  )
    throw new Error('externalBaseUrl must be a credential-free HTTPS URL');
  const stream = new URL(options.mediaStreamUrl);
  if (stream.protocol !== 'wss:' || stream.username || stream.password || stream.hash)
    throw new Error('mediaStreamUrl must be a credential-free WSS URL');
  if (!path.startsWith('/') || path.includes('?') || path.includes('#'))
    throw new Error('Inbound webhook path is invalid');
  if (options.authToken.length < 8) throw new Error('Twilio auth token is not configured');
  if (!/^AC[0-9a-fA-F]{32}$/.test(options.accountSid))
    throw new Error('Twilio account SID is not configured');
  if (options.routeTokenSecret.length < 32)
    throw new Error('routeTokenSecret must be at least 32 characters');
  const handshakeTtlMs = options.handshakeTtlMs ?? 60_000;

  return async (request, response) => {
    const requestUrl = new URL(request.url ?? '/', externalBase);
    if (requestUrl.pathname !== path) return false;
    if (request.method !== 'POST') {
      send(response, 405, 'Method Not Allowed', 'text/plain');
      return true;
    }
    let values: Record<string, string>;
    try {
      if (
        !String(request.headers['content-type'] ?? '')
          .toLowerCase()
          .startsWith('application/x-www-form-urlencoded')
      )
        throw new Error('Unsupported content type');
      values = parameters(await body(request));
      const externalUrl = new URL(
        `${requestUrl.pathname}${requestUrl.search}`,
        externalBase,
      ).toString();
      const signature = Array.isArray(request.headers['x-twilio-signature'])
        ? request.headers['x-twilio-signature'][0]
        : request.headers['x-twilio-signature'];
      if (!signatureIsValid(options.authToken, signature, externalUrl, values)) {
        send(response, 403, 'Forbidden', 'text/plain');
        return true;
      }
      if (values.AccountSid !== options.accountSid) {
        send(response, 403, 'Forbidden', 'text/plain');
        return true;
      }
      const carrierCallId = required(values, 'CallSid', /^CA[0-9a-fA-F]{32}$/);
      const fromNumber = required(values, 'From', /^\+[1-9]\d{7,14}$/);
      const toNumber = required(values, 'To', /^\+[1-9]\d{7,14}$/);
      if (!/^inbound(?:-|$)/.test(values.Direction ?? '')) throw new Error('Invalid Direction');
      const routeToken = createHmac('sha256', options.routeTokenSecret)
        .update(`${options.operations.organizationId}:${carrierCallId}`, 'utf8')
        .digest('base64url');
      if ([...requestUrl.searchParams.keys()].some((key) => key !== 'stage'))
        throw new Error('Invalid inbound query parameter');
      if (requestUrl.searchParams.getAll('stage').length > 1)
        throw new Error('Duplicate inbound stage');
      const stage = requestUrl.searchParams.get('stage');
      if (stage && stage !== 'wait' && stage !== 'callback')
        throw new Error('Invalid inbound stage');
      const admission = {
        carrierCallId,
        fromNumber,
        toNumber,
        routeTokenHash: createHash('sha256').update(routeToken, 'utf8').digest('hex'),
        handshakeTtlMs,
      };
      let decision: InboundGatewayDecision;
      try {
        decision =
          stage === 'callback'
            ? await options.operations.inboundGateway.confirmCallback({
                ...admission,
                digits: required(values, 'Digits', /^[0-9*#]{1,16}$/),
              })
            : await options.operations.inboundGateway.admit(admission);
      } catch (error) {
        if (error instanceof InboundCarrierGateUnarmedError) {
          send(response, 503, error.message, 'text/plain');
          return true;
        }
        send(response, 503, stage ? twimlActionFailure() : twimlBusy());
        return true;
      }
      if (decision.kind === 'reserved')
        send(response, 200, twimlReserved(stream.toString(), decision.sessionId, routeToken));
      else if (decision.kind === 'human')
        send(response, 200, twimlHuman(decision.target, decision.announcement));
      else if (
        decision.kind === 'busy' &&
        decision.reason.startsWith('inbound_carrier_configuration_')
      )
        send(response, 503, decision.reason, 'text/plain');
      else if (decision.kind === 'wait')
        send(
          response,
          200,
          twimlWait(
            decision.announcement,
            new URL(`${path}?stage=wait`, externalBase).toString(),
            decision.pollAfterMs,
            stage !== 'wait',
          ),
        );
      else if (decision.kind === 'callback')
        send(
          response,
          200,
          decision.state === 'prompt'
            ? twimlCallbackPrompt(
                decision.announcement,
                new URL(`${path}?stage=callback`, externalBase).toString(),
              )
            : twimlCallbackResult(decision.state),
        );
      else if (decision.reason === 'wait_expired') send(response, 200, twimlWaitExpired());
      else send(response, 200, twimlBusy());
    } catch {
      send(
        response,
        400,
        requestUrl.searchParams.has('stage') ? twimlActionFailure() : twimlBusy(),
      );
    }
    return true;
  };
}
