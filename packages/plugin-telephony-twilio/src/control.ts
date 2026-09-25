import twilio from 'twilio';
import type {
  DialReconciliation,
  DialResult,
  TelephonyControl,
  TelephonyDialRequest,
} from '@winsendotai/ovo-plugin-orchestration';

export interface TwilioVoiceClient {
  createCall(input: TwilioCreateCallInput): Promise<{ sid: string }>;
  updateCall(callSid: string, input: TwilioUpdateCallInput): Promise<void>;
  fetchCall(callSid: string): Promise<{ sid: string; status: string }>;
}

export interface TwilioCreateCallInput {
  to: string;
  from: string;
  twiml: string;
  statusCallback: string;
  statusCallbackEvent: Array<'initiated' | 'ringing' | 'answered' | 'completed'>;
}

export type TwilioUpdateCallInput =
  { status: 'completed' } | { twiml: string } | { url: string; method: 'POST' };

export interface DialReceiptLookup {
  findCarrierCallId(requestId: string): Promise<string | undefined>;
}

class SdkTwilioVoiceClient implements TwilioVoiceClient {
  private readonly client: ReturnType<typeof twilio>;

  constructor(accountSid: string, authToken: string) {
    this.client = twilio(accountSid, authToken);
  }

  async createCall(input: TwilioCreateCallInput): Promise<{ sid: string }> {
    const call = await this.client.calls.create(input);
    return { sid: call.sid };
  }

  async updateCall(callSid: string, input: TwilioUpdateCallInput): Promise<void> {
    await this.client.calls(callSid).update(input);
  }

  async fetchCall(callSid: string): Promise<{ sid: string; status: string }> {
    const call = await this.client.calls(callSid).fetch();
    return { sid: call.sid, status: call.status };
  }
}

function callbackWithRequestId(url: string, requestId: string): string {
  const callback = new URL(url);
  callback.searchParams.set('ovoRequestId', requestId);
  return callback.toString();
}

export function buildStreamTwiml(streamUrl: string, parameters: Record<string, string>): string {
  const response = new twilio.twiml.VoiceResponse();
  const stream = response.connect().stream({ url: streamUrl });
  for (const [name, value] of Object.entries(parameters)) stream.parameter({ name, value });
  return response.toString();
}

function classifyCreateError(error: unknown, requestId: string): DialResult {
  const candidate = error as { status?: unknown; code?: unknown; message?: unknown };
  const status = typeof candidate?.status === 'number' ? candidate.status : undefined;
  const reason =
    typeof candidate?.message === 'string' ? candidate.message : 'Twilio dial outcome unknown';
  if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return { kind: 'rejected', requestId, reason, retryable: false };
  }
  // A timeout/network/5xx response can happen after Twilio accepted the call. It must be reconciled, never blindly retried.
  return { kind: 'unknown', requestId, reason };
}

export class TwilioTelephonyControl implements TelephonyControl {
  private readonly client: TwilioVoiceClient;

  constructor(
    credentials: { accountSid: string; authToken: string },
    private readonly receiptLookup?: DialReceiptLookup,
    client?: TwilioVoiceClient,
  ) {
    this.client = client ?? new SdkTwilioVoiceClient(credentials.accountSid, credentials.authToken);
  }

  async dial(request: TelephonyDialRequest): Promise<DialResult> {
    try {
      const call = await this.client.createCall({
        to: request.to,
        from: request.from,
        twiml: buildStreamTwiml(request.streamUrl, {
          ovoJobId: request.jobId,
          ovoRequestId: request.requestId,
          ...request.streamParameters,
        }),
        statusCallback: callbackWithRequestId(request.statusCallbackUrl, request.requestId),
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      });
      return { kind: 'accepted', requestId: request.requestId, carrierCallId: call.sid };
    } catch (error) {
      return classifyCreateError(error, request.requestId);
    }
  }

  async reconcile(requestId: string, carrierCallId?: string): Promise<DialReconciliation> {
    const callSid = carrierCallId ?? (await this.receiptLookup?.findCarrierCallId(requestId));
    if (!callSid) return { kind: 'pending' };
    try {
      const call = await this.client.fetchCall(callSid);
      if (call.status === 'failed' || call.status === 'canceled')
        return { kind: 'rejected', reason: `Twilio call is ${call.status}` };
      return { kind: 'accepted', carrierCallId: call.sid };
    } catch {
      return { kind: 'pending' };
    }
  }

  async hangup(carrierCallId: string): Promise<void> {
    await this.client.updateCall(carrierCallId, { status: 'completed' });
  }

  async transfer(carrierCallId: string, target: { twiml?: string; url?: string }): Promise<void> {
    if ((target.twiml ? 1 : 0) + (target.url ? 1 : 0) !== 1)
      throw new Error('Transfer requires exactly one of twiml or url');
    const update: TwilioUpdateCallInput = target.twiml
      ? { twiml: target.twiml }
      : { url: target.url!, method: 'POST' };
    await this.client.updateCall(carrierCallId, update);
  }
}
