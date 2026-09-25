import {
  Cap,
  MULAW_8K,
  type CarrierCapabilities,
  type CarrierControlFactory,
  type DialRequest,
  type ResolvedBinding,
  type TelephonyControl,
} from '@winsendotai/ovo-contracts';
import { createTwilioHandoffProvider } from '@winsendotai/ovo-plugin-operations';
import { TwilioTelephonyControl } from '@winsendotai/ovo-plugin-telephony-twilio';
import { definePlugin } from '@winsendotai/ovo-runtime';

export const TWILIO_CAPABILITIES: CarrierCapabilities = {
  carrierId: 'twilio',
  media: {
    formats: [MULAW_8K],
    playbackEvidence: 'carrier-played',
    clear: true,
    clearFlushesMarkers: true,
    dtmf: true,
    queryOnMediaUrl: false,
  },
  control: {
    callIdTiming: 'at-dial',
    streamParams: 'at-dial',
    streamCallIdMatchesDial: true,
    cancelBeforeAnswer: false,
    handoff: ['phone', 'queue', 'resume', 'end'],
    amd: 'none',
    maxDuration: false,
    reconcile: 'by-call-id',
    hangup: 'rest',
  },
  continuation: 'markup-after-stream',
  webhookAuth: 'hmac-signature',
  pacing: { cps: 1 },
};

function requireMediaUrl(request: DialRequest): void {
  const url = new URL(request.media.url);
  if (url.protocol !== 'wss:' || url.search || url.hash || url.username || url.password)
    throw new TypeError('Twilio media URL must be a query-free wss URL');
}

function twilioControl(binding: ResolvedBinding): TelephonyControl {
  const accountSid = binding.config.accountSid;
  if (typeof accountSid !== 'string' || !accountSid.trim() || !binding.secret)
    throw new TypeError('Twilio account SID and credential are required');
  const old = new TwilioTelephonyControl({ accountSid, authToken: binding.secret });
  const handoff = createTwilioHandoffProvider({
    accountSid,
    authToken: binding.secret,
    resumeUrl: typeof binding.config.resumeUrl === 'string' ? binding.config.resumeUrl : undefined,
  });
  return {
    async dial(request) {
      try {
        requireMediaUrl(request);
      } catch {
        return {
          kind: 'rejected',
          requestId: request.requestId,
          reason: 'Twilio media URL must be a query-free wss URL',
          retryable: false,
        };
      }
      return old.dial({
        requestId: request.requestId,
        jobId: request.jobId,
        workspaceId: binding.workspaceId,
        to: request.to,
        from: request.from,
        streamUrl: request.media.url,
        streamParameters: request.media.routeParams,
        statusCallbackUrl: request.callbacks.status,
      });
    },
    async reconcile(query) {
      const result = await old.reconcile(query.requestId, query.carrierCallId);
      if (result.kind === 'accepted')
        return { kind: 'live', carrierCallId: result.carrierCallId, state: 'queued' };
      return result;
    },
    async hangup(query) {
      if (!query.carrierCallId) return 'unsupported';
      await old.hangup(query.carrierCallId);
      return 'ended';
    },
    handoff(carrierCallId, target, requestId) {
      if (target.kind === 'resume' || target.kind === 'end')
        return handoff.fallback({
          requestId,
          carrierCallId,
          fallback:
            target.kind === 'resume'
              ? { kind: 'resume', message: '' }
              : { kind: 'end', message: target.message },
        });
      return handoff.request({
        requestId,
        carrierCallId,
        target:
          target.kind === 'phone'
            ? { kind: 'phone', value: target.e164 }
            : { kind: 'queue', value: target.name },
      });
    },
  };
}

export const twilioCarrierBridge = definePlugin(
  {
    id: '@winsendotai/ovo-carrier-twilio',
    version: '0.1.0',
    contractVersion: 2,
    scope: 'process',
    kind: 'carrier',
    provider: 'twilio',
    requires: [],
    provides: [Cap.carrierControl],
    configSchema: { type: 'object', additionalProperties: false },
    bindingSchema: {
      type: 'object',
      required: ['accountSid'],
      properties: { accountSid: { type: 'string' }, resumeUrl: { type: 'string' } },
    },
    secretFields: [],
    capabilities: TWILIO_CAPABILITIES,
    meters: [
      {
        key: 'twilio.carrier.audio_seconds',
        unit: 'audio_seconds',
        label: 'Twilio call audio',
        role: 'carrier',
      },
    ],
    runtime: { egressHosts: ['api.twilio.com'], modelLicences: [] },
    conformance: ['carrier@1'],
  },
  (ctx) => {
    const control: CarrierControlFactory = {
      capabilities: TWILIO_CAPABILITIES,
      create: twilioControl,
    };
    ctx.provide(Cap.carrierControl, control);
  },
);
