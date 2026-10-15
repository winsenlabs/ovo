import type {
  CallState,
  CarrierHostPorts,
  CarrierHttpReply,
  CarrierHttpRequest,
  CarrierHttpRoute,
  InboundDecision,
  Logger,
  SipRequestVerifier,
  StreamGrant,
} from '@winsendotai/ovo-contracts';
import type { z } from 'zod';
import {
  SIP_CALL_STATES,
  SipInboundRequestSchema,
  SipResumeRequestSchema,
  SipStatusRequestSchema,
  type SipInboundRequest,
} from './wire.ts';

const MAX_BODY = 64 * 1024;
type Purpose = CarrierHttpRoute['purpose'];

export const json = (status: number, body: unknown): CarrierHttpReply => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

/** Raw status tokens the status route accepts: exactly the wire's `CallState` values. */
export function mapSipCallState(raw: string): CallState | undefined {
  return (SIP_CALL_STATES as readonly string[]).includes(raw) ? (raw as CallState) : undefined;
}
export const SIP_STATUS_SNAPSHOT: Readonly<Record<string, CallState>> = Object.freeze(
  Object.fromEntries(SIP_CALL_STATES.map((state) => [state, state])),
);

class HostPortError extends Error {}
async function hostPort<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new HostPortError('SIP carrier host port failed', { cause: error });
  }
}

function body<S extends z.ZodType>(schema: S, raw: Uint8Array): z.infer<S> | undefined {
  try {
    const parsed = schema.safeParse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** `sip.header.<Name>`, plus `<prefix><lower-kebab-name>` when the carrier asks for an alias. */
function rawFields(inbound: SipInboundRequest, prefix?: string): Record<string, string> {
  const raw: Record<string, string> = {
    'sip.callId': inbound.callId,
    'sip.trunkId': inbound.trunkId,
  };
  for (const [name, value] of Object.entries(inbound.headers)) {
    raw[`sip.header.${name}`] = value;
    if (prefix) raw[`${prefix}${name.toLowerCase()}`] = value;
  }
  return raw;
}

interface RouteInput {
  carrierId: string;
  verifier: () => SipRequestVerifier | undefined;
  forwardHeaderPrefix?: string;
  logger?: Logger;
}

/** Status and resume callbacks the sip-gateway will need for an inbound call, when the host gave none. */
async function withCallbacks<G extends Omit<StreamGrant, 'kind'>>(
  grant: G,
  input: RouteInput,
  req: CarrierHttpRequest,
  host: CarrierHostPorts,
  callId: string,
): Promise<G> {
  const url = (purpose: Purpose) =>
    hostPort(() =>
      host.callbackUrl(input.carrierId, req.bindingId, purpose, { requestId: callId }),
    );
  return {
    ...grant,
    statusUrl: grant.statusUrl ?? (await url('status')),
    resumeUrl: grant.resumeUrl ?? (await url('resume')),
  };
}

export function createSipRoutes(input: RouteInput): CarrierHttpRoute[] {
  const { carrierId, logger } = input;
  /** Signature first, then the url-secret when the URL carries one (§5.1). */
  async function refuse(
    req: CarrierHttpRequest,
    host: CarrierHostPorts,
    purpose: Purpose,
  ): Promise<CarrierHttpReply | undefined> {
    const verifier = input.verifier();
    if (!verifier) return json(503, { error: 'sip_trunk_unavailable' });
    if (req.rawBody.byteLength > MAX_BODY) return json(413, { error: 'too_large' });
    const signed = await verifier.verify({
      method: req.method,
      externalUrl: req.externalUrl,
      headers: req.headers,
      body: req.rawBody,
    });
    const secret =
      signed &&
      (!Object.keys(req.query).length ||
        (await hostPort(() =>
          host.verifyUrlSecret(req, {
            purpose,
            ...(req.query.r ? { requestId: req.query.r } : {}),
          }),
        )));
    if (signed && secret) return undefined;
    logger?.warn('sip_callback_unauthenticated', {
      carrierId,
      purpose,
      bindingId: req.bindingId,
      check: signed ? 'url-secret' : 'signature',
    });
    return json(signed ? 403 : 401, { error: 'unauthenticated' });
  }

  function route(
    purpose: Purpose,
    run: (req: CarrierHttpRequest, host: CarrierHostPorts) => Promise<CarrierHttpReply>,
  ): CarrierHttpRoute {
    return {
      method: 'POST',
      purpose,
      async handle(req, host) {
        try {
          return (await refuse(req, host, purpose)) ?? (await run(req, host));
        } catch (error) {
          const status = error instanceof HostPortError ? 503 : 400;
          logger?.[status === 503 ? 'error' : 'warn']('sip_callback_failed', {
            carrierId,
            purpose,
            bindingId: req.bindingId,
            status,
            error: error instanceof Error ? error.message : String(error),
          });
          return json(status, { error: status === 503 ? 'host_unavailable' : 'bad_request' });
        }
      },
    };
  }

  return [
    route('inbound', async (req, host) => {
      const inbound = body(SipInboundRequestSchema, req.rawBody);
      if (!inbound) return json(400, { error: 'bad_request' });
      const decision: InboundDecision = await hostPort(() =>
        host.admitInbound({
          carrierId,
          bindingId: req.bindingId,
          carrierCallId: inbound.callId,
          from: inbound.from,
          to: inbound.to,
          receivedAt: new Date(inbound.receivedAt),
          raw: rawFields(inbound, input.forwardHeaderPrefix),
        }),
      );
      if (decision.kind !== 'connect') return json(200, decision);
      return json(200, await withCallbacks(decision, input, req, host, inbound.callId));
    }),
    route('status', async (req, host) => {
      const status = body(SipStatusRequestSchema, req.rawBody);
      if (!status) return json(400, { error: 'bad_request' });
      const payload: Record<string, unknown> = {
        ...status.payload,
        ...(status.sipCode !== undefined ? { sipCode: status.sipCode } : {}),
        ...(status.reason !== undefined ? { reason: status.reason } : {}),
      };
      const result = await hostPort(() =>
        host.applyCallEvent({
          carrierId,
          bindingId: req.bindingId,
          eventId: status.eventId,
          carrierCallId: status.callId,
          ...(status.dialRequestId
            ? { carrierRequestId: status.dialRequestId, dialRequestId: status.dialRequestId }
            : {}),
          state: status.state,
          occurredAt: new Date(status.occurredAt),
          ...(Object.keys(payload).length ? { payload } : {}),
        }),
      );
      if (result.kind === 'unmatched' || result.kind === 'correlation_conflict')
        logger?.warn('sip_status_unmatched', {
          carrierId,
          bindingId: req.bindingId,
          carrierCallId: status.callId,
          kind: result.kind,
        });
      return json(200, { result: result.kind });
    }),
    route('resume', async (req, host) => {
      const resume = body(SipResumeRequestSchema, req.rawBody);
      if (!resume) return json(400, { error: 'bad_request' });
      const grant = await hostPort(() =>
        host.resumeStream({ carrierId, bindingId: req.bindingId, carrierCallId: resume.callId }),
      );
      if (grant.kind === 'ended') return json(200, { kind: 'ended' });
      return json(200, await withCallbacks(grant, input, req, host, resume.callId));
    }),
  ];
}
