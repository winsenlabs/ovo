import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  describeCarrier,
  createFakeCarrierHostPorts,
  loadJsonlFixture,
} from '@winsendotai/ovo-conformance';
import type { CarrierHttpRequest, NetFixtureScript } from '@winsendotai/ovo-contracts';
import { twilioControlFactory, twilioIngress, twilioSignature } from '../src/index.ts';
import { TWILIO_STATUSES, mapTwilioStatus } from '../src/status-map.ts';

const sid = 'AC00000000000000000000000000000000';
const call = 'CA00000000000000000000000000000000';
const binding = {
  bindingId: 'b1',
  pluginId: '@winsendotai/ovo-carrier-twilio',
  workspaceId: 'w1',
  config: { accountSid: sid },
  secret: 'fixture-auth-token',
};
const source = 'https://www.twilio.com/docs/voice/api/call-resource';
const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls`;

function script(
  method: 'GET' | 'POST',
  callSid: string | undefined,
  reply: { status: number; body: string },
  where?: Record<string, unknown>,
): NetFixtureScript[] {
  return [
    {
      host: 'api.twilio.com',
      source,
      retrieved: '2026-09-22',
      steps: [
        {
          expect: 'http',
          method,
          url: `${url}${callSid ? `/${callSid}` : ''}.json`,
          ...(method === 'POST' ? { body: 'form' as const } : {}),
          ...(where ? { where } : {}),
          reply,
        },
      ],
    },
  ];
}
function response(status: number, fields: Record<string, unknown>) {
  return { status, body: JSON.stringify(fields) };
}
function signed(
  purpose: 'inbound' | 'status' | 'amd' | 'resume',
  fields: Record<string, string>,
  requestId?: string,
): CarrierHttpRequest {
  const host = createFakeCarrierHostPorts({ bindings: { b1: binding } });
  const externalUrl = host.callbackUrl(
    'twilio',
    'b1',
    purpose,
    requestId ? { requestId } : undefined,
  );
  return {
    method: 'POST',
    externalUrl,
    bindingId: 'b1',
    query: Object.fromEntries(new URL(externalUrl).searchParams),
    rawBody: new TextEncoder().encode(new URLSearchParams(fields).toString()),
    headers: { 'x-twilio-signature': twilioSignature(binding.secret, externalUrl, fields) },
  };
}
const status = signed(
  'status',
  { CallSid: call, CallStatus: 'busy', SequenceNumber: '7' },
  'dial-1',
);
const resume = signed('resume', { CallSid: call }, 'dial-1');
const amd = signed('amd', { CallSid: call, AnsweredBy: 'machine_start' }, 'dial-1');
const inbound = signed('inbound', {
  CallSid: call,
  AccountSid: sid,
  From: '+15550123',
  To: '+15550456',
  Direction: 'inbound',
});
const upgradeUrl = 'wss://ovo.example.test/carriers/twilio/b1/media';
const upgrade = (externalUrl: string, signature: string) => ({
  url: new URL(externalUrl),
  externalUrl,
  headers: { 'x-twilio-signature': signature },
});

describeCarrier(
  'Twilio v2',
  ({ net }) => ({ control: twilioControlFactory(net), ingress: twilioIngress }),
  {
    binding,
    transcripts: [
      { fixture: loadJsonlFixture(new URL('./fixtures/twilio-media.jsonl', import.meta.url)) },
    ],
    rest: {
      dial: {
        scripts: script('POST', undefined, response(201, { sid: call, status: 'queued' }), {
          To: '+15550100',
          From: '+15550199',
          TimeLimit: '600',
          Timeout: '60',
          StatusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
          Twiml: /<Redirect method="POST">/,
        }),
      },
      reconcile: {
        scripts: script('GET', call, response(200, { sid: call, status: 'busy' })),
        query: { requestId: 'dial-1', carrierCallId: call },
        expect: 'ended',
        state: 'busy',
      },
      hangup: {
        scripts: script('POST', call, response(200, { sid: call }), { Status: 'completed' }),
        query: { carrierCallId: call },
        expect: 'ended',
      },
      handoff: [
        {
          scripts: script('POST', call, response(200, { sid: call }), {
            Twiml: /<Dial><Number>\+15550123<\/Number><\/Dial>/,
          }),
          carrierCallId: call,
          target: { kind: 'phone', e164: '+15550123' },
        },
        {
          scripts: script('POST', call, response(200, { sid: call }), {
            Twiml: /<Enqueue>kit-queue<\/Enqueue>/,
          }),
          carrierCallId: call,
          target: { kind: 'queue', name: 'kit-queue' },
        },
        {
          scripts: script('POST', call, response(200, { sid: call }), {
            Url: 'https://ovo.example.test/carriers/twilio/b1/resume?r=dial-1&t=fixture-secret',
            Method: 'POST',
          }),
          carrierCallId: call,
          target: {
            kind: 'resume',
            resumeUrl:
              'https://ovo.example.test/carriers/twilio/b1/resume?r=dial-1&t=fixture-secret',
          } as import('../src/control.ts').TwilioHandoffTarget,
        },
        {
          scripts: script('POST', call, response(200, { sid: call }), {
            Twiml: /<Say>Goodbye\.<\/Say><Hangup\/>/,
          }),
          carrierCallId: call,
          target: { kind: 'end', message: 'Goodbye.' },
        },
      ],
    },
    vectors: {
      http: [
        { purpose: 'inbound', request: inbound, valid: true },
        {
          purpose: 'inbound',
          request: { ...inbound, headers: { 'x-twilio-signature': 'invalid' } },
          valid: false,
        },
      ],
      upgrade: [
        { request: upgrade(upgradeUrl, twilioSignature(binding.secret, upgradeUrl)), valid: true },
        {
          request: upgrade(upgradeUrl, twilioSignature(binding.secret, `${upgradeUrl}/`)),
          valid: true,
        },
        {
          request: upgrade(
            'https://ovo.example.test/carriers/twilio/b1/media?edge=1',
            twilioSignature(binding.secret, upgradeUrl),
          ),
          valid: false,
        },
        {
          request: upgrade(
            'wss://evil.example.test/carriers/twilio/b1/media',
            twilioSignature(binding.secret, upgradeUrl),
          ),
          valid: false,
        },
      ],
    },
    statusMap: { map: mapTwilioStatus, expected: TWILIO_STATUSES },
    requests: { status, resume, amd },
  },
);

describe('Twilio signature vectors', () => {
  it('matches the published worked example verbatim', () => {
    const params = {
      Digits: '1234',
      To: '+18005551212',
      From: '+14158675310',
      Caller: '+14158675310',
      CallSid: 'CA1234567890ABCDE',
    };
    expect(twilioSignature('12345', 'https://example.com/myapp.php?foo=1&bar=2', params)).toBe(
      'L/OH5YylLD5NRKLltdqwSvS0BnU=',
    );
  });
  it('matches Node HMAC-SHA1 over deterministic varied inputs', () => {
    for (let i = 0; i < 128; i++) {
      const token = `token-${i}-${'ø'.repeat(i % 7)}`;
      const target = `https://voice.example.test:${8000 + i}/path/${'q'.repeat(i)}?x=${i}`;
      const params = { a: `a-${i}`, Z: 'ABC', ü: `${i}-nonascii` };
      const signed =
        target +
        Object.keys(params)
          .sort()
          .map((key) => key + params[key as keyof typeof params])
          .join('');
      expect(twilioSignature(token, target, params)).toBe(
        createHmac('sha1', token).update(signed).digest('base64'),
      );
    }
  });
});
