import type {
  CarrierCapabilities,
  CarrierControlFactory,
  DialRequest,
  DialResult,
  HandoffTarget,
  HangupQuery,
  Logger,
  Reconciliation,
  ResolvedBinding,
  SipTrunkControlClient,
  TelephonyControl,
} from '@winsendotai/ovo-contracts';
import {
  SIP_TRUNK_ID,
  SipCredentialsSchema,
  SipDialResponseSchema,
  SipHandoffResponseSchema,
  SipHangupResponseSchema,
  SipReconcileResponseSchema,
  type SipCredentials,
  type SipDialRequest,
} from './wire.ts';

export const SIP_TRUNK_UNAVAILABLE = 'sip_trunk_unavailable';

/** The binding secret is empty (IP-authenticated trunk) or JSON `{username, password}` (digest). */
export function parseSipCredentials(secret: string): SipCredentials | null {
  if (!secret.trim()) return null;
  let value: unknown;
  try {
    value = JSON.parse(secret);
  } catch {
    throw new TypeError('The SIP binding secret is not JSON');
  }
  const parsed = SipCredentialsSchema.safeParse(value);
  if (!parsed.success) throw new TypeError('The SIP binding secret needs username and password');
  return parsed.data;
}

function mediaUrlProblem(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'wss:') return 'media URL must use wss';
    if (parsed.search || parsed.hash) return 'media URL must not carry a query';
    return undefined;
  } catch {
    return 'media URL is not a URL';
  }
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

interface ControlInput {
  capabilities: CarrierCapabilities;
  client: () => SipTrunkControlClient | undefined;
  /** The reason a binding may not dial, or undefined when it may. */
  dialAllowed?: (binding: ResolvedBinding) => string | undefined;
  logger?: Logger;
}

class SipTelephonyControl implements TelephonyControl {
  constructor(
    private readonly input: ControlInput,
    private readonly binding: ResolvedBinding,
  ) {}

  private get carrierId() {
    return this.input.capabilities.carrierId;
  }

  async dial(request: DialRequest): Promise<DialResult> {
    const refuse = (reason: string, retryable = false): DialResult => ({
      kind: 'rejected',
      requestId: request.requestId,
      reason,
      retryable,
    });
    const urlProblem = mediaUrlProblem(request.media.url);
    if (urlProblem) return refuse(urlProblem);
    const refused = this.input.dialAllowed?.(this.binding);
    if (refused) return refuse(refused);
    const trunkId = this.binding.config.trunkId;
    if (typeof trunkId !== 'string' || !SIP_TRUNK_ID.test(trunkId))
      return refuse('binding_missing_trunk');
    const fromNumbers = this.binding.config.fromNumbers;
    if (Array.isArray(fromNumbers) && fromNumbers.length && !fromNumbers.includes(request.from))
      return refuse('from_not_permitted');
    let credentials: SipCredentials | null;
    try {
      credentials = parseSipCredentials(this.binding.secret);
    } catch (error) {
      return refuse(reasonOf(error));
    }
    const client = this.input.client();
    if (!client) return refuse(SIP_TRUNK_UNAVAILABLE);
    const body: SipDialRequest = {
      requestId: request.requestId,
      carrierId: this.carrierId,
      bindingId: this.binding.bindingId,
      trunkId,
      to: request.to,
      from: request.from,
      media: { url: request.media.url, routeParams: request.media.routeParams },
      callbacks: {
        status: request.callbacks.status,
        ...(request.callbacks.resume ? { resume: request.callbacks.resume } : {}),
      },
      ...(request.ringTimeoutSec !== undefined ? { ringTimeoutSec: request.ringTimeoutSec } : {}),
      maxDurationSec: request.maxDurationSec,
      credentials,
    };
    try {
      const response = await client.request({ method: 'POST', path: '/v1/calls', body });
      const parsed = SipDialResponseSchema.safeParse(response.body);
      if (response.status === 200 && parsed.success && parsed.data.kind === 'accepted')
        return {
          kind: 'accepted',
          requestId: request.requestId,
          carrierCallId: parsed.data.carrierCallId,
          carrierRequestId: parsed.data.carrierRequestId,
        };
      if (parsed.success && parsed.data.kind === 'rejected')
        return refuse(parsed.data.reason, parsed.data.retryable ?? response.status === 503);
      if (response.status >= 400 && response.status < 500)
        return refuse(`sip-gateway HTTP ${response.status}`);
      return {
        kind: 'unknown',
        requestId: request.requestId,
        reason: `sip-gateway HTTP ${response.status}`,
      };
    } catch (error) {
      return { kind: 'unknown', requestId: request.requestId, reason: reasonOf(error) };
    }
  }

