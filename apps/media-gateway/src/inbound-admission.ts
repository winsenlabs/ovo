import { createHash, createHmac } from 'node:crypto';
import type {
  CarrierHostPorts,
  InboundAdmission,
  InboundDecision,
  StreamGrant,
} from '@winsendotai/ovo-contracts';
import {
  inboundDecisionFor,
  type InboundGatewayDecision,
  type OperationsService,
} from '@winsendotai/ovo-plugin-operations';

export interface InboundAdmissionOptions {
  operations: Pick<OperationsService, 'organizationId' | 'inboundGateway'>;
  routeSecret: string;
  hostFor(carrierId: string, bindingId: string): CarrierHostPorts;
  validateBeforeAdmission?(admission: InboundAdmission): Promise<void>;
  handshakeTtlMs?: number;
}

function withStage(url: string, stage: 'wait' | 'callback'): string {
  const selected = new URL(url);
  selected.searchParams.set('stage', stage);
  return selected.toString();
}

/** Only C2 owns token minting; the operations mapper receives a complete context. */
export function createInboundAdmission(
  options: InboundAdmissionOptions,
): Pick<CarrierHostPorts, 'admitInbound' | 'confirmCallback'> {
  if (Buffer.byteLength(options.routeSecret) < 32)
    throw new Error('Inbound route secret must be at least 32 bytes');
  const ttlMs = options.handshakeTtlMs ?? 60_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 5_000 || ttlMs > 300_000)
    throw new Error('Inbound handshake TTL is outside the supported range');
  const call = (admission: InboundAdmission) => {
    const host = options.hostFor(admission.carrierId, admission.bindingId);
    const routeToken = createHmac('sha256', options.routeSecret)
      .update(
        `${options.operations.organizationId}:${admission.carrierId}:${admission.bindingId}:${admission.carrierCallId}`,
        'utf8',
      )
      .digest('base64url');
    return {
      host,
      routeToken,
      input: {
        carrierCallId: admission.carrierCallId,
        fromNumber: admission.from,
        toNumber: admission.to,
        routeTokenHash: createHash('sha256').update(routeToken, 'utf8').digest('hex'),
        handshakeTtlMs: ttlMs,
      },
    };
  };
  const map = (
    decision: InboundGatewayDecision,
    admission: InboundAdmission,
    host: CarrierHostPorts,
    routeToken: string,
  ): InboundDecision => {
    switch (decision.kind) {
      case 'reserved': {
        const grant: StreamGrant = {
          kind: 'stream',
          mediaUrl: host.mediaUrl(admission.carrierId, admission.bindingId),
          routeParams: { sid: decision.sessionId, rt: routeToken },
          resumeUrl: host.callbackUrl(admission.carrierId, admission.bindingId, 'resume', {
            requestId: admission.carrierCallId,
          }),
          statusUrl: host.callbackUrl(admission.carrierId, admission.bindingId, 'status', {
            requestId: admission.carrierCallId,
          }),
        };
        return inboundDecisionFor(decision, { kind: 'reserved', grant });
      }
      case 'wait':
        return inboundDecisionFor(decision, {
          kind: 'wait',
          retryUrl: withStage(
            host.callbackUrl(admission.carrierId, admission.bindingId, 'inbound', {
              requestId: admission.carrierCallId,
            }),
            'wait',
          ),
          announce: admission.raw?.stage !== 'wait',
        });
      case 'callback':
        return inboundDecisionFor(decision, {
          kind: 'callback',
          digitsUrl: withStage(
            host.callbackUrl(admission.carrierId, admission.bindingId, 'inbound', {
              requestId: admission.carrierCallId,
            }),
            'callback',
          ),
          timeoutSeconds: 5,
        });
      case 'human':
        return inboundDecisionFor(decision, { kind: 'human' });
      case 'busy':
        return inboundDecisionFor(decision, { kind: 'busy' });
    }
  };
  return {
    async admitInbound(admission) {
      await options.validateBeforeAdmission?.(admission);
      const { host, routeToken, input } = call(admission);
      const decision = await options.operations.inboundGateway.admit(input);
      return map(decision, admission, host, routeToken);
    },
    async confirmCallback(admission) {
      await options.validateBeforeAdmission?.(admission);
      const { host, routeToken, input } = call(admission);
      const decision = await options.operations.inboundGateway.confirmCallback({
        ...input,
        digits: admission.digits,
      });
      return map(decision, admission, host, routeToken);
    },
  };
}
