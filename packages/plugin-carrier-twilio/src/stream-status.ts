import type {
  CarrierHostPorts,
  CarrierHttpRequest,
  CarrierHttpRoute,
  StreamGrant,
} from '@winsendotai/ovo-contracts';
import { failure, hostPort, reply, required, signed } from './callback.ts';
import { twilioLog as log } from './log.ts';

/**
 * Twilio <Stream> status callbacks (OBS-11). Wire format from
 * https://www.twilio.com/docs/voice/twiml/stream (retrieved 2026-10-06): `statusCallback` and
 * `statusCallbackMethod` attributes; requests carry AccountSid, CallSid, StreamSid, StreamName,
 * StreamEvent (`stream-started`, `stream-stopped`, `stream-error`), StreamError and an ISO 8601
 * Timestamp. Twilio signs every webhook with X-Twilio-Signature
 * (https://www.twilio.com/docs/usage/security); that page does not name stream callbacks
 * specifically, so their signing is inferred, not confirmed.
 */
const STREAM_EVENTS = new Set(['stream-started', 'stream-stopped', 'stream-error']);

/** A grant whose <Stream> reports its own lifecycle to this binding's stream-status route. */
export async function withStreamStatus<T extends Omit<StreamGrant, 'kind'>>(
  grant: T,
  req: CarrierHttpRequest,
  host: CarrierHostPorts,
  callSid: string,
): Promise<T> {
  return {
    ...grant,
    statusUrl: await hostPort(() =>
      host.callbackUrl('twilio', req.bindingId, 'stream-status', { requestId: callSid }),
    ),
  };
}

/**
 * The idempotency key, time and evidence of a call status callback. Twilio sends SequenceNumber
 * and an RFC 2822 Timestamp (https://www.twilio.com/docs/voice/api/call-resource, retrieved
 * 2026-10-06) but a callback configured on a phone number may omit SequenceNumber; a call reaches
 * each status once, so `CallSid:status:CallStatus` is then a sound key. Callbacks are separate
 * requests and may arrive out of order; the host orders them by state, never by arrival.
 */
export function statusEvent(fields: Record<string, string>, callSid: string, bindingId: string) {
  const sequence = /^\d{1,9}$/.test(fields.SequenceNumber ?? '')
    ? fields.SequenceNumber
    : undefined;
  if (!sequence)
    log.info('twilio_status_unsequenced', {
      bindingId,
      carrierCallId: callSid,
      callStatus: fields.CallStatus,
    });
  const at = fields.Timestamp ? Date.parse(fields.Timestamp) : Number.NaN;
  return {
    eventId: `${callSid}:status:${sequence ?? required(fields, 'CallStatus')}`,
    occurredAt: Number.isFinite(at) ? new Date(at) : new Date(),
    payload: {
      sequenceNumber: sequence ?? null,
      ...(fields.CallbackSource ? { callbackSource: fields.CallbackSource.slice(0, 64) } : {}),
    },
  };
}

/** Logged, never applied: a stopped stream is not an ended call (the <Redirect> may resume it). */
export const streamStatusRoute: CarrierHttpRoute = {
  method: 'POST',
  purpose: 'stream-status',
  async handle(req, host) {
    try {
      const fields = await signed(req, host, 'stream-status');
      if (!fields) return reply(403);
      const carrierCallId = required(fields, 'CallSid');
      const event = required(fields, 'StreamEvent');
      if (!STREAM_EVENTS.has(event)) {
        log.warn('twilio_stream_status_unknown', {
          bindingId: req.bindingId,
          carrierCallId,
          streamEvent: event,
        });
        return reply(400);
      }
      log[event === 'stream-error' ? 'warn' : 'info']('twilio_stream_status', {
        bindingId: req.bindingId,
        carrierCallId,
        streamId: fields.StreamSid ?? null,
        streamEvent: event,
        ...(fields.StreamError ? { streamError: fields.StreamError.slice(0, 300) } : {}),
      });
      return reply(204);
    } catch (error) {
      return failure(error, req, 'stream-status');
    }
  },
};
