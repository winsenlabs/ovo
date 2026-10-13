import { createFakeCarrierHostPorts } from '@winsendotai/ovo-conformance';
import {
  Cap,
  Manifest,
  type CarrierControlFactory,
  type CarrierIngress,
  type DialRequest,
  type InboundAdmission,
  type ResolvedBinding,
  type SipTrunkControlClient,
} from '@winsendotai/ovo-contracts';
import { compose, type ParentView } from '@winsendotai/ovo-runtime';
import { createSipRequestVerifier } from '@winsendotai/ovo-sip-carrier-kit';
import { signedSipHttpRequest } from '@winsendotai/ovo-sip-carrier-kit/testing';
import { describe, expect, it } from 'vitest';
import { tcnCarrierPlugin, tcnMetadataKey, withTcnMetadata } from '../src/index.ts';

const KEY = new Uint8Array(32).fill(5);
const binding = (config: Record<string, unknown> = {}): ResolvedBinding => ({
  bindingId: 'b1',
  pluginId: tcnCarrierPlugin.manifest.id,
  workspaceId: 'w1',
  config: { trunkId: 'tcn-sg', ...config },
  secret: '',
});
const dial: DialRequest = {
  requestId: 'req-1',
  jobId: 'job-1',
  to: '+919876543210',
  from: '+918000000001',
  media: {
    url: 'wss://ovo.example.test/carriers/tcn/b1/media',
    routeParams: { sid: 's', rt: 'r' },
    format: { encoding: 'mulaw', sampleRate: 8000, channels: 1 },
  },
  callbacks: {
    status: 'https://ovo.example.test/carriers/tcn/b1/status?r=req-1&t=x',
    answer: 'https://ovo.example.test/carriers/tcn/b1/answer?r=req-1&t=x',
  },
  maxDurationSec: 60,
};

function parentWith(values: Record<string, unknown>): ParentView {
  return { keys: new Set(Object.keys(values)), get: (key) => values[key], all: () => new Map() };
}

async function composed(values: Record<string, unknown>) {
  const graph = await compose([{ id: tcnCarrierPlugin.manifest.id }], [tcnCarrierPlugin], {
    scope: 'process',
    parent: parentWith(values),
  });
  return {
    graph,
    control: graph.all(Cap.carrierControl).get('tcn') as CarrierControlFactory,
    ingress: graph.all(Cap.carrierIngress).get('tcn') as CarrierIngress,
  };
}

function recordingClient() {
  const seen: Parameters<SipTrunkControlClient['request']>[0][] = [];
  const client: SipTrunkControlClient = {
    async request(input) {
      seen.push(input);
      return {
        status: 200,
        body: { kind: 'accepted', carrierCallId: 'cid@ovo', carrierRequestId: 'req-1' },
      };
    },
  };
  return { seen, client };
}

describe('plugin-carrier-tcn manifest', () => {
  it('is a tcn carrier on the sip-gateway: no egress, no handoff, no AMD, its own meter', () => {
    const manifest = Manifest.parse(tcnCarrierPlugin.manifest);
    expect(manifest).toMatchObject({
      kind: 'carrier',
      provider: 'tcn',
      runtime: { egressHosts: [] },
      conformance: ['carrier@1'],
      meters: [{ key: 'tcn.carrier.audio_seconds', unit: 'audio_seconds', role: 'carrier' }],
      capabilities: { carrierId: 'tcn', control: { handoff: [], amd: 'none', hangup: 'rest' } },
    });
    const raw = tcnCarrierPlugin.manifest as unknown as {
      optional: string[];
      requires: string[];
      bindingSchema: {
        properties: Record<string, { default?: unknown; maxItems?: number }>;
      };
    };
    expect(raw.optional).toEqual([Cap.sipTrunkControl, Cap.sipTrunkVerifier]);
    expect(raw.requires).toEqual([]);
    const schema = raw.bindingSchema;
    expect(schema.properties.outboundEnabled.default).toBe(false);
    expect(schema.properties.region.default).toBe('sg');
    expect(schema.properties.metadataHeaders.maxItems).toBe(16);
  });
});

