import type {
  CarrierHostPorts,
  CarrierHttpReply,
  CarrierHttpRequest,
  CarrierHttpRoute,
  InboundAdmission,
  InboundDecision,
} from '@winsendotai/ovo-contracts';
import { connectMarkup, hangupMarkup, inboundMarkup } from './markup.ts';
import { validateTwilioSignature } from './signature.ts';
import { mapAnsweredBy, mapTwilioStatus } from './status-map.ts';

const reply = (status: number, body = ''): CarrierHttpReply => ({
  status,
  contentType: 'text/xml; charset=utf-8',
  body,
});

class HostPortError extends Error {}

async function hostPort<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch {
    throw new HostPortError('Twilio host port failed');
  }
}

const failure = (error: unknown): CarrierHttpReply =>
  reply(error instanceof HostPortError ? 503 : error instanceof RangeError ? 413 : 400);

function form(raw: Uint8Array): Record<string, string> {
  if (raw.byteLength > 64 * 1024) throw new RangeError('Twilio callback is too large');
  const result: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(
    new TextDecoder('utf-8', { fatal: true }).decode(raw),
  )) {
    if (Object.hasOwn(result, key)) throw new Error('Duplicate Twilio callback parameter');
    result[key] = value;
  }
  return result;
}

function required(input: Record<string, string>, name: string): string {
  const value = input[name];
  if (!value || value.length > 256) throw new Error(`Invalid Twilio ${name}`);
  return value;
}

async function signed(
  req: CarrierHttpRequest,
  host: CarrierHostPorts,
  purpose: CarrierHttpRoute['purpose'],
): Promise<Record<string, string> | undefined> {
  const params = form(req.rawBody);
  const binding = await hostPort(() => host.resolveBinding(req.bindingId));
  const signature = Object.entries(req.headers).find(
    ([key]) => key.toLowerCase() === 'x-twilio-signature',
  )?.[1];
  if (
    !validateTwilioSignature({
      authToken: binding.secret,
      signature,
      externalUrl: req.externalUrl,
      parameters: params,
    })
  )
    return undefined;
  if (
    purpose !== 'inbound' &&
    !(await hostPort(() => host.verifyUrlSecret(req, { purpose, requestId: req.query.r })))
  )
    return undefined;
  return params;
}

function admission(req: CarrierHttpRequest, fields: Record<string, string>): InboundAdmission {
  return {
    carrierId: 'twilio',
    bindingId: req.bindingId,
    carrierCallId: required(fields, 'CallSid'),
    from: required(fields, 'From'),
    to: required(fields, 'To'),
    receivedAt: new Date(),
    raw: fields,
  };
}

async function withResume(
  decision: InboundDecision,
  req: CarrierHttpRequest,
  host: CarrierHostPorts,
  callSid: string,
): Promise<InboundDecision> {
  if (decision.kind !== 'connect' || decision.resumeUrl) return decision;
  return {
    ...decision,
    resumeUrl: await hostPort(() =>
      host.callbackUrl('twilio', req.bindingId, 'resume', { requestId: callSid }),
    ),
  };
}

export const twilioRoutes: readonly CarrierHttpRoute[] = [
  {
    method: 'POST',
    purpose: 'inbound',
    async handle(req, host) {
      try {
        const fields = await signed(req, host, 'inbound');
        if (!fields) return reply(403);
        required(fields, 'AccountSid');
        required(fields, 'Direction');
        const inbound = admission(req, fields);
        const decision = fields.Digits
          ? await hostPort(() => host.confirmCallback({ ...inbound, digits: fields.Digits }))
          : await hostPort(() => host.admitInbound(inbound));
        return reply(
          200,
          inboundMarkup(await withResume(decision, req, host, inbound.carrierCallId)),
        );
      } catch (error) {
        return failure(error);
      }
    },
  },
  {
    method: 'POST',
    purpose: 'status',
    async handle(req, host) {
      try {
        const fields = await signed(req, host, 'status');
        if (!fields) return reply(403);
        const carrierCallId = required(fields, 'CallSid');
        const sequence = required(fields, 'SequenceNumber');
        const state = mapTwilioStatus(required(fields, 'CallStatus'));
        if (!state) return reply(400);
        const result = await hostPort(() =>
          host.applyCallEvent({
            carrierId: 'twilio',
            bindingId: req.bindingId,
            eventId: `${carrierCallId}:status:${sequence}`,
            carrierCallId,
            dialRequestId: req.query.r,
            state,
            answeredBy: mapAnsweredBy(fields.AnsweredBy),
            occurredAt: new Date(),
            payload: { sequenceNumber: sequence },
          }),
        );
        return reply(
          result.kind === 'correlation_conflict' ? 409 : result.kind === 'unmatched' ? 404 : 204,
        );
      } catch (error) {
        return failure(error);
      }
    },
  },
  {
    method: 'POST',
    purpose: 'amd',
    async handle(req, host) {
      try {
        const fields = await signed(req, host, 'amd');
        if (!fields) return reply(403);
        const carrierCallId = required(fields, 'CallSid');
        const answer = required(fields, 'AnsweredBy');
        const state = fields.CallStatus ? mapTwilioStatus(fields.CallStatus) : 'in_progress';
        if (!state) return reply(400);
        const result = await hostPort(() =>
          host.applyCallEvent({
            carrierId: 'twilio',
            bindingId: req.bindingId,
            eventId: `${carrierCallId}:amd:${fields.SequenceNumber ?? answer}`,
            carrierCallId,
            dialRequestId: req.query.r,
            state,
            answeredBy: mapAnsweredBy(answer),
            occurredAt: new Date(),
            payload: { answeredBy: answer },
          }),
        );
        return reply(
          result.kind === 'correlation_conflict' ? 409 : result.kind === 'unmatched' ? 404 : 204,
        );
      } catch (error) {
        return failure(error);
      }
    },
  },
  {
    method: 'POST',
    purpose: 'resume',
    async handle(req, host) {
      try {
        const fields = await signed(req, host, 'resume');
        if (!fields) return reply(403);
        const carrierCallId = required(fields, 'CallSid');
        const grant = await hostPort(() =>
          host.resumeStream({
            carrierId: 'twilio',
            bindingId: req.bindingId,
            carrierCallId,
          }),
        );
        if (grant.kind === 'ended') return reply(200, hangupMarkup());
        return reply(
          200,
          connectMarkup({
            ...grant,
            resumeUrl:
              grant.resumeUrl ??
              (await hostPort(() =>
                host.callbackUrl('twilio', req.bindingId, 'resume', { requestId: carrierCallId }),
              )),
          }),
        );
      } catch (error) {
        return failure(error);
      }
    },
  },
];
