import { describe, expect, it, vi } from 'vitest';
import { twilioCarrierBridge } from '../../../packages/distribution/src/legacy/twilio-carrier.ts';
import { ApiCarrierHandoffPort } from '../src/carrier-handoff.ts';

describe('API carrier handoff', () => {
  it('selects the installed carrier from the durable route and fails closed if it is missing', async () => {
    const handoff = vi.fn(async () => ({ kind: 'confirmed' as const, receiptId: 'receipt-1' }));
    const create = vi.fn(() => ({ handoff }));
    const factory = { capabilities: { carrierId: 'twilio' }, create };
    const query = vi.fn(async () => ({
      rowCount: 1,
      rows: [{ carrier_id: 'twilio', binding_id: null, payload: { releaseId: 'release-1' } }],
    }));
    const port = new ApiCarrierHandoffPort({
      organizationId: 'workspace-1',
      catalog: [twilioCarrierBridge],
      ctx: { all: () => new Map([['twilio', factory]]) } as never,
      store: {
        getRelease: async () => ({ agentId: 'agent-1' }),
        getProviderBinding: async () => undefined,
      } as never,
      secrets: { forAgent: () => ({ resolve: async () => 'unused' }) } as never,
      environment: {
        OVO_CARRIER_ENV_BINDINGS: JSON.stringify({ twilio: { authToken: 'test-secret' } }),
      },
    });
    port.attach({ query } as never);

    await expect(
      port.request({
        requestId: 'handoff-1',
        carrierCallId: 'CA123',
        target: { kind: 'phone', value: '+14155550100' },
      }),
    ).resolves.toEqual({ kind: 'confirmed', receiptId: 'receipt-1' });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('h.request_id = $3 OR h.fallback_request_id = $3'),
      ['workspace-1', 'CA123', 'handoff-1'],
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ bindingId: 'env', pluginId: twilioCarrierBridge.manifest.id }),
    );
    expect(handoff).toHaveBeenCalledWith(
      'CA123',
      { kind: 'phone', e164: '+14155550100' },
      'handoff-1',
    );

    query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ carrier_id: 'missing', binding_id: null, payload: { releaseId: 'release-1' } }],
    });
    await expect(
      port.request({
        requestId: 'handoff-2',
        carrierCallId: 'CA456',
        target: { kind: 'queue', value: 'support' },
      }),
    ).rejects.toThrow('Carrier control is not installed: missing');
    expect(handoff).toHaveBeenCalledTimes(1);
  });
});
