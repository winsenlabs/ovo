import { Cap, type NetPort } from '@winsendotai/ovo-contracts';
import { errorFields } from '@winsendotai/ovo-plugin-kit';
import { definePlugin } from '@winsendotai/ovo-runtime';
import { encodeTwilioForm, type TwilioForm } from './form.ts';
import { twilioLog as log } from './log.ts';
import { xml } from './markup.ts';

export interface TwilioCreateCallInput {
  to: string;
  from: string;
  twiml: string;
  statusCallback: string;
  statusCallbackEvent: Array<'initiated' | 'ringing' | 'answered' | 'completed'>;
}
export type TwilioUpdateCallInput =
  { status: 'completed' } | { twiml: string } | { url: string; method: 'POST' };
export interface TwilioVoiceClient {
  createCall(input: TwilioCreateCallInput): Promise<{ sid: string }>;
  updateCall(callSid: string, input: TwilioUpdateCallInput): Promise<void>;
  fetchCall(callSid: string): Promise<{ sid: string; status: string }>;
}
export interface DialReceiptLookup {
  findCarrierCallId(requestId: string): Promise<string | undefined>;
}
export interface LegacyDialRequest {
  workspaceId?: string;
  requestId: string;
  jobId: string;
  to: string;
  from: string;
  streamUrl: string;
  statusCallbackUrl: string;
  streamParameters?: Record<string, string>;
}
export type LegacyDialResult =
  | { kind: 'accepted'; requestId: string; carrierCallId: string }
  | { kind: 'rejected'; requestId: string; reason: string; retryable: boolean }
  | { kind: 'unknown'; requestId: string; reason: string };

export function buildStreamTwiml(streamUrl: string, parameters: Record<string, string>): string {
  if (!streamUrl.startsWith('wss://') || new URL(streamUrl).search)
    throw new Error('Twilio Stream URL must be wss without query');
  const entries = Object.entries(parameters)
    .map(([name, value]) => `<Parameter name="${xml(name)}" value="${xml(value)}"/>`)
    .join('');
  return `<Response><Connect><Stream url="${xml(streamUrl)}">${entries}</Stream></Connect></Response>`;
}

