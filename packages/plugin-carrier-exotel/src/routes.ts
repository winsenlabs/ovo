import type {
  CarrierHostPorts,
  CarrierHttpReply,
  CarrierHttpRequest,
  CarrierHttpRoute,
  InboundDecision,
  StreamGrant,
} from '@winsendotai/ovo-contracts';
import { mapExotelStatus } from './status-map.ts';

const json = (status: number, value: Record<string, unknown>): CarrierHttpReply => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(value),
});

class InvalidRequest extends Error {}

function fields(req: CarrierHttpRequest): Record<string, string> {
  if (req.rawBody.byteLength > 64 * 1024) throw new InvalidRequest('Exotel callback is too large');
  const result: Record<string, string> = { ...req.query };
  if (!req.rawBody.byteLength) return result;
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(req.rawBody);
  const contentType = Object.entries(req.headers).find(
    ([key]) => key.toLowerCase() === 'content-type',
  )?.[1];
  if (contentType?.includes('application/json')) {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new InvalidRequest('Exotel JSON callback is not an object');
    for (const [key, value] of Object.entries(parsed)) {
      if (Object.hasOwn(result, key)) throw new InvalidRequest(`Duplicate Exotel field ${key}`);
      result[key] = typeof value === 'string' ? value : JSON.stringify(value);
    }
  } else {
    for (const [key, value] of new URLSearchParams(raw)) {
      if (Object.hasOwn(result, key)) throw new InvalidRequest(`Duplicate Exotel field ${key}`);
      result[key] = value;
    }
  }
  return result;
}

function required(input: Record<string, string>, name: string): string {
  const value = input[name];
  if (!value || value.length > 256) throw new InvalidRequest(`Invalid Exotel ${name}`);
  return value;
}

function logUnknown(input: Record<string, string>, known: readonly string[]): void {
  const unknown = Object.keys(input).filter((name) => !known.includes(name));
  if (unknown.length) console.warn('Exotel callback has unrecognized field names', unknown);
}

/** Runtime host supports this purpose, while the current callbackUrl type excludes 'media'. */
function mediaSecret(host: CarrierHostPorts, bindingId: string, sessionId: string): string {
  const purpose = 'media' as CarrierHttpRoute['purpose'];
  const signed = host.callbackUrl('exotel', bindingId, purpose, { requestId: sessionId });
  const token = new URL(signed).searchParams.get('t');
  if (!token) throw new Error('Host did not issue an Exotel media secret');
  return token;
}

function connectUrl(
  host: CarrierHostPorts,
  bindingId: string,
  grant: Pick<StreamGrant, 'routeParams'>,
): string {
  const sid = required(grant.routeParams, 'sid');
  const rt = required(grant.routeParams, 'rt');
  const url = host.mediaUrl('exotel', bindingId, {
    query: { sid, rt, t: mediaSecret(host, bindingId, sid) },
  });
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'wss:' ||
    parsed.username ||
    parsed.password ||
    parsed.searchParams.size !== 3 ||
    [...parsed.searchParams.keys()].some((name) => !['sid', 'rt', 't'].includes(name)) ||
    url.length > 256
  )
    throw new Error('Exotel media URL exceeds the three-pair or 256-character limit');
  return url;
}

function connect(
  host: CarrierHostPorts,
  bindingId: string,
  grant: Pick<StreamGrant, 'routeParams'>,
): CarrierHttpReply {
  return json(200, { url: connectUrl(host, bindingId, grant) });
}

function nonConnect(decision: InboundDecision): CarrierHttpReply {
  switch (decision.kind) {
    case 'connect':
      throw new Error('Connect must be handled with a stream grant');
    case 'wait':
      return json(503, { error: 'exotel_wait_unsupported' });
    case 'callback-offer':
      return json(503, { error: 'exotel_callback_unsupported' });
    case 'human':
      return json(503, { error: 'exotel_transfer_unsupported' });
    case 'busy':
      return json(486, { error: 'exotel_busy' });
    case 'reject':
      return json(403, { error: 'exotel_rejected', reason: decision.reason });
    case 'hangup':
      return json(410, { error: 'exotel_ended' });
  }
}

