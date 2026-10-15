import { createFakeCarrierHostPorts } from '@winsendotai/ovo-conformance';
import {
  Cap,
  Manifest,
  type CarrierControlFactory,
  type CarrierIngress,
  type DialRequest,
  type SipTrunkControlClient,
} from '@winsendotai/ovo-contracts';
import { compose, type ParentView } from '@winsendotai/ovo-runtime';
import { createSipRequestVerifier } from '@winsendotai/ovo-sip-carrier-kit';
import { signedSipHttpRequest } from '@winsendotai/ovo-sip-carrier-kit/testing';
import { describe, expect, it } from 'vitest';
import { sipCarrierPlugin } from '../src/index.ts';

const binding = {
  bindingId: 'b1',
  pluginId: sipCarrierPlugin.manifest.id,
  workspaceId: 'w1',
  config: { trunkId: 'trunk-a' },
  secret: '',
};
const dial: DialRequest = {
  requestId: 'req-1',
  jobId: 'job-1',
  to: '+919876543210',
  from: '+918000000001',
  media: {
    url: 'wss://ovo.example.test/carriers/sip/b1/media',
    routeParams: { sid: 's', rt: 'r' },
    format: { encoding: 'mulaw', sampleRate: 8000, channels: 1 },
  },
  callbacks: {
    status: 'https://ovo.example.test/carriers/sip/b1/status?r=req-1&t=x',
    answer: 'https://ovo.example.test/carriers/sip/b1/answer?r=req-1&t=x',
  },
  maxDurationSec: 60,
};

function parentWith(values: Record<string, unknown>): ParentView {
  return {
    keys: new Set(Object.keys(values)),
    get: (key) => values[key],
    all: () => new Map(),
  };
}

async function composed(values: Record<string, unknown>) {
  const graph = await compose([{ id: sipCarrierPlugin.manifest.id }], [sipCarrierPlugin], {
    scope: 'process',
    parent: parentWith(values),
  });
  return {
    graph,
    control: graph.all(Cap.carrierControl).get('sip') as CarrierControlFactory,
    ingress: graph.all(Cap.carrierIngress).get('sip') as CarrierIngress,
  };
}

describe('plugin-carrier-sip manifest', () => {
  it('validates as a carrier with no public egress and the SIP meter', () => {
    const manifest = Manifest.parse(sipCarrierPlugin.manifest);
    expect(manifest).toMatchObject({
      kind: 'carrier',
      provider: 'sip',
      runtime: { egressHosts: [] },
      conformance: ['carrier@1'],
      meters: [{ key: 'sip.carrier.audio_seconds', unit: 'audio_seconds', role: 'carrier' }],
    });
    expect(manifest).toMatchObject({
      requires: [],
      optional: [Cap.sipTrunkControl, Cap.sipTrunkVerifier],
    });
  });
});

describe('plugin-carrier-sip host capabilities', () => {
  it('loads without either host capability and then refuses dial and answers 503', async () => {
    const { graph, control, ingress } = await composed({});
    try {
      expect(await control.create(binding).dial(dial)).toMatchObject({
        kind: 'rejected',
        retryable: false,
        reason: 'sip_trunk_unavailable',
      });
      const inbound = ingress.routes.find((route) => route.purpose === 'inbound')!;
      const reply = await inbound.handle(
        await signedSipHttpRequest({
          key: new Uint8Array(32),
          carrierId: 'sip',
          bindingId: 'b1',
          purpose: 'inbound',
          body: {},
          now: Date.now(),
        }),
        createFakeCarrierHostPorts({ bindings: { b1: binding } }),
      );
      expect(reply.status).toBe(503);
    } finally {
      await graph.dispose();
    }
  });

  it('dials through the composed Cap.sipTrunkControl client', async () => {
    const seen: unknown[] = [];
    const client: SipTrunkControlClient = {
      async request(input) {
        seen.push(input);
        return {
          status: 200,
          body: { kind: 'accepted', carrierCallId: 'cid@ovo', carrierRequestId: 'req-1' },
        };
      },
    };
    const { graph, control } = await composed({ [Cap.sipTrunkControl]: client });
    try {
      expect(await control.create(binding).dial(dial)).toMatchObject({
        kind: 'accepted',
        carrierCallId: 'cid@ovo',
      });
      expect(seen).toHaveLength(1);
    } finally {
      await graph.dispose();
    }
  });

  it('verifies inbound requests through the composed Cap.sipTrunkVerifier', async () => {
    const key = new Uint8Array(32).fill(4);
    const now = Date.now();
    const verifier = createSipRequestVerifier({ keys: [key], now: () => now });
    const { graph, ingress } = await composed({ [Cap.sipTrunkVerifier]: verifier });
    try {
      const inbound = ingress.routes.find((route) => route.purpose === 'inbound')!;
      const reply = await inbound.handle(
        await signedSipHttpRequest({
          key,
          carrierId: 'sip',
          bindingId: 'b1',
          purpose: 'inbound',
          body: { v: 2 },
          now,
        }),
        createFakeCarrierHostPorts({ bindings: { b1: binding } }),
      );
      // Signed correctly, then refused on the body: authentication went through the capability.
      expect(reply.status).toBe(400);
    } finally {
      await graph.dispose();
    }
  });

  it('refuses dial on an inbound-only binding', async () => {
    const { graph, control } = await composed({
      [Cap.sipTrunkControl]: { request: async () => ({ status: 500, body: null }) },
    });
    try {
      const inboundOnly = { ...binding, config: { trunkId: 'trunk-a', outboundEnabled: false } };
      expect(await control.create(inboundOnly).dial(dial)).toMatchObject({
        kind: 'rejected',
        reason: 'outbound_disabled',
        retryable: false,
      });
    } finally {
      await graph.dispose();
    }
  });
});