function netClient(
  credentials: { accountSid: string; authToken: string },
  net: NetPort,
): TwilioVoiceClient {
  const base = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(credentials.accountSid)}/Calls`;
  const authorization = `Basic ${btoa(`${credentials.accountSid}:${credentials.authToken}`)}`;
  const request = async (url: string, method: 'GET' | 'POST', fields?: TwilioForm) => {
    const response = await net.fetch(url, {
      method,
      headers: {
        authorization,
        ...(fields ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(fields ? { body: encodeTwilioForm(fields) } : {}),
    });
    if (!response.ok)
      throw Object.assign(new Error(`Twilio HTTP ${response.status}`), { status: response.status });
    return response.json() as Promise<{ sid: string; status: string }>;
  };
  return {
    createCall: async (input) => {
      const body = await request(`${base}.json`, 'POST', {
        To: input.to,
        From: input.from,
        Twiml: input.twiml,
        StatusCallback: input.statusCallback,
        StatusCallbackEvent: input.statusCallbackEvent,
      });
      return { sid: body.sid };
    },
    updateCall: async (sid, input) => {
      await request(
        `${base}/${encodeURIComponent(sid)}.json`,
        'POST',
        'status' in input
          ? { Status: input.status }
          : 'twiml' in input
            ? { Twiml: input.twiml }
            : { Url: input.url, Method: input.method },
      );
    },
    fetchCall: async (sid) => request(`${base}/${encodeURIComponent(sid)}.json`, 'GET'),
  };
}

/** Transitional v1 adapter; new carrier control uses the v2 contract above. */
export class TwilioTelephonyControl {
  private readonly client: TwilioVoiceClient;
  constructor(
    credentials: { accountSid: string; authToken: string },
    private readonly receiptLookup?: DialReceiptLookup,
    client?: TwilioVoiceClient,
    net?: NetPort,
  ) {
    // The transition bridge still constructs this class before catalog supersession. A missing
    // host NetPort cannot fall back to global fetch without bypassing the carrier egress guard.
    this.client =
      client ??
      (net
        ? netClient(credentials, net)
        : {
            async createCall() {
              throw new Error('Legacy Twilio control has no host NetPort');
            },
            async updateCall() {
              throw new Error('Legacy Twilio control has no host NetPort');
            },
            async fetchCall() {
              throw new Error('Legacy Twilio control has no host NetPort');
            },
          });
  }
  async dial(request: LegacyDialRequest): Promise<LegacyDialResult> {
    try {
      const callback = new URL(request.statusCallbackUrl);
      callback.searchParams.set('ovoRequestId', request.requestId);
      const call = await this.client.createCall({
        to: request.to,
        from: request.from,
        twiml: buildStreamTwiml(request.streamUrl, {
          ovoJobId: request.jobId,
          ovoRequestId: request.requestId,
          ...request.streamParameters,
        }),
        statusCallback: callback.href,
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      });
      return { kind: 'accepted', requestId: request.requestId, carrierCallId: call.sid };
    } catch (error) {
      const status = (error as { status?: number }).status;
      const reason = error instanceof Error ? error.message : String(error);
      if (status && status >= 400 && status < 500 && status !== 408 && status !== 429)
        return { kind: 'rejected', requestId: request.requestId, reason, retryable: false };
      return { kind: 'unknown', requestId: request.requestId, reason };
    }
  }
  async reconcile(
    requestId: string,
    carrierCallId?: string,
  ): Promise<
    | { kind: 'pending' }
    | { kind: 'accepted'; carrierCallId: string }
    | { kind: 'rejected'; reason: string }
  > {
    const sid = carrierCallId ?? (await this.receiptLookup?.findCarrierCallId(requestId));
    if (!sid) return { kind: 'pending' };
    try {
      const call = await this.client.fetchCall(sid);
      if (['failed', 'canceled', 'busy', 'no-answer'].includes(call.status))
        return { kind: 'rejected', reason: `Twilio call is ${call.status}` };
      return { kind: 'accepted', carrierCallId: call.sid };
    } catch (error) {
      log.warn('twilio_reconcile_pending', {
        requestId,
        carrierCallId: sid,
        ...errorFields(error),
      });
      return { kind: 'pending' };
    }
  }
  async hangup(carrierCallId: string): Promise<void> {
    await this.client.updateCall(carrierCallId, { status: 'completed' });
  }
  async transfer(carrierCallId: string, target: { twiml?: string; url?: string }): Promise<void> {
    if ((target.twiml ? 1 : 0) + (target.url ? 1 : 0) !== 1)
      throw new Error('Transfer requires exactly one of twiml or url');
    await this.client.updateCall(
      carrierCallId,
      target.twiml ? { twiml: target.twiml } : { url: target.url!, method: 'POST' },
    );
  }
}

export const twilioTelephonyPlugin = definePlugin(
  {
    id: '@winsendotai/ovo-plugin-telephony-twilio',
    version: '0.1.0',
    contractVersion: 1,
    scope: 'process',
    requires: [],
    provides: [Cap.legacyTelephony, Cap.legacyMediaProtocol],
    configSchema: {
      type: 'object',
      required: ['accountSid', 'authToken'],
      properties: { accountSid: { type: 'string' }, authToken: { type: 'string' } },
      additionalProperties: false,
    },
    secretFields: ['accountSid', 'authToken'],
    ui: { label: 'Twilio Programmable Voice' },
  },
  (ctx, config) => {
    const accountSid = String(config.accountSid ?? '');
    const authToken = String(config.authToken ?? '');
    ctx.provide(
      Cap.legacyTelephony,
      new TwilioTelephonyControl(
        { accountSid, authToken },
        undefined,
        undefined,
        (ctx as unknown as { net: NetPort }).net,
      ),
    );
    ctx.provide(
      Cap.legacyMediaProtocol,
      Object.freeze({
        codec: 'audio/x-mulaw',
        sampleRate: 8000,
        channels: 1,
        inboundTrack: true,
        outboundTrack: false,
        mark: true,
        clear: true,
        playbackEvidence: 'carrier-buffer-complete-not-human-hearing',
      }),
    );
  },
);
