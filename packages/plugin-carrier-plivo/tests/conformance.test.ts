import { describe, expect, it } from 'vitest';
import {
  describeCarrier,
  createFakeCarrierHostPorts,
  loadJsonlFixture,
} from '@winsendotai/ovo-conformance';
import type {
  CarrierHttpRequest,
  NetFixtureScript,
  ResolvedBinding,
  UpgradeRequest,
} from '@winsendotai/ovo-contracts';
import { plivoForTest, PLIVO_FIXTURE_HOST } from '../src/testing.ts';
import { signV3 } from '../src/signature.ts';
import { plivoStatus, PLIVO_STATUS_MAP } from '../src/status-map.ts';

const binding: ResolvedBinding = {
  bindingId: 'b1',
  pluginId: '@winsendotai/ovo-carrier-plivo',
  workspaceId: 'w1',
  config: { authId: 'AUTH1' },
  secret: 'plivo-test-token',
};
const host = () => createFakeCarrierHostPorts({ bindings: { b1: binding } });
const body = (form: Record<string, string>) =>
  new TextEncoder().encode(new URLSearchParams(form).toString());

async function signed(
  purpose: 'answer' | 'inbound' | 'status' | 'amd' | 'resume' | 'stream-status',
  form: Record<string, string>,
  requestId?: string,
): Promise<CarrierHttpRequest> {
  const url = host().callbackUrl('plivo', 'b1', purpose, requestId ? { requestId } : undefined);
  const nonce = `nonce-${purpose}`;
  return {
    method: 'POST',
    externalUrl: url,
    query: Object.fromEntries(new URL(url).searchParams),
    headers: {
      'X-Plivo-Signature-V3': await signV3(binding.secret, url, nonce, form),
      'X-Plivo-Signature-V3-Nonce': nonce,
    },
    rawBody: body(form),
    bindingId: 'b1',
  };
}

const answer = await signed('answer', { CallUUID: 'call-1', RequestUUID: 'request-1' }, 'dial-1');
const status = await signed(
  'status',
  { CallUUID: 'call-1', RequestUUID: 'request-1', CallStatus: 'completed' },
  'dial-1',
);
const amd = await signed('amd', { CallUUID: 'call-1', Machine: 'true' }, 'dial-1');
const resume = await signed('resume', { CallUUID: 'call-1' }, 'dial-1');
const inbound = await signed('inbound', {
  CallUUID: 'call-in',
  From: '+15550101',
  To: '+15550102',
});
// An Indian DID as Plivo callbacks have shown it, without the `+` [UNCONFIRMED].
const indianInbound = await signed('inbound', {
  CallUUID: 'call-in-india',
  From: '919812345678',
  To: '918069450000',
});
const upgradeUrl = host().mediaUrl('plivo', 'b1');
const upgradeNonce = 'upgrade-nonce';
const upgrade: UpgradeRequest = {
  url: new URL(upgradeUrl),
  externalUrl: upgradeUrl,
  headers: {
    'X-Plivo-Signature-V3': await signV3(binding.secret, upgradeUrl, upgradeNonce),
    'X-Plivo-Signature-V3-Nonce': upgradeNonce,
  },
};

const script = (
  method: string,
  url: string | RegExp,
  statusCode: number,
  reply = '{}',
  where?: Record<string, unknown>,
): NetFixtureScript[] => [
  {
    host: PLIVO_FIXTURE_HOST,
    source: 'https://www.plivo.com/docs/voice/api/calls',
    retrieved: '2026-09-22',
    steps: [
      {
        expect: 'http',
        method,
        url,
        headers: { authorization: /^Basic / },
        ...(where ? { body: 'json', where } : {}),
        reply: { status: statusCode, body: reply },
      },
    ],
  },
];

describeCarrier('Plivo', ({ net }) => plivoForTest(net), {
  binding,
  transcripts: [{ fixture: loadJsonlFixture(new URL('./fixtures/frames.jsonl', import.meta.url)) }],
  rest: {
    dial: {
      scripts: script(
        'POST',
        'https://api.plivo.com/v1/Account/AUTH1/Call/',
        201,
        JSON.stringify({ request_uuid: 'request-1' }),
        {
          from: '+15550199',
          to: '+15550100',
          time_limit: 600,
        },
      ),
    },
    hangup: {
      scripts: script('DELETE', 'https://api.plivo.com/v1/Account/AUTH1/Call/call-1/', 204),
      query: { carrierCallId: 'call-1' },
      expect: 'ended',
    },
    cancel: {
      scripts: script('DELETE', 'https://api.plivo.com/v1/Account/AUTH1/Request/request-1/', 204),
      carrierRequestId: 'request-1',
    },
    reconcile: {
      scripts: script(
        'GET',
        'https://api.plivo.com/v1/Account/AUTH1/Call/call-1/?status=live',
        200,
        JSON.stringify({ call_status: 'in-progress' }),
      ),
      query: { requestId: 'dial-1', carrierRequestId: 'request-1', carrierCallId: 'call-1' },
      expect: 'live',
      state: 'in_progress',
    },
    handoff: [
      {
        scripts: script('DELETE', 'https://api.plivo.com/v1/Account/AUTH1/Call/call-1/', 204),
        carrierCallId: 'call-1',
        target: { kind: 'end', message: 'Goodbye.' },
      },
    ],
  },
  vectors: {
    http: [
      { purpose: 'answer', request: answer, valid: true, label: 'POST V3' },
      { purpose: 'inbound', request: inbound, valid: true, label: 'inbound POST V3' },
      {
        purpose: 'answer',
        request: { ...answer, headers: { ...answer.headers, 'X-Plivo-Signature-V3': 'tampered' } },
        valid: false,
        label: 'tampered V3',
      },
    ],
    upgrade: [
      { request: upgrade, valid: true, label: 'verbatim wss V3' },
      {
        request: {
          ...upgrade,
          headers: { ...upgrade.headers, 'X-Plivo-Signature-V3-Nonce': 'different-nonce' },
        },
        valid: false,
        label: 'changed nonce',
      },
    ],
  },
  statusMap: { map: plivoStatus, expected: PLIVO_STATUS_MAP },
  requests: { answer, status, amd, resume, inbound: indianInbound },
  outboundPayload: (frame) => {
    const parsed = JSON.parse(frame) as { event: string; media?: { payload: string } };
    return parsed.event === 'playAudio' && parsed.media
      ? Buffer.from(parsed.media.payload, 'base64')
      : undefined;
  },
});

describe('Plivo fail-closed handoff before a host transfer URL is available', () => {
  it.each(['phone', 'resume'] as const)('rejects %s without a network call', async (kind) => {
    const { createFixtureNet } = await import('@winsendotai/ovo-plugin-kit');
    const net = createFixtureNet([]);
    const control = plivoForTest(net).control.create(binding);
    const target =
      kind === 'phone'
        ? ({ kind, e164: '+15550123' } as const)
        : ({
            kind,
            resumeUrl:
              'https://fixture.example.test/carriers/plivo/binding/resume?r=call&t=fixture',
          } as const);
    expect(await control.handoff('call-1', target, 'request-1')).toMatchObject({
      kind: 'rejected',
      retryable: false,
    });
    expect(net.log).toHaveLength(0);
    expect(net.mismatches).toHaveLength(0);
  });
});
