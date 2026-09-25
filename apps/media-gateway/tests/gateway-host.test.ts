import { expect, it, vi } from 'vitest';
import type { NormalizedCallEvent } from '@winsendotai/ovo-contracts';
import { fixtureCarrierIngress } from '../../../packages/conformance/src/drivers/fixture-carrier.ts';
import { createGatewayHost } from '../src/gateway-host.ts';

it.each([
  ['completed', undefined, false, 'failed'],
  ['completed', 'machine', true, 'failed'],
  ['completed', 'human', true, 'succeeded'],
  ['busy', undefined, false, 'failed'],
] as const)(
  'projects %s with answeredBy %s and sessionOpened %s as %s through host.applyCallEvent',
  async (state, answeredBy, sessionOpened, expected) => {
    const recordAttempt = vi.fn(async () => undefined);
    const route = {
      jobId: 'job-1',
      handshakeClaimedAt: sessionOpened ? new Date(1) : undefined,
    };
    const store = {
      applyCarrierCallback: vi.fn(async () => ({ kind: 'applied' as const, route })),
      get: vi.fn(async () => ({ payload: { kind: 'outbound_call', attemptId: 'attempt-1' } })),
      resolveSessionRoute: vi.fn(),
      issueStreamGrant: vi.fn(),
      reissueStream: vi.fn(),
      recordCarrierCallIdMismatch: vi.fn(),
    };
    const operations = {
      organizationId: 'org',
      campaigns: { recordAttempt },
      inboundGateway: {},
    };
    const { hostFor } = createGatewayHost({
      publicBaseUrl: 'https://voice.example',
      routeSecret: 'a'.repeat(32),
      store: store as never,
      operations: operations as never,
      distribution: { catalog: [], defaults: {} } as never,
      control: {} as never,
      secrets: {} as never,
      ingresses: [fixtureCarrierIngress()],
      env: {},
    });
    const event: NormalizedCallEvent = {
      carrierId: 'fixture',
      bindingId: 'env',
      eventId: 'event-1',
      carrierCallId: 'call-1',
      state,
      ...(answeredBy ? { answeredBy } : {}),
      occurredAt: new Date(2),
    };
    expect(await hostFor('fixture', 'env').applyCallEvent(event)).toEqual({ kind: 'applied' });
    expect(recordAttempt).toHaveBeenCalledWith('attempt-1', 'event-1', expected, event.occurredAt);
    expect(store.applyCarrierCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org',
        carrierId: 'fixture',
        status: state === 'completed' ? 'completed' : 'busy',
      }),
    );
  },
);
