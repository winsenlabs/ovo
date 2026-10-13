import { createFakeCarrierHostPorts, describeCarrier } from '@winsendotai/ovo-conformance';
import type { CarrierHttpRoute } from '@winsendotai/ovo-contracts';
import {
  SIP_STATUS_SNAPSHOT,
  createSipRequestVerifier,
  mapSipCallState,
} from '@winsendotai/ovo-sip-carrier-kit';
import {
  signedSipHttpRequest,
  signedSipUpgrade,
  sipControlScript,
  sipMediaTranscript,
  sipTrunkClientOverNet,
} from '@winsendotai/ovo-sip-carrier-kit/testing';
import { describe, expect, it } from 'vitest';
import { createSipCarrierIngress, createSipControl } from '../src/index.ts';

const KEY = new Uint8Array(32).fill(0x2a);
const PREVIOUS = new Uint8Array(32).fill(0x2b);
const NOW = 1_760_349_600_000;
const binding = {
  bindingId: 'b1',
  pluginId: '@winsendotai/ovo-carrier-sip',
  workspaceId: 'w1',
  config: { trunkId: 'trunk-a' },
  secret: '',
};
const ports = createFakeCarrierHostPorts({ bindings: { b1: binding } });
const query = (purpose: CarrierHttpRoute['purpose'], requestId: string) =>
  Object.fromEntries(new URL(ports.callbackUrl('sip', 'b1', purpose, { requestId })).searchParams);
const http = (
  purpose: 'inbound' | 'status' | 'resume',
  body: unknown,
  extra: Partial<Parameters<typeof signedSipHttpRequest>[0]> = {},
) =>
  signedSipHttpRequest({
    key: KEY,
    carrierId: 'sip',
    bindingId: 'b1',
    purpose,
    body,
    now: NOW,
    ...extra,
  });

const inboundBody = {
  v: 1,
  callId: 'a84b4c76e66710@pc33.example',
  trunkId: 'trunk-a',
  from: '+919876543210',
  to: '+918041234567',
  receivedAt: '2026-10-13T10:00:00.000Z',
  headers: {},
  sip: { requestUri: 'sip:+918041234567@203.0.113.10', fromUri: 'sip:+919876543210@198.51.100.7' },
  retry: 0,
};
const statusBody = {
  v: 1,
  eventId: 'cid@ovo:completed',
  callId: 'cid@ovo',
  dialRequestId: 'dial-1',
  state: 'completed',
  occurredAt: '2026-10-13T10:03:12.000Z',
  sipCode: 200,
};
const inbound = await http('inbound', inboundBody);
const status = await http('status', statusBody, { query: query('status', 'dial-1') });
const resume = await http(
  'resume',
  { v: 1, callId: 'cid@ovo' },
  { query: query('resume', 'cid@ovo') },
);

const factory = ({ net }: { net: Parameters<typeof sipTrunkClientOverNet>[0] }) => ({
  control: createSipControl({ client: () => sipTrunkClientOverNet(net) }),
  // A verifier per request: the kit replays one signed request across checks on purpose, while
  // nonce reuse on one verifier is proven separately below.
  ingress: createSipCarrierIngress({
    verifier: () => createSipRequestVerifier({ keys: [KEY, PREVIOUS], now: () => NOW }),
  }),
});