  async reconcile(query: {
    requestId: string;
    carrierCallId?: string;
    carrierRequestId?: string;
  }): Promise<Reconciliation> {
    // Nothing reached the trunk without an id from dial, so there is nothing to look up.
    if (!query.carrierRequestId && !query.carrierCallId) return { kind: 'pending' };
    const pending = (fields: Record<string, unknown>): Reconciliation => {
      this.input.logger?.warn('sip_reconcile_pending', {
        carrierId: this.carrierId,
        bindingId: this.binding.bindingId,
        requestId: query.requestId,
        ...fields,
      });
      return { kind: 'pending' };
    };
    const client = this.input.client();
    if (!client) return pending({ error: SIP_TRUNK_UNAVAILABLE });
    try {
      const response = await client.request({
        method: 'GET',
        path: '/v1/calls',
        query: { requestId: query.carrierRequestId ?? query.requestId },
      });
      const parsed = SipReconcileResponseSchema.safeParse(response.body);
      if (response.status !== 200 || !parsed.success) return pending({ status: response.status });
      return parsed.data;
    } catch (error) {
      return pending({ error: reasonOf(error) });
    }
  }

  async hangup(query: HangupQuery): Promise<'ended' | 'already_ended' | 'unsupported'> {
    if (!query.carrierCallId && !query.carrierRequestId) return 'unsupported';
    const client = this.input.client();
    if (!client) throw new Error(SIP_TRUNK_UNAVAILABLE);
    const response = await client.request({
      method: 'POST',
      path: '/v1/calls/hangup',
      body: {
        ...(query.carrierCallId ? { carrierCallId: query.carrierCallId } : {}),
        ...(query.carrierRequestId ? { carrierRequestId: query.carrierRequestId } : {}),
      },
    });
    const parsed = SipHangupResponseSchema.safeParse(response.body);
    if (response.status === 200 && parsed.success) return parsed.data.result;
    throw new Error(`sip-gateway hangup HTTP ${response.status}`);
  }

  async handoff(carrierCallId: string, target: HandoffTarget, requestId: string) {
    if (target.kind !== 'phone' || !this.input.capabilities.control.handoff.includes('phone'))
      return {
        kind: 'rejected' as const,
        retryable: false,
        reason: `handoff to ${target.kind} is not supported`,
      };
    const client = this.input.client();
    if (!client)
      return { kind: 'rejected' as const, retryable: false, reason: SIP_TRUNK_UNAVAILABLE };
    try {
      const response = await client.request({
        method: 'POST',
        path: '/v1/calls/handoff',
        body: { carrierCallId, requestId, target },
      });
      const parsed = SipHandoffResponseSchema.safeParse(response.body);
      if (parsed.success) return parsed.data;
      return { kind: 'unknown' as const, reason: `sip-gateway HTTP ${response.status}` };
    } catch (error) {
      return { kind: 'unknown' as const, reason: reasonOf(error) };
    }
  }
}

/** TelephonyControl over the host's `Cap.sipTrunkControl` client, resolved per call (§6). */
export function createSipControlFactory(input: ControlInput): CarrierControlFactory {
  return {
    capabilities: input.capabilities,
    create(binding) {
      return new SipTelephonyControl(input, binding);
    },
  };
}
