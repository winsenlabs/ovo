import type { IncomingMessage, ServerResponse } from 'node:http';
import { validateTwilioSignature } from '@winsendotai/ovo-plugin-telephony-twilio';
import type { MediaGatewayConfig } from './gateway-types.ts';
import type { CarrierCallbackProjector, MediaRouteResolver } from './ports.ts';

export async function handleGatewayRequest(
  request: IncomingMessage,
  response: ServerResponse,
  preHandler: MediaGatewayConfig['httpHandler'],
  fallback: () => Promise<void>,
): Promise<void> {
  try {
    if (preHandler && (await preHandler(request, response))) return;
    await fallback();
  } catch {
    if (!response.headersSent) response.writeHead(500);
    if (!response.writableEnded) response.end();
  }
}

export function createGatewayHttpHandler(
  resolver: MediaRouteResolver & Partial<CarrierCallbackProjector>,
  config: MediaGatewayConfig,
  state: () => { draining: boolean; sessions: number },
) {
  return (request: IncomingMessage, response: ServerResponse) =>
    void handleGatewayRequest(request, response, config.httpHandler, () =>
      handleGatewayHttp(request, response, resolver, config, state()),
    );
}

export async function handleGatewayHttp(
  request: IncomingMessage,
  response: ServerResponse,
  projector: Partial<CarrierCallbackProjector>,
  config: MediaGatewayConfig,
  health: { draining: boolean; sessions: number },
) {
  if (request.url === '/health' && request.method === 'GET') {
    response.writeHead(health.draining ? 503 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ready: !health.draining, sessions: health.sessions }));
    return;
  }
  if (
    new URL(request.url ?? '/', 'http://internal').pathname !== '/twilio/status' ||
    request.method !== 'POST'
  ) {
    response.writeHead(404).end();
    return;
  }
  try {
    if (!projector.applyCarrierCallback) throw new Error('carrier callback projector unavailable');
    const body = await readForm(request, 64 * 1024);
    const externalUrl = new URL(request.url ?? '/', config.publicBaseUrl).toString();
    const signature = request.headers['x-twilio-signature'];
    if (
      !validateTwilioSignature({
        authToken: config.twilioAuthToken,
        signature: typeof signature === 'string' ? signature : undefined,
        externalUrl,
        parameters: body,
      })
    ) {
      response.writeHead(401).end();
      return;
    }
    const callSid = requiredForm(body, 'CallSid');
    const sequence = requiredForm(body, 'SequenceNumber');
    const status = carrierStatus(requiredForm(body, 'CallStatus'));
    const result = await projector.applyCarrierCallback({
      provider: 'twilio',
      eventId: `${callSid}:${sequence}`,
      dialRequestId: new URL(externalUrl).searchParams.get('ovoRequestId') ?? undefined,
      carrierCallId: callSid,
      status,
      occurredAt: new Date(),
      payload: { sequenceNumber: sequence },
    });
    response
      .writeHead(
        result.kind === 'correlation_conflict' ? 409 : result.kind === 'unmatched' ? 404 : 204,
      )
      .end();
  } catch (error) {
    response.writeHead(error instanceof RangeError ? 413 : 400).end();
  }
}

async function readForm(request: IncomingMessage, limit: number): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    if (bytes > limit) throw new RangeError('carrier callback body exceeds limit');
    chunks.push(value);
  }
  const result: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(Buffer.concat(chunks).toString('utf8'))) {
    if (key in result) throw new Error('duplicate carrier callback parameter');
    result[key] = value;
  }
  return result;
}

function requiredForm(body: Record<string, string>, name: string): string {
  const value = body[name];
  if (!value || value.length > 256) throw new Error(`invalid ${name}`);
  return value;
}

function carrierStatus(value: string) {
  const mapped = {
    queued: 'initiated',
    initiated: 'initiated',
    ringing: 'ringing',
    'in-progress': 'answered',
    completed: 'completed',
    busy: 'busy',
    failed: 'failed',
    'no-answer': 'no_answer',
    canceled: 'cancelled',
  } as const;
  const status = mapped[value as keyof typeof mapped];
  if (!status) throw new Error('unsupported carrier status');
  return status;
}
