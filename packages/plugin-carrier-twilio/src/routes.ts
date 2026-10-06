import type {
  CarrierHostPorts,
  CarrierHttpReply,
  CarrierHttpRequest,
  CarrierHttpRoute,
  InboundAdmission,
  InboundDecision,
} from '@winsendotai/ovo-contracts';
import { failure, hostPort, reply, required, signed } from './callback.ts';
import { twilioLog as log } from './log.ts';
import { connectMarkup, hangupMarkup, inboundMarkup } from './markup.ts';
import { mapAnsweredBy, mapTwilioStatus } from './status-map.ts';
import { statusEvent, streamStatusRoute, withStreamStatus } from './stream-status.ts';

/** A 404 or 409 means the callback names no session route this deployment owns. */
function applied(
  kind: string,
  req: CarrierHttpRequest,
  purpose: CarrierHttpRoute['purpose'],
  carrierCallId: string,
): CarrierHttpReply {
  if (kind !== 'correlation_conflict' && kind !== 'unmatched') return reply(204);
  log.warn('twilio_callback_unmatched', { purpose, bindingId: req.bindingId, carrierCallId, kind });
  return reply(kind === 'correlation_conflict' ? 409 : 404);
}

function unmappedStatus(
  req: CarrierHttpRequest,
  purpose: CarrierHttpRoute['purpose'],
  fields: Record<string, string>,
): CarrierHttpReply {
  log.warn('twilio_status_unmapped', {
    purpose,
    bindingId: req.bindingId,
    carrierCallId: fields.CallSid,
    callStatus: fields.CallStatus,
  });
  return reply(400);
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
  if (decision.kind !== 'connect') return decision;
  const streamed = await withStreamStatus(decision, req, host, callSid);
  if (streamed.resumeUrl) return streamed;
  return {
    ...streamed,
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
        return failure(error, req, 'inbound');
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
        const state = mapTwilioStatus(required(fields, 'CallStatus'));
        if (!state) return unmappedStatus(req, 'status', fields);
        const result = await hostPort(() =>
          host.applyCallEvent({
            carrierId: 'twilio',
            bindingId: req.bindingId,
            ...statusEvent(fields, carrierCallId, req.bindingId),
            carrierCallId,
            dialRequestId: req.query.r,
            state,
            answeredBy: mapAnsweredBy(fields.AnsweredBy),
          }),
        );
        return applied(result.kind, req, 'status', carrierCallId);
      } catch (error) {
        return failure(error, req, 'status');
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
        if (!state) return unmappedStatus(req, 'amd', fields);
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
        return applied(result.kind, req, 'amd', carrierCallId);
      } catch (error) {
        return failure(error, req, 'amd');
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
            ...(await withStreamStatus(grant, req, host, carrierCallId)),
            resumeUrl:
              grant.resumeUrl ??
              (await hostPort(() =>
                host.callbackUrl('twilio', req.bindingId, 'resume', { requestId: carrierCallId }),
              )),
          }),
        );
      } catch (error) {
        return failure(error, req, 'resume');
      }
    },
  },
  streamStatusRoute,
];