const MEDIA_FIELDS = ['CallSid', 'From', 'To', 'CustomField', 't', 'r'];
const STATUS_FIELDS = [
  'CallSid',
  'Status',
  'EventType',
  'DateCreated',
  'DateUpdated',
  'Legs',
  'Legs[]',
  'ConversationDuration',
  'CustomField',
  'RecordingUrl',
  'To',
  'From',
  'PhoneNumberSid',
  'StartTime',
  'EndTime',
  'Direction',
  'r',
  't',
];

async function handleMediaUrl(
  req: CarrierHttpRequest,
  host: CarrierHostPorts,
): Promise<CarrierHttpReply> {
  try {
    if (!host.verifyUrlSecret(req, { purpose: 'media-url' }))
      return json(401, { error: 'exotel_media_url_unauthorized' });
    const binding = await host.resolveBinding(req.bindingId);
    if (binding.config.sampleRate === 16000)
      return json(422, { error: 'exotel_16khz_url_requires_four_query_pairs' });
    const input = fields(req);
    logUnknown(input, MEDIA_FIELDS);
    const callSid = required(input, 'CallSid');
    const dialRequestId = input.CustomField || undefined;
    const grant = await host.streamForDial({
      carrierId: 'exotel',
      bindingId: req.bindingId,
      carrierCallId: callSid,
      ...(dialRequestId ? { dialRequestId } : {}),
    });
    if (grant.kind === 'stream') return connect(host, req.bindingId, grant);
    if (grant.kind === 'ended') return json(410, { error: 'exotel_route_ended' });
    if (dialRequestId) return json(404, { error: 'exotel_outbound_unmatched' });
    const inbound = await host.admitInbound({
      carrierId: 'exotel',
      bindingId: req.bindingId,
      carrierCallId: callSid,
      from: required(input, 'From'),
      to: required(input, 'To'),
      receivedAt: new Date(),
      raw: input,
    });
    return inbound.kind === 'connect' ? connect(host, req.bindingId, inbound) : nonConnect(inbound);
  } catch (error) {
    return json(error instanceof InvalidRequest ? 400 : 503, {
      error:
        error instanceof InvalidRequest ? 'exotel_bad_media_request' : 'exotel_media_unavailable',
    });
  }
}

export const exotelRoutes: readonly CarrierHttpRoute[] = [
  { method: 'GET', purpose: 'media-url', handle: handleMediaUrl },
  { method: 'POST', purpose: 'media-url', handle: handleMediaUrl },
  {
    method: 'POST',
    purpose: 'status',
    async handle(req, host) {
      try {
        if (
          !req.query.r ||
          !host.verifyUrlSecret(req, { purpose: 'status', requestId: req.query.r })
        )
          return json(401, { error: 'exotel_status_unauthorized' });
        const input = fields(req);
        logUnknown(input, STATUS_FIELDS);
        const callSid = required(input, 'CallSid');
        const state = mapExotelStatus(required(input, 'Status'));
        if (!state) return json(400, { error: 'exotel_unknown_status' });
        const eventType = input.EventType ?? 'status';
        const stamp = input.DateUpdated ?? input.DateCreated ?? '';
        const result = await host.applyCallEvent({
          carrierId: 'exotel',
          bindingId: req.bindingId,
          eventId: `exotel:${callSid}:${eventType}:${stamp}:${state}`,
          carrierCallId: callSid,
          dialRequestId: input.CustomField || req.query.r,
          state,
          occurredAt: new Date(),
          payload: {
            eventType,
            ...(input.DateUpdated ? { vendorDateUpdated: input.DateUpdated } : {}),
            ...(input.ConversationDuration
              ? { conversationDuration: input.ConversationDuration }
              : {}),
            ...(input['Legs[]'] || input.Legs ? { legs: input['Legs[]'] ?? input.Legs } : {}),
          },
        });
        return json(
          result.kind === 'correlation_conflict' ? 409 : result.kind === 'unmatched' ? 404 : 200,
          { result: result.kind },
        );
      } catch (error) {
        return json(error instanceof InvalidRequest ? 400 : 503, {
          error:
            error instanceof InvalidRequest
              ? 'exotel_bad_status_request'
              : 'exotel_status_unavailable',
        });
      }
    },
  },
];