describeCarrier('SIP trunk (ovo-sip/1)', factory, {
  binding,
  transcripts: [{ fixture: sipMediaTranscript }],
  rest: {
    dial: {
      scripts: sipControlScript({
        method: 'POST',
        path: '/v1/calls',
        where: {
          requestId: 'dial-1',
          carrierId: 'sip',
          bindingId: 'b1',
          trunkId: 'trunk-a',
          to: '+15550100',
          from: '+15550199',
          'media.routeParams': { sid: 'session-1', rt: 'route-token-1' },
          maxDurationSec: 600,
          credentials: null,
        },
        reply: {
          status: 200,
          body: { kind: 'accepted', carrierCallId: 'cid@ovo', carrierRequestId: 'dial-1' },
        },
      }),
    },
    hangup: {
      scripts: sipControlScript({
        method: 'POST',
        path: '/v1/calls/hangup',
        where: { carrierCallId: 'cid@ovo' },
        reply: { status: 200, body: { result: 'ended' } },
      }),
      query: { carrierCallId: 'cid@ovo' },
      expect: 'ended',
    },
    cancel: {
      scripts: sipControlScript({
        method: 'POST',
        path: '/v1/calls/hangup',
        where: { carrierRequestId: 'dial-1' },
        reply: { status: 200, body: { result: 'ended' } },
      }),
      carrierRequestId: 'dial-1',
    },
    reconcile: {
      scripts: sipControlScript({
        method: 'GET',
        path: '/v1/calls',
        query: { requestId: 'dial-1' },
        reply: { status: 200, body: { kind: 'live', carrierCallId: 'cid@ovo', state: 'ringing' } },
      }),
      query: { requestId: 'dial-1', carrierRequestId: 'dial-1' },
      expect: 'live',
      state: 'ringing',
    },
  },
  vectors: {
    http: [
      { purpose: 'inbound', request: inbound, valid: true, label: 'valid' },
      {
        purpose: 'inbound',
        request: await http('inbound', inboundBody, { key: PREVIOUS }),
        valid: true,
        label: 'previous key during rotation',
      },
      {
        purpose: 'inbound',
        request: await http('inbound', inboundBody, { now: NOW - 30_001 }),
        valid: false,
        label: 'stale timestamp',
      },
      {
        purpose: 'inbound',
        request: await http('inbound', inboundBody, { key: new Uint8Array(32).fill(1) }),
        valid: false,
        label: 'wrong key',
      },
      {
        purpose: 'inbound',
        request: await http('inbound', inboundBody, { signedPath: '/carriers/sip/b1/status' }),
        valid: false,
        label: 'wrong path',
      },
      {
        purpose: 'inbound',
        request: {
          ...inbound,
          rawBody: new TextEncoder().encode(
            JSON.stringify({ ...inboundBody, to: '+918000000000' }),
          ),
        },
        valid: false,
        label: 'tampered body',
      },
    ],
    upgrade: [
      {
        request: await signedSipUpgrade({ key: KEY, carrierId: 'sip', bindingId: 'b1', now: NOW }),
        valid: true,
        label: 'valid',
      },
      {
        request: await signedSipUpgrade({
          key: KEY,
          carrierId: 'sip',
          bindingId: 'b1',
          now: NOW + 31_000,
        }),
        valid: false,
        label: 'future timestamp',
      },
      {
        request: await signedSipUpgrade({
          key: new Uint8Array(32),
          carrierId: 'sip',
          bindingId: 'b1',
          now: NOW,
        }),
        valid: false,
        label: 'wrong key',
      },
      {
        request: await signedSipUpgrade({
          key: KEY,
          carrierId: 'sip',
          bindingId: 'b2',
          now: NOW,
        }).then((upgrade) => ({
          ...upgrade,
          externalUrl: upgrade.externalUrl.replace('/b2/', '/b1/'),
        })),
        valid: false,
        label: 'signed for another binding',
      },
    ],
  },
  statusMap: { map: mapSipCallState, expected: SIP_STATUS_SNAPSHOT },
  requests: { inbound, status, resume },
  hangupMarkup: /"kind":"ended"/,
});

describe('SIP carrier replay protection', () => {
  it('refuses a replayed nonce on the same verifier', async () => {
    const verifier = createSipRequestVerifier({ keys: [KEY], now: () => NOW });
    const ingress = createSipCarrierIngress({ verifier: () => verifier });
    const route = ingress.routes.find((candidate) => candidate.purpose === 'inbound')!;
    const host = createFakeCarrierHostPorts({ bindings: { b1: binding } });
    expect((await route.handle(inbound, host)).status).toBe(200);
    expect((await route.handle(inbound, host)).status).toBe(401);
    const upgrade = await signedSipUpgrade({
      key: KEY,
      carrierId: 'sip',
      bindingId: 'b1',
      now: NOW,
    });
    const ctx = {
      bindingId: 'b1',
      resolveBinding: host.resolveBinding,
      verifyUrlSecret: () => false,
    };
    expect((await ingress.serializer.authenticateUpgrade(upgrade, ctx)).ok).toBe(true);
    expect((await ingress.serializer.authenticateUpgrade(upgrade, ctx)).ok).toBe(false);
  });
});
