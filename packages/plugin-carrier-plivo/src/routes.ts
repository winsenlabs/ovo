import type {
  CarrierHostPorts,
  CarrierHttpReply,
  CarrierHttpRequest,
  CarrierHttpRoute,
  NormalizedCallEvent,
  ResolvedBinding,
} from '@winsendotai/ovo-contracts';
import { hangupMarkup, inboundMarkup, streamMarkup } from './markup.ts';
import { formParams, verifyHttpV3 } from './signature.ts';
import { answeredBy, plivoStatus } from './status-map.ts';

const carrierId = 'plivo';
const xml = (body: string): CarrierHttpReply => ({
  status: 200,
  contentType: 'application/xml',
  body,
});
const empty = (status: number): CarrierHttpReply => ({
  status,
  contentType: 'text/plain',
  body: '',
});

function contentType(binding: ResolvedBinding): string {
  const value = binding.config.contentType;
  return typeof value === 'string' ? value : 'audio/x-mulaw;rate=8000';
}

function withStreamStatus<T extends { statusUrl?: string }>(
  grant: T,
  req: CarrierHttpRequest,
  host: CarrierHostPorts,
  callId: string,
): T {
  return {
    ...grant,
    statusUrl: host.callbackUrl(carrierId, req.bindingId, 'stream-status', { requestId: callId }),
  };
}

async function authenticate(
  req: CarrierHttpRequest,
  host: CarrierHostPorts,
  purpose: CarrierHttpRoute['purpose'],
): Promise<ResolvedBinding | undefined> {
  try {
    if (req.method !== 'POST' || !req.externalUrl.startsWith('https://')) return undefined;
    // The signed URL must include the exact query passed by the host; never sign a stripped URL.
    const signedUrl = new URL(req.externalUrl);
    for (const [key, value] of Object.entries(req.query))
      if (signedUrl.searchParams.get(key) !== value) return undefined;
    const binding = await host.resolveBinding(req.bindingId);
    if (binding.bindingId !== req.bindingId || !(await verifyHttpV3(req, binding.secret)))
      return undefined;
    if (
      purpose !== 'inbound' &&
      purpose !== 'stream-status' &&
      !host.verifyUrlSecret(req, { purpose, requestId: req.query.r })
    )
      return undefined;
    if (purpose === 'inbound' && !host.verifyUrlSecret(req, { purpose })) return undefined;
    return binding;
  } catch {
    return undefined;
  }
}

async function eventId(req: CarrierHttpRequest): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(req.externalUrl + '\n' + new TextDecoder().decode(req.rawBody)),
  );
  return `plivo:${Buffer.from(digest).toString('hex')}`;
}

function admission(params: Record<string, string>, req: CarrierHttpRequest) {
  return {
    carrierId,
    bindingId: req.bindingId,
    carrierCallId: params.CallUUID!,
    from: params.From!,
    to: params.To!,
    receivedAt: new Date(),
    raw: params,
  };
}

async function apply(
  req: CarrierHttpRequest,
  host: CarrierHostPorts,
  params: Record<string, string>,
  state: NonNullable<ReturnType<typeof plivoStatus>>,
  machine?: string,
): Promise<CarrierHttpReply> {
  const event: NormalizedCallEvent = {
    carrierId,
    bindingId: req.bindingId,
    eventId: await eventId(req),
    carrierCallId: params.CallUUID || undefined,
    carrierRequestId: params.RequestUUID || undefined,
    dialRequestId: req.query.r || undefined,
    state,
    answeredBy: answeredBy(machine),
    occurredAt: new Date(),
    payload: params,
  };
  const result = await host.applyCallEvent(event);
  return empty(
    result.kind === 'correlation_conflict' ? 409 : result.kind === 'unmatched' ? 404 : 204,
  );
}

export function plivoRoutes(
  log: (event: Record<string, string>) => void = console.error,
): CarrierHttpRoute[] {
  return [
    {
      method: 'POST',
      purpose: 'answer',
      async handle(req, host) {
        const binding = await authenticate(req, host, 'answer');
        if (!binding) return empty(403);
        const params = formParams(req.rawBody);
        if (!req.query.r || !params.CallUUID) return xml(hangupMarkup());
        const grant = await host.streamForDial({
          carrierId,
          bindingId: req.bindingId,
          dialRequestId: req.query.r,
          carrierCallId: params.CallUUID,
          carrierRequestId: params.RequestUUID,
        });
        return xml(
          grant.kind === 'stream'
            ? streamMarkup(
                withStreamStatus(grant, req, host, params.CallUUID),
                contentType(binding),
              )
            : hangupMarkup(),
        );
      },
    },
    {
      method: 'POST',
      purpose: 'inbound',
      async handle(req, host) {
        const binding = await authenticate(req, host, 'inbound');
        if (!binding) return empty(403);
        const params = formParams(req.rawBody);
        if (!params.CallUUID || !params.From || !params.To) return empty(400);
        const received = admission(params, req);
        const decision = params.Digits
          ? await host.confirmCallback({ ...received, digits: params.Digits })
          : await host.admitInbound(received);
        return xml(
          inboundMarkup(
            decision.kind === 'connect'
              ? withStreamStatus(decision, req, host, params.CallUUID)
              : decision,
            contentType(binding),
          ),
        );
      },
    },
    {
      method: 'POST',
      purpose: 'status',
      async handle(req, host) {
        if (!(await authenticate(req, host, 'status'))) return empty(403);
        const params = formParams(req.rawBody);
        const state = plivoStatus(params.CallStatus ?? '');
        if (!state || (!params.CallUUID && !params.RequestUUID)) return empty(400);
        return apply(req, host, params, state, params.Machine);
      },
    },
    {
      method: 'POST',
      purpose: 'amd',
      async handle(req, host) {
        if (!(await authenticate(req, host, 'amd'))) return empty(403);
        const params = formParams(req.rawBody);
        if (!params.CallUUID || !params.Machine) return empty(400);
        return apply(req, host, params, 'in_progress', params.Machine);
      },
    },
    {
      method: 'POST',
      purpose: 'resume',
      async handle(req, host) {
        const binding = await authenticate(req, host, 'resume');
        if (!binding) return empty(403);
        const params = formParams(req.rawBody);
        if (!params.CallUUID) return xml(hangupMarkup());
        const grant = await host.resumeStream({
          carrierId,
          bindingId: req.bindingId,
          carrierCallId: params.CallUUID,
        });
        return xml(
          grant.kind === 'stream'
            ? streamMarkup(
                withStreamStatus(grant, req, host, params.CallUUID),
                contentType(binding),
              )
            : hangupMarkup(),
        );
      },
    },
    {
      method: 'POST',
      purpose: 'stream-status',
      async handle(req, host) {
        if (!(await authenticate(req, host, 'stream-status'))) return empty(403);
        const params = formParams(req.rawBody);
        if (!['started', 'stopped', 'failed'].includes(params.Event ?? '')) return empty(400);
        log({
          event: 'plivo_stream_status',
          status: params.Event!,
          carrierCallId: params.CallUUID ?? '',
          streamId: params.StreamID ?? '',
          reason: params.StatusReason ?? '',
        });
        return empty(204);
      },
    },
  ];
}
