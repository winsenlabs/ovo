import { Cap, type CarrierControlFactory } from '@winsendotai/ovo-contracts';
import { definePlugin } from '@winsendotai/ovo-runtime';
import type {
  HandoffProviderPort,
  HandoffProviderResult,
  HandoffReconciliation,
} from '../src/types.ts';

export function apiCarrierFixture() {
  const capabilities = {
    carrierId: 'twilio',
    media: {
      formats: [{ encoding: 'mulaw', sampleRate: 8000, channels: 1 }],
      playbackEvidence: 'carrier-played',
      clear: true,
      clearFlushesMarkers: true,
      dtmf: true,
      queryOnMediaUrl: false,
    },
    control: {
      callIdTiming: 'at-dial',
      streamParams: 'at-dial',
      streamCallIdMatchesDial: true,
      cancelBeforeAnswer: true,
      handoff: [],
      amd: 'none',
      maxDuration: true,
      reconcile: 'by-call-id',
      hangup: 'rest',
    },
    continuation: 'none',
    webhookAuth: 'hmac-signature',
    pacing: { cps: 10 },
  } as const;
  const plugin = definePlugin(
    {
      id: 'carrier.fixture',
      version: '1.0.0',
      contractVersion: 2,
      kind: 'carrier',
      provider: 'twilio',
      scope: 'process',
      requires: [],
      provides: [Cap.carrierControl],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: [],
      capabilities,
      meters: [
        {
          key: 'twilio.carrier.audio_seconds',
          unit: 'audio_seconds',
          label: 'Call',
          role: 'carrier',
        },
      ],
      runtime: { egressHosts: [], modelLicences: [] },
      conformance: ['carrier@1'],
    },
    () => undefined,
  );
  const control = {
    capabilities,
    create: () => {
      throw new Error('Fixture control is not used to dial');
    },
  } as CarrierControlFactory;
  return { catalog: [plugin], controls: new Map([['twilio', control]]) };
}

export class ApiHandoffProvider implements HandoffProviderPort {
  requests = 0;
  async request(): Promise<HandoffProviderResult> {
    this.requests += 1;
    return { kind: 'confirmed', receiptId: 'transfer-receipt' };
  }
  async reconcile(): Promise<HandoffReconciliation> {
    return { kind: 'pending' };
  }
  async fallback(): Promise<HandoffProviderResult> {
    return { kind: 'confirmed', receiptId: 'fallback-receipt' };
  }
}