describe('plugin-carrier-tcn outbound', () => {
  it.each([
    ['without outboundEnabled', {}],
    ['with outboundEnabled false', { outboundEnabled: false }],
    ['with a non-boolean outboundEnabled', { outboundEnabled: 'true' }],
  ])('refuses the dial %s, before calling the sip-gateway', async (_label, config) => {
    const { seen, client } = recordingClient();
    const { graph, control } = await composed({ [Cap.sipTrunkControl]: client });
    try {
      expect(await control.create(binding(config)).dial(dial)).toEqual({
        kind: 'rejected',
        requestId: 'req-1',
        reason: 'outbound_disabled',
        retryable: false,
      });
      expect(seen).toEqual([]);
    } finally {
      await graph.dispose();
    }
  });

  it('dials through Cap.sipTrunkControl as carrier tcn once the binding opts in', async () => {
    const { seen, client } = recordingClient();
    const { graph, control } = await composed({ [Cap.sipTrunkControl]: client });
    try {
      expect(await control.create(binding({ outboundEnabled: true })).dial(dial)).toMatchObject({
        kind: 'accepted',
        carrierCallId: 'cid@ovo',
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        method: 'POST',
        path: '/v1/calls',
        body: { carrierId: 'tcn', bindingId: 'b1', trunkId: 'tcn-sg', requestId: 'req-1' },
      });
    } finally {
      await graph.dispose();
    }
  });

  it('refuses an opted-in dial when the host composed no sip-gateway client', async () => {
    const { graph, control } = await composed({});
    try {
      expect(await control.create(binding({ outboundEnabled: true })).dial(dial)).toMatchObject({
        kind: 'rejected',
        reason: 'sip_trunk_unavailable',
        retryable: false,
      });
    } finally {
      await graph.dispose();
    }
  });
});

describe('plugin-carrier-tcn inbound metadata headers', () => {
  const headers = {
    'X-TCN-Call-Sid': 'CS-1',
    'X-Account': '12345',
    'X-Internal-Routing': 'queue-7',
  };

  async function admit(config: Record<string, unknown>) {
    const now = Date.now();
    const verifier = createSipRequestVerifier({ keys: [KEY], now: () => now });
    const { graph, ingress } = await composed({ [Cap.sipTrunkVerifier]: verifier });
    try {
      const host = createFakeCarrierHostPorts({ bindings: { b1: binding(config) } });
      const route = ingress.routes.find((candidate) => candidate.purpose === 'inbound')!;
      const reply = await route.handle(
        await signedSipHttpRequest({
          key: KEY,
          carrierId: 'tcn',
          bindingId: 'b1',
          purpose: 'inbound',
          now,
          body: {
            v: 1,
            callId: 'tcn-call-1',
            trunkId: 'tcn-sg',
            from: '+919876543210',
            to: '+918041234567',
            receivedAt: '2026-10-13T10:00:00.000Z',
            headers,
            sip: { requestUri: 'sip:+918041234567@203.0.113.10', fromUri: 'sip:x@203.0.113.5' },
            retry: 0,
          },
        }),
        host,
      );
      expect(reply.status).toBe(200);
      const admitted = host.calls.filter((call) => call.method === 'admitInbound');
      expect(admitted).toHaveLength(1);
      return (admitted[0]!.args as InboundAdmission).raw ?? {};
    } finally {
      await graph.dispose();
    }
  }

  it('surfaces only the binding-allow-listed headers as tcn.* keys', async () => {
    const raw = await admit({ metadataHeaders: ['x-tcn-call-sid', 'X-ACCOUNT', 'X-Absent'] });
    expect(
      Object.keys(raw)
        .filter((key) => key.startsWith('tcn.'))
        .sort(),
    ).toEqual(['tcn.x-account', 'tcn.x-tcn-call-sid']);
    expect(raw).toMatchObject({ 'tcn.x-tcn-call-sid': 'CS-1', 'tcn.x-account': '12345' });
    expect(raw).not.toHaveProperty('tcn.x-internal-routing');
    // What the trunk entry forwarded stays visible under its SIP name, as for any SIP carrier.
    expect(raw).toMatchObject({
      'sip.callId': 'tcn-call-1',
      'sip.trunkId': 'tcn-sg',
      'sip.header.X-Internal-Routing': 'queue-7',
    });
  });

  it('adds no tcn.* key when the binding lists no metadata header', async () => {
    const raw = await admit({});
    expect(Object.keys(raw).filter((key) => key.startsWith('tcn.'))).toEqual([]);
  });

  it('maps header names to lower-kebab keys and ignores non-header raw fields', () => {
    expect(tcnMetadataKey('X-TCN_Call.Sid')).toBe('tcn.x-tcn-call-sid');
    expect(
      withTcnMetadata({ 'sip.callId': 'c', 'sip.header.X-A': '1' }, ['sip.callId', 'x-a']),
    ).toEqual({ 'sip.callId': 'c', 'sip.header.X-A': '1', 'tcn.x-a': '1' });
  });

  it('answers 503 and admits nothing when the host composed no verifier', async () => {
    const { graph, ingress } = await composed({});
    try {
      const host = createFakeCarrierHostPorts({ bindings: { b1: binding() } });
      const route = ingress.routes.find((candidate) => candidate.purpose === 'inbound')!;
      const reply = await route.handle(
        await signedSipHttpRequest({
          key: KEY,
          carrierId: 'tcn',
          bindingId: 'b1',
          purpose: 'inbound',
          body: {},
          now: Date.now(),
        }),
        host,
      );
      expect(reply.status).toBe(503);
      expect(host.calls.filter((call) => call.method === 'admitInbound')).toEqual([]);
    } finally {
      await graph.dispose();
    }
  });
});
