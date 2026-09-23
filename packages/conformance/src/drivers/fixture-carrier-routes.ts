import type {
  CallState,
  CarrierHostPorts,
  CarrierHttpReply,
  CarrierHttpRequest,
  CarrierHttpRoute,
  InboundDecision,
  StreamGrant,
} from '@winsendotai/ovo-contracts';
import {
  FIXTURE_CARRIER_ID,
  FIXTURE_SIGNATURE_HEADER,
  fixtureSignature,
  safeEqual,
} from './fixture-carrier-media.ts';

/** Carrier status → CallState. The kit snapshot-tests this table. */
export const FIXTURE_STATUS_MAP: Readonly<Record<string, CallState>> = Object.freeze({
  queued: 'queued',
  initiated: 'queued',
  ringing: 'ringing',
  'in-progress': 'in_progress',
  completed: 'completed',
  busy: 'busy',
  'no-answer': 'no_answer',
  failed: 'failed',
  canceled: 'canceled',
});

export const fixtureStatusOf = (raw: string): CallState | undefined =>
  Object.hasOwn(FIXTURE_STATUS_MAP, raw) ? FIXTURE_STATUS_MAP[raw] : undefined;

export function formParams(request: CarrierHttpRequest): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(new TextDecoder().decode(request.rawBody)));
}

/** Twilio-shaped: HMAC over the external URL (with query) + sorted POST params (key+value). */
export function signedPayload(externalUrl: string, params: Record<string, string>): string {
  return (
    externalUrl +
    Object.keys(params)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((key) => `${key}${params[key]}`)
      .join('')
  );
}

const xml = (body: string): CarrierHttpReply => ({
  status: 200,
  contentType: 'application/xml',
  body: `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`,
});
const escape = (value: string) => value.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
const refuse = (status: 401 | 403): CarrierHttpReply => ({
  status,
  contentType: 'text/plain',
  body: '',
});

export const HANGUP_MARKUP = '<Hangup/>';

export function streamMarkup(grant: Omit<StreamGrant, 'kind'>): string {
  const params = Object.entries(grant.routeParams)
    .map(([name, value]) => `<Parameter name="${escape(name)}" value="${escape(value)}"/>`)
    .join('');
  const resume = grant.resumeUrl
    ? `<Redirect method="POST">${escape(grant.resumeUrl)}</Redirect>`
    : '';
  return `<Connect><Stream url="${escape(grant.mediaUrl)}">${params}</Stream></Connect>${resume}`;
}

function decisionMarkup(decision: InboundDecision): string {
  switch (decision.kind) {
    case 'connect':
      return streamMarkup(decision);
    case 'wait':
      return `${decision.message ? `<Say>${escape(decision.message)}</Say>` : ''}<Pause length="${decision.pauseSeconds}"/><Redirect method="POST">${escape(decision.retryUrl)}</Redirect>`;
    case 'callback-offer':
      return `<Gather action="${escape(decision.digitsUrl)}" timeout="${decision.timeoutSeconds}"><Say>${escape(decision.prompt)}</Say></Gather>`;
    case 'human':
      return `<Dial>${escape(decision.e164)}</Dial>`;
    case 'busy':
      return '<Reject reason="busy"/>';
    case 'reject':
      return '<Reject/>';
    default:
      return `${decision.message ? `<Say>${escape(decision.message)}</Say>` : ''}${HANGUP_MARKUP}`;
  }
}

async function verified(
  request: CarrierHttpRequest,
  host: CarrierHostPorts,
  purpose: CarrierHttpRoute['purpose'],
  perCall: boolean,
): Promise<{ params: Record<string, string> } | CarrierHttpReply> {
  const binding = await host.resolveBinding(request.bindingId);
  const params = formParams(request);
  const query = new URLSearchParams(request.query).toString();
  const url = query ? `${request.externalUrl}?${query}` : request.externalUrl;
  const expected = fixtureSignature(binding.secret, signedPayload(url, params));
  if (!safeEqual(request.headers[FIXTURE_SIGNATURE_HEADER], expected)) return refuse(401);
  const requestId = perCall ? request.query.r : undefined;
  if (perCall && !requestId) return refuse(403);
  if (!host.verifyUrlSecret(request, { purpose, ...(requestId ? { requestId } : {}) }))
    return refuse(403);
  return { params };
}

const isReply = (value: unknown): value is CarrierHttpReply =>
  typeof value === 'object' && value !== null && 'status' in value;

export function fixtureCarrierRoutes(): CarrierHttpRoute[] {
  const carrierId = FIXTURE_CARRIER_ID;
  const route = (
    purpose: CarrierHttpRoute['purpose'],
    perCall: boolean,
    run: (
      params: Record<string, string>,
      request: CarrierHttpRequest,
      host: CarrierHostPorts,
    ) => Promise<CarrierHttpReply>,
  ): CarrierHttpRoute => ({
    method: 'POST',
    purpose,
    async handle(request, host) {
      const check = await verified(request, host, purpose, perCall);
      return isReply(check) ? check : run(check.params, request, host);
    },
  });
  const stream = async (
    grant: Awaited<ReturnType<CarrierHostPorts['streamForDial']>>,
  ): Promise<CarrierHttpReply> =>
    grant.kind === 'stream' ? xml(streamMarkup(grant)) : xml(HANGUP_MARKUP);
  return [
    route('inbound', false, async (params, request, host) => {
      const decision = await host.admitInbound({
        carrierId,
        bindingId: request.bindingId,
        carrierCallId: params.CallSid ?? '',
        from: params.From ?? '',
        to: params.To ?? '',
        receivedAt: new Date(0),
        raw: params,
      });
      return xml(decisionMarkup(decision));
    }),
    route('status', true, async (params, request, host) => {
      const state = fixtureStatusOf(params.CallStatus ?? '');
      if (!state) return { status: 400, contentType: 'text/plain', body: 'unknown status' };
      await host.applyCallEvent({
        carrierId,
        bindingId: request.bindingId,
        eventId: `${params.CallSid ?? request.query.r}:${params.CallStatus}:${params.SequenceNumber ?? '0'}`,
        ...(params.CallSid ? { carrierCallId: params.CallSid } : {}),
        dialRequestId: request.query.r,
        state,
        occurredAt: new Date(0),
      });
      return { status: 204, contentType: 'text/plain', body: '' };
    }),
    route('answer', true, async (params, request, host) =>
      stream(
        await host.streamForDial({
          carrierId,
          bindingId: request.bindingId,
          dialRequestId: request.query.r,
          ...(params.CallSid ? { carrierCallId: params.CallSid } : {}),
          ...(params.RequestUUID ? { carrierRequestId: params.RequestUUID } : {}),
        }),
      ),
    ),
    route('resume', true, async (params, request, host) =>
      stream(
        await host.resumeStream({
          carrierId,
          bindingId: request.bindingId,
          carrierCallId: params.CallSid ?? '',
        }),
      ),
    ),
  ];
}
