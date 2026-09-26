import type { CarrierHttpRequest, NormalizedCallEvent } from '@winsendotai/ovo-contracts';
import { expect, it } from 'vitest';
import {
  createCarrierHostPorts,
  type CarrierHostPortsOptions,
} from '../../session-host/src/host-ports.ts';
import { exotelRoutes } from '../src/routes.ts';

function fixture() {
  const applied: NormalizedCallEvent[] = [];
  const host = createCarrierHostPorts({
    publicBaseUrl: 'https://ovo.example.test',
    routeSecret: 'fixture-route-secret-at-least-thirty-two-bytes',
    bindings: async () => {
      throw new Error('Status authentication must not resolve a binding');
    },
    operations: {
      admitInbound: async () => ({ kind: 'busy' }),
      confirmCallback: async () => ({ kind: 'busy' }),
    },
    orchestration: {
      async applyCallEvent(event: NormalizedCallEvent) {
        applied.push(event);
        return { kind: 'applied' };
      },
    } as CarrierHostPortsOptions['orchestration'],
  });
  const signed = new URL(
    host.callbackUrl('exotel', 'binding-1', 'status', { requestId: 'dial-A' }),
  );
  const request = (customField?: string, callSid = 'call-A'): CarrierHttpRequest => ({
    method: 'POST',
    externalUrl: signed.origin + signed.pathname,
    bindingId: 'binding-1',
    query: Object.fromEntries(signed.searchParams),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    rawBody: new TextEncoder().encode(
      new URLSearchParams({
        CallSid: callSid,
        Status: 'completed',
        ...(customField === undefined ? {} : { CustomField: customField }),
      }).toString(),
    ),
  });
  const route = exotelRoutes.find((candidate) => candidate.purpose === 'status')!;
  return { host, applied, request, route };
}

it('rejects another call in the body of a genuinely signed per-call status URL', async () => {
  const { host, applied, request, route } = fixture();
  const reply = await route.handle(request('dial-B', 'call-B'), host);
  expect(reply.status).toBe(403);
  expect(applied).toEqual([]);
});

it.each(['dial-A', undefined])(
  'applies the authenticated request when CustomField is %s',
  async (customField) => {
    const { host, applied, request, route } = fixture();
    const reply = await route.handle(request(customField), host);
    expect(reply.status).toBe(200);
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({
      carrierId: 'exotel',
      bindingId: 'binding-1',
      carrierCallId: 'call-A',
      dialRequestId: 'dial-A',
      state: 'completed',
    });
  },
);

it('rejects a changed query request ID under the real host HMAC verifier', async () => {
  const { host, applied, request, route } = fixture();
  const req = request('dial-B', 'call-B');
  const reply = await route.handle({ ...req, query: { ...req.query, r: 'dial-B' } }, host);
  expect(reply.status).toBe(401);
  expect(applied).toEqual([]);
});
