import { createHash } from 'node:crypto';
import twilio from 'twilio';
import { normalizePhoneNumber } from './csv.ts';
import type {
  HandoffFallback,
  HandoffProviderPort,
  HandoffProviderResult,
  HandoffTarget,
} from './types.ts';

export interface TwilioHandoffUpdate {
  twiml?: string;
  url?: string;
  method?: 'POST';
}

export interface TwilioHandoffReceipt {
  sid: string;
  dateUpdated?: Date | string | null;
  status?: string;
}

export interface TwilioHandoffClient {
  updateCall(callSid: string, update: TwilioHandoffUpdate): Promise<TwilioHandoffReceipt>;
}

export interface TwilioHandoffProviderOptions {
  accountSid: string;
  authToken: string;
  resumeUrl?: string;
  client?: TwilioHandoffClient;
}

function ensureHttps(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new Error('Twilio handoff resume URL must be an HTTPS URL without credentials');
  return url.toString();
}

function xml(value: string): string {
  const invalidXmlControl = /[\x00-\x08\x0b\x0c\x0e-\x1f]/u;
  if (invalidXmlControl.test(value))
    throw new Error('Twilio handoff text contains invalid XML characters');
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function targetTwiml(target: HandoffTarget): string {
  if (target.kind === 'phone') {
    const phone = normalizePhoneNumber(target.value);
    return `<Response><Dial><Number>${xml(phone)}</Number></Dial></Response>`;
  }
  if (!/^[\x20-\x7e]{1,200}$/.test(target.value)) throw new Error('Invalid Twilio queue name');
  return `<Response><Enqueue>${xml(target.value)}</Enqueue></Response>`;
}

function fallbackUpdate(
  fallback: HandoffFallback,
  resumeUrl: string | undefined,
): TwilioHandoffUpdate {
  if (fallback.kind === 'resume') {
    if (!resumeUrl) throw new Error('Twilio resume fallback URL is not configured');
    return { url: resumeUrl, method: 'POST' };
  }
  const message = `<Say>${xml(fallback.message)}</Say>`;
  if (fallback.kind === 'end') return { twiml: `<Response>${message}<Hangup/></Response>` };
  const target = normalizePhoneNumber(fallback.target);
  return {
    twiml: `<Response>${message}<Dial><Number>${xml(target)}</Number></Dial></Response>`,
  };
}

function providerError(error: unknown): HandoffProviderResult {
  const status = (error as { status?: unknown })?.status;
  if (
    typeof status === 'number' &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
  )
    return { kind: 'rejected', retryable: false, reason: `Twilio rejected handoff (${status})` };
  return { kind: 'unknown', reason: 'Twilio handoff outcome is unknown' };
}

function receiptId(receipt: TwilioHandoffReceipt, requestId: string): string {
  const timestamp =
    receipt.dateUpdated instanceof Date
      ? receipt.dateUpdated.toISOString()
      : (receipt.dateUpdated ?? 'not-provided');
  const digest = createHash('sha256')
    .update(`${receipt.sid}\0${timestamp}\0${requestId}`)
    .digest('hex');
  return `twilio-update:${digest}`;
}

export class TwilioHandoffProvider implements HandoffProviderPort {
  constructor(
    private readonly client: TwilioHandoffClient,
    private readonly resumeUrl?: string,
  ) {}

  private async update(
    requestId: string,
    carrierCallId: string,
    update: TwilioHandoffUpdate,
  ): Promise<HandoffProviderResult> {
    try {
      const receipt = await this.client.updateCall(carrierCallId, update);
      if (!receipt.sid) return { kind: 'unknown', reason: 'Twilio returned no call receipt' };
      return { kind: 'confirmed', receiptId: receiptId(receipt, requestId) };
    } catch (error) {
      return providerError(error);
    }
  }

  request(input: {
    requestId: string;
    carrierCallId: string;
    target: HandoffTarget;
  }): Promise<HandoffProviderResult> {
    try {
      return this.update(input.requestId, input.carrierCallId, {
        twiml: targetTwiml(input.target),
      });
    } catch (error) {
      return Promise.resolve({
        kind: 'rejected',
        retryable: false,
        reason: (error as Error).message,
      });
    }
  }

  async reconcile(_requestId: string): Promise<{ kind: 'pending' }> {
    // Twilio call updates cannot be looked up by our request ID. Unknown remains fail-closed.
    return { kind: 'pending' };
  }

  fallback(input: {
    requestId: string;
    carrierCallId: string;
    fallback: HandoffFallback;
  }): Promise<HandoffProviderResult> {
    try {
      return this.update(
        input.requestId,
        input.carrierCallId,
        fallbackUpdate(input.fallback, this.resumeUrl),
      );
    } catch (error) {
      return Promise.resolve({
        kind: 'rejected',
        retryable: false,
        reason: (error as Error).message,
      });
    }
  }
}

export function createTwilioHandoffProvider(
  options: TwilioHandoffProviderOptions,
): TwilioHandoffProvider {
  const resumeUrl = ensureHttps(options.resumeUrl);
  if (options.client) return new TwilioHandoffProvider(options.client, resumeUrl);
  if (!options.accountSid.trim() || !options.authToken.trim())
    throw new Error('Twilio handoff credentials are required');
  const client = twilio(options.accountSid, options.authToken);
  return new TwilioHandoffProvider(
    {
      async updateCall(callSid, update) {
        const receipt = await client.calls(callSid).update(update);
        return { sid: receipt.sid, dateUpdated: receipt.dateUpdated, status: receipt.status };
      },
    },
    resumeUrl,
  );
}
