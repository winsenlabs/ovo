import { describe, expect, it } from 'vitest';
import type { CarrierHttpRequest, ResolvedBinding } from '@winsendotai/ovo-contracts';
import { createCarrierHostPorts } from '../../session-host/src/host-ports.ts';
import { plivoRoutes } from '../src/routes.ts';
import { signV3 } from '../src/signature.ts';

const binding: ResolvedBinding = {
  bindingId: 'b1',
  pluginId: '@winsendotai/ovo-carrier-plivo',
  workspaceId: 'w1',
  config: { authId: 'AUTH1' },
  secret: 'plivo-test-token',
};

async function signed(url: string, params: Record<string, string>): Promise<CarrierHttpRequest> {
  const nonce = 'stream-callback-proof';
  return {
    method: 'POST',
    externalUrl: url,
    query: Object.fromEntries(new URL(url).searchParams),
    headers: {
      'X-Plivo-Signature-V3': await signV3(binding.secret, url, nonce, params),
      'X-Plivo-Signature-V3-Nonce': nonce,
    },
    rawBody: new TextEncoder().encode(new URLSearchParams(params).toString()),
    bindingId: binding.bindingId,
  };
}

describe('Plivo stream status production URL integration', () => {
  it.each(['answer', 'inbound', 'resume'] as const)(
    'routes the %s XML stream callback to stream-status with real host grants',
    async (purpose) => {
      const route = {
        sessionId: 'session-1',
        organizationId: 'w1',
        dialRequestId: 'dial-1',
        carrierCallId: 'call-1',
        carrierId: 'plivo',
        bindingId: 'b1',
        status: 'connected',
      };
      const ports = createCarrierHostPorts({
        publicBaseUrl: 'https://voice.example.test',
        routeSecret: 'r'.repeat(32),
        bindings: async () => binding,
        orchestration: {
          resolveSessionRoute: async () => route,
          issueStreamGrant: async () => route,
          reissueStream: async () => route,
          recordCarrierCallIdMismatch: async () => {},
          applyCallEvent: async () => ({ kind: 'applied' }),
        },
        operations: {
          async admitInbound() {
            const grant = await ports.streamForDial({
              carrierId: 'plivo',
              bindingId: 'b1',
              dialRequestId: 'dial-1',
              carrierCallId: 'call-1',
            });
            if (grant.kind !== 'stream') throw new Error('Expected real host stream grant');
            return { ...grant, kind: 'connect' };
          },
          confirmCallback: async () => ({ kind: 'hangup' }),
        },
      });
      const events: Record<string, string>[] = [];
      const routes = plivoRoutes((event) => events.push(event));
      const request = await signed(
        ports.callbackUrl(
          'plivo',
          'b1',
          purpose,
          purpose === 'inbound'
            ? undefined
            : {
                requestId: 'dial-1',
              },
        ),
        { CallUUID: 'call-1', RequestUUID: 'request-1', From: '+15550100', To: '+15550199' },
      );
      const reply = await routes.find((entry) => entry.purpose === purpose)!.handle(request, ports);
      expect(reply.status).toBe(200);
      const callback = /statusCallbackUrl="([^"]+)"/
        .exec(reply.body)?.[1]
        ?.replaceAll('&amp;', '&');
      expect(callback).toBeDefined();
      const callbackPurpose = new URL(callback!).pathname.split('/').at(-1);
      const callbackRoute = routes.find((entry) => entry.purpose === callbackPurpose)!;
      const result = await callbackRoute.handle(
        await signed(callback!, {
          Event: 'failed',
          CallUUID: 'call-1',
          StreamID: 'stream-1',
          StatusReason: 'disconnected',
        }),
        ports,
      );
      expect(result.status, `Stream callback routed to ${callbackPurpose}`).toBe(204);
      expect(callbackPurpose).toBe('stream-status');
      expect(events).toEqual([
        {
          event: 'plivo_stream_status',
          status: 'failed',
          carrierCallId: 'call-1',
          streamId: 'stream-1',
          reason: 'disconnected',
        },
      ]);
    },
  );
});
