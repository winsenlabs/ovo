import type {
  CarrierControlFactory,
  DialRequest,
  DialResult,
  HandoffTarget,
  NetPort,
  Reconciliation,
  ResolvedBinding,
  TelephonyControl,
} from '@winsendotai/ovo-contracts';
import { errorFields } from '@winsendotai/ovo-plugin-kit';
import { twilioCapabilities } from './capabilities.ts';
import { encodeTwilioForm, type TwilioForm } from './form.ts';
import { twilioLog as log } from './log.ts';
import { connectMarkup, handoffMarkup, secureUrl } from './markup.ts';
import { mapAnsweredBy, mapTwilioStatus } from './status-map.ts';

const restUrl = (sid: string, callSid?: string) =>
  `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Calls${callSid ? `/${encodeURIComponent(callSid)}` : ''}.json`;

function accountSid(binding: ResolvedBinding): string {
  const value = binding.config.accountSid;
  if (typeof value !== 'string' || !/^AC[0-9a-f]{32}$/i.test(value))
    throw new Error('Invalid Twilio accountSid binding');
  return value;
}

async function call(
  net: NetPort,
  binding: ResolvedBinding,
  url: string,
  method: 'GET' | 'POST',
  fields?: TwilioForm,
): Promise<Response> {
  const headers: Record<string, string> = {
    authorization: `Basic ${btoa(`${accountSid(binding)}:${binding.secret}`)}`,
  };
  if (fields) headers['content-type'] = 'application/x-www-form-urlencoded';
  return net.fetch(url, {
    method,
    headers,
    ...(fields ? { body: encodeTwilioForm(fields) } : {}),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Twilio response is not an object');
  return value as Record<string, unknown>;
}

function reason(response: Response): string {
  return `Twilio HTTP ${response.status}`;
}

function resumeFields(target: Extract<HandoffTarget, { kind: 'resume' }>, bindingId: string) {
  if (!target.resumeUrl) throw new Error('Twilio resume URL is unavailable');
  const raw = secureUrl(target.resumeUrl, 'https:');
  const url = new URL(raw);
  if (
    url.pathname !== `/carriers/twilio/${encodeURIComponent(bindingId)}/resume` ||
    !url.searchParams.get('r') ||
    !url.searchParams.get('t')
  )
    throw new Error('Twilio resume URL must be a binding-scoped authenticated host callback');
  return { Url: raw, Method: 'POST' };
}

export class TwilioCarrierControl implements TelephonyControl {
  constructor(
    private readonly net: NetPort,
    private readonly binding: ResolvedBinding,
  ) {}

  async dial(request: DialRequest): Promise<DialResult> {
    let markup: string;
    try {
      markup = connectMarkup({
        mediaUrl: request.media.url,
        routeParams: request.media.routeParams,
        resumeUrl: request.callbacks.resume,
      });
    } catch (error) {
      return {
        kind: 'rejected',
        requestId: request.requestId,
        retryable: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    const fields: TwilioForm = {
      To: request.to,
      From: request.from,
      Twiml: markup,
      StatusCallback: request.callbacks.status,
      StatusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      StatusCallbackMethod: 'POST',
      TimeLimit: String(request.maxDurationSec),
      Timeout: String(request.ringTimeoutSec ?? 60),
    };
    if (request.amd && request.amd.mode !== 'off') {
      if (!request.callbacks.amd)
        return {
          kind: 'rejected',
          requestId: request.requestId,
          retryable: false,
          reason: 'Twilio AMD callback is missing',
        };
      fields.MachineDetection = 'DetectMessageEnd';
      fields.AsyncAmd = 'true';
      fields.AsyncAmdStatusCallback = request.callbacks.amd;
    }
    try {
      const response = await call(
        this.net,
        this.binding,
        restUrl(accountSid(this.binding)),
        'POST',
        fields,
      );
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500 && response.status !== 408)
          return {
            kind: 'rejected',
            requestId: request.requestId,
            retryable: response.status === 429,
            reason: reason(response),
          };
        return { kind: 'unknown', requestId: request.requestId, reason: reason(response) };
      }
      const receipt = await json(response);
      if (typeof receipt.sid !== 'string' || !receipt.sid)
        return {
          kind: 'unknown',
          requestId: request.requestId,
          reason: 'Twilio did not return a call SID',
        };
      return { kind: 'accepted', requestId: request.requestId, carrierCallId: receipt.sid };
    } catch (error) {
      return {
        kind: 'unknown',
        requestId: request.requestId,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async reconcile(query: { requestId: string; carrierCallId?: string }): Promise<Reconciliation> {
    if (!query.carrierCallId) return { kind: 'pending' };
    // Every 'pending' below is retried by the caller; the log says why it is still pending.
    const pending = (fields: Record<string, unknown>): Reconciliation => {
      log.warn('twilio_reconcile_pending', {
        requestId: query.requestId,
        carrierCallId: query.carrierCallId,
        bindingId: this.binding.bindingId,
        ...fields,
      });
      return { kind: 'pending' };
    };
    try {
      const response = await call(
        this.net,
        this.binding,
        restUrl(accountSid(this.binding), query.carrierCallId),
        'GET',
      );
      if (!response.ok) return pending({ status: response.status });
      const body = await json(response);
      const state = typeof body.status === 'string' ? mapTwilioStatus(body.status) : undefined;
      if (!state) return pending({ error: 'unmapped Twilio call status', callStatus: body.status });
      const carrierCallId = typeof body.sid === 'string' ? body.sid : query.carrierCallId;
      if (state === 'queued' || state === 'ringing' || state === 'in_progress')
        return { kind: 'live', state, carrierCallId };
      return {
        kind: 'ended',
        state,
        carrierCallId,
        ...(typeof body.answered_by === 'string'
          ? { answeredBy: mapAnsweredBy(body.answered_by) }
          : {}),
      };
    } catch (error) {
      return pending(errorFields(error));
    }
  }

  async hangup(query: {
    carrierCallId?: string;
  }): Promise<'ended' | 'already_ended' | 'unsupported'> {
    if (!query.carrierCallId) return 'unsupported';
    const response = await call(
      this.net,
      this.binding,
      restUrl(accountSid(this.binding), query.carrierCallId),
      'POST',
      { Status: 'completed' },
    );
    if (response.ok) return 'ended';
    if (response.status === 404) return 'already_ended';
    // swallow-ok: the error body is optional; the HTTP status below decides the outcome.
    const body: Record<string, unknown> = await json(response).catch(() => ({}));
    if (body.code === 20404) return 'already_ended';
    throw new Error(reason(response));
  }

  async handoff(carrierCallId: string, target: HandoffTarget, requestId: string) {
    let fields: Record<string, string>;
    try {
      fields =
        target.kind === 'resume'
          ? resumeFields(target, this.binding.bindingId)
          : { Twiml: handoffMarkup(target) };
    } catch (error) {
      return {
        kind: 'rejected' as const,
        retryable: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    try {
      const response = await call(
        this.net,
        this.binding,
        restUrl(accountSid(this.binding), carrierCallId),
        'POST',
        fields,
      );
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500 && response.status !== 408)
          return {
            kind: 'rejected' as const,
            retryable: response.status === 429,
            reason: reason(response),
          };
        return { kind: 'unknown' as const, reason: reason(response) };
      }
      const body = await json(response);
      if (typeof body.sid !== 'string' || !body.sid)
        return { kind: 'unknown' as const, reason: 'Twilio returned no handoff receipt' };
      return { kind: 'confirmed' as const, receiptId: `twilio:${body.sid}:${requestId}` };
    } catch (error) {
      return {
        kind: 'unknown' as const,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export function twilioControlFactory(net: NetPort): CarrierControlFactory {
  return {
    capabilities: twilioCapabilities,
    create(binding) {
      return new TwilioCarrierControl(net, binding);
    },
  };
}
