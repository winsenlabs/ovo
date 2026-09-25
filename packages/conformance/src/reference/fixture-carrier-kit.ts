import type {
  CarrierHttpRequest,
  NetFixtureScript,
  UpgradeRequest,
} from '@winsendotai/ovo-contracts';
import { createFakeCarrierHostPorts, fakeBinding } from '../drivers/carrier-host-ports.ts';
import {
  FIXTURE_CARRIER_ID,
  FIXTURE_SIGNATURE_HEADER,
  FIXTURE_STATUS_MAP,
  fixtureSignature,
  fixtureStatusOf,
  fixtureWebhook,
  signFixtureRequest,
} from '../drivers/fixture-carrier.ts';
import { loadJsonlFixture } from '../drivers/jsonl.ts';
import type { CarrierKitOptions } from '../kit/carrier-support.ts';

const REST = {
  host: 'fixture.invalid',
  source: 'https://fixture.invalid/docs/rest',
  retrieved: '2026-09-22',
};

function signed(
  purpose: 'status' | 'answer' | 'resume',
  form: Record<string, string>,
): CarrierHttpRequest {
  const binding = fakeBinding();
  const host = createFakeCarrierHostPorts();
  const url = new URL(
    host.callbackUrl(FIXTURE_CARRIER_ID, binding.bindingId, purpose, { requestId: 'dial-1' }),
  );
  const request = fixtureWebhook({
    externalUrl: `${url.origin}${url.pathname}`,
    bindingId: binding.bindingId,
    query: Object.fromEntries(url.searchParams),
    form,
  });
  return signFixtureRequest(binding.secret, request);
}

function upgrade(signature: string | undefined, query = ''): UpgradeRequest {
  const externalUrl = `wss://ovo.example.test/carriers/${FIXTURE_CARRIER_ID}/b1/media`;
  return {
    url: new URL(`${externalUrl}${query}`),
    externalUrl,
    headers: signature === undefined ? {} : { [FIXTURE_SIGNATURE_HEADER]: signature },
  };
}

/**
 * CarrierKitOptions for the fixture carrier: the worked example every carrier package follows
 * (transcripts, REST scripts, signature vectors, status-map snapshot and signed route requests).
 */
export function fixtureCarrierKitOptions(
  mode: 'at-dial' | 'on-answer' = 'at-dial',
): CarrierKitOptions {
  const binding = fakeBinding();
  const status = signed('status', { CallSid: 'CA1', CallStatus: 'completed' });
  const dial: NetFixtureScript = {
    ...REST,
    steps: [
      {
        expect: 'http',
        method: 'POST',
        url: 'https://fixture.invalid/v1/calls',
        body: 'form',
        where:
          mode === 'at-dial'
            ? { To: '+15550100', StreamUrl: /^wss:\/\/[^?]+$/, Param_sid: 'session-1' }
            : { To: '+15550100', AnswerUrl: /\/answer\?r=dial-1&t=/ },
        reply: { status: 201, body: JSON.stringify({ id: mode === 'at-dial' ? 'CA1' : 'RQ1' }) },
      },
    ],
  };
  const tampered = {
    ...status,
    rawBody: new TextEncoder().encode('CallSid=CA1&CallStatus=failed'),
  };
  const lookupId = mode === 'at-dial' ? 'CA1' : 'RQ1';
  const reconcileScript: NetFixtureScript = {
    ...REST,
    steps: [
      {
        expect: 'http',
        method: 'GET',
        url: `https://fixture.invalid/v1/calls/${lookupId}`,
        reply: { status: 200, body: JSON.stringify({ id: lookupId, status: 'completed' }) },
      },
    ],
  };
  const handoffScript = (markup: string): NetFixtureScript => ({
    ...REST,
    steps: [
      {
        expect: 'http',
        method: 'POST',
        url: 'https://fixture.invalid/v1/calls/CA1',
        body: 'form',
        where: { Markup: markup, RequestId: 'handoff-1' },
        reply: { status: 200, body: JSON.stringify({ id: 'HX1' }) },
      },
    ],
  });
  return {
    binding,
    transcripts: [
      {
        fixture: loadJsonlFixture(new URL('../../fixtures/fixture-carrier.jsonl', import.meta.url)),
      },
    ],
    rest: {
      dial: { scripts: [dial] },
      hangup: {
        scripts: [
          {
            ...REST,
            steps: [
              {
                expect: 'http',
                method: 'POST',
                url: 'https://fixture.invalid/v1/calls/CA1',
                body: 'form',
                where: { Status: 'completed' },
                reply: { status: 200, body: '{}' },
              },
            ],
          },
        ],
        query: { carrierCallId: 'CA1' },
        expect: 'ended',
      },
      cancel: {
        scripts: [
          {
            ...REST,
            steps: [
              {
                expect: 'http',
                method: 'DELETE',
                url: 'https://fixture.invalid/v1/requests/RQ1',
                reply: { status: 204 },
              },
            ],
          },
        ],
        carrierRequestId: 'RQ1',
      },
      reconcile: {
        scripts: [reconcileScript],
        query:
          mode === 'at-dial'
            ? { requestId: 'dial-1', carrierCallId: 'CA1' }
            : { requestId: 'dial-1', carrierRequestId: 'RQ1' },
        expect: 'ended',
        state: 'completed',
      },
      handoff: [
        {
          scripts: [handoffScript('<Dial>+15550123</Dial>')],
          carrierCallId: 'CA1',
          target: { kind: 'phone', e164: '+15550123' },
        },
        {
          scripts: [handoffScript('<Say>Goodbye.</Say><Hangup/>')],
          carrierCallId: 'CA1',
          target: { kind: 'end', message: 'Goodbye.' },
        },
      ],
    },
    vectors: {
      http: [
        { purpose: 'status', request: status, valid: true, label: 'signed status callback' },
        { purpose: 'status', request: tampered, valid: false, label: 'tampered body' },
        {
          purpose: 'status',
          request: { ...status, headers: {} },
          valid: false,
          label: 'missing signature',
        },
      ],
      upgrade: [
        {
          request: upgrade(fixtureSignature(binding.secret, upgrade(undefined).externalUrl)),
          valid: true,
          label: 'signed upgrade',
        },
        { request: upgrade('bm90LWEtc2lnbmF0dXJl'), valid: false, label: 'wrong signature' },
        {
          request: upgrade(
            fixtureSignature(binding.secret, upgrade(undefined).externalUrl),
            '?sid=1',
          ),
          valid: false,
          label: 'query on the media URL',
        },
      ],
    },
    statusMap: { map: fixtureStatusOf, expected: FIXTURE_STATUS_MAP },
    requests: {
      status,
      answer: signed('answer', { CallSid: 'CA1' }),
      resume: signed('resume', { CallSid: 'CA1' }),
    },
    hangupMarkup: /<Hangup\/>/,
  };
}
