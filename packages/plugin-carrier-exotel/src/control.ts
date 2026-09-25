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
import { exotelCapabilities } from './capabilities.ts';
import { basicAuthorization } from './signature.ts';
import { mapExotelStatus } from './status-map.ts';

interface ExotelConfig {
  accountSid: string;
  apiKey: string;
  exophone: string;
  appId: string;
  region: 'in' | 'sg';
  sampleRate: 8000 | 16000;
}

function config(binding: ResolvedBinding): ExotelConfig {
  const {
    accountSid,
    apiKey,
    exophone,
    appId,
    region = 'in',
    sampleRate = 8000,
    streamEndTerminatesCall,
  } = binding.config;
  if (
    ![accountSid, apiKey, exophone, appId].every(
      (value) => typeof value === 'string' && value.length > 0 && value.length <= 256,
    ) ||
    (region !== 'in' && region !== 'sg') ||
    (sampleRate !== 8000 && sampleRate !== 16000) ||
    streamEndTerminatesCall !== true ||
    !binding.secret
  )
    throw new Error('Invalid Exotel binding');
  return {
    accountSid: accountSid as string,
    apiKey: apiKey as string,
    exophone: exophone as string,
    appId: appId as string,
    region,
    sampleRate,
  };
}

function url(binding: ResolvedBinding, callSid?: string): string {
  const selected = config(binding);
  const host = selected.region === 'in' ? 'api.in.exotel.com' : 'api.exotel.com';
  const account = encodeURIComponent(selected.accountSid);
  return callSid
    ? `https://${host}/v1/Accounts/${account}/Calls/${encodeURIComponent(callSid)}.json`
    : `https://${host}/v1/Accounts/${account}/Calls/connect.json`;
}

async function exotelJson(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await response.json();
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function callObject(
  body: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const call = body?.Call;
  return call && typeof call === 'object' && !Array.isArray(call)
    ? (call as Record<string, unknown>)
    : undefined;
}

export class ExotelControl implements TelephonyControl {
  constructor(
    private readonly net: NetPort,
    private readonly binding: ResolvedBinding,
  ) {}

  async dial(request: DialRequest): Promise<DialResult> {
    if (request.amd && request.amd.mode !== 'off')
      return this.rejected(request.requestId, 'Exotel does not support AMD');
    let selected: ExotelConfig;
    try {
      const media = new URL(request.media.url);
      if (
        media.protocol !== 'wss:' ||
        media.search ||
        media.hash ||
        media.username ||
        media.password
      )
        return this.rejected(request.requestId, 'Exotel media URL must be wss without a query');
      selected = config(this.binding);
      if (selected.sampleRate === 16000)
        return this.rejected(
          request.requestId,
          'Exotel 16 kHz requires a fourth media URL query pair',
        );
      if (
        request.media.format.encoding !== 'pcm_s16le' ||
        request.media.format.sampleRate !== selected.sampleRate ||
        request.media.format.channels !== 1
      )
        return this.rejected(request.requestId, 'Exotel dial media format differs from binding');
      if (!request.requestId || request.requestId.length > 128)
        return this.rejected(request.requestId, 'Invalid Exotel CustomField request id');
      if (
        !Number.isSafeInteger(request.maxDurationSec) ||
        request.maxDurationSec < 1 ||
        request.maxDurationSec > 14400
      )
        return this.rejected(request.requestId, 'Invalid Exotel TimeLimit');
    } catch {
      return this.rejected(request.requestId, 'Invalid Exotel media URL or binding');
    }
    const fields = new URLSearchParams({
      From: request.to,
      CallerId: selected.exophone,
      Url: `http://my.exotel.com/${encodeURIComponent(selected.accountSid)}/exoml/start_voice/${encodeURIComponent(selected.appId)}`,
      TimeLimit: String(request.maxDurationSec),
      TimeOut: String(request.ringTimeoutSec ?? 45),
      StatusCallback: request.callbacks.status,
      'StatusCallbackEvents[0]': 'terminal',
      'StatusCallbackEvents[1]': 'answered',
      CustomField: request.requestId,
    });
    try {
      const response = await this.net.fetch(url(this.binding), {
        method: 'POST',
        headers: {
          authorization: basicAuthorization(selected.apiKey, this.binding.secret),
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: fields.toString(),
      });
      if (!response.ok) {
        const reason = `Exotel HTTP ${response.status}`;
        return response.status >= 400 &&
          response.status < 500 &&
          ![408, 429].includes(response.status)
          ? this.rejected(request.requestId, reason)
          : { kind: 'unknown', requestId: request.requestId, reason };
      }
      const call = callObject(await exotelJson(response));
      const sid = call?.Sid;
      return typeof sid === 'string' && sid
        ? { kind: 'accepted', requestId: request.requestId, carrierCallId: sid }
        : { kind: 'unknown', requestId: request.requestId, reason: 'Exotel returned no Call.Sid' };
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
    try {
      const selected = config(this.binding);
      const response = await this.net.fetch(url(this.binding, query.carrierCallId), {
        method: 'GET',
        headers: { authorization: basicAuthorization(selected.apiKey, this.binding.secret) },
      });
      if (!response.ok) return { kind: 'pending' };
      const call = callObject(await exotelJson(response));
      const state = typeof call?.Status === 'string' ? mapExotelStatus(call.Status) : undefined;
      if (!state) return { kind: 'pending' };
      const carrierCallId = typeof call?.Sid === 'string' ? call.Sid : query.carrierCallId;
      if (state === 'queued' || state === 'ringing' || state === 'in_progress')
        return { kind: 'live', state, carrierCallId };
      const answer = String(call?.AnsweredBy ?? '').toLowerCase();
      const answeredBy =
        answer === 'human' ? 'human' : answer === 'machine' ? 'machine' : 'unknown';
      return { kind: 'ended', state, carrierCallId, answeredBy };
    } catch {
      return { kind: 'pending' };
    }
  }

  async hangup(): Promise<'unsupported'> {
    return 'unsupported';
  }

  async handoff(_carrierCallId: string, target: HandoffTarget, _requestId: string) {
    return {
      kind: 'rejected' as const,
      retryable: false,
      reason:
        target.kind === 'end'
          ? 'Exotel end handoff requires gateway stream closure'
          : `Exotel ${target.kind} handoff is unsupported`,
    };
  }

  private rejected(requestId: string, reason: string): DialResult {
    return { kind: 'rejected', requestId, retryable: false, reason };
  }
}

export function exotelControlFactory(net: NetPort): CarrierControlFactory {
  return { capabilities: exotelCapabilities, create: (binding) => new ExotelControl(net, binding) };
}
