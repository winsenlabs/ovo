import {
  createFakeCarrierHostPorts,
  describeCarrier,
  loadJsonlFixture,
} from '@winsendotai/ovo-conformance';
import type { CarrierHttpRequest } from '@winsendotai/ovo-contracts';
import { exotelControlFactory, exotelIngress } from '../src/index.ts';
import { EXOTEL_STATUSES, mapExotelStatus } from '../src/status-map.ts';
import { basicAuthorization } from '../src/signature.ts';

const account = 'exotel-account';
const call = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
const binding = {
  bindingId: 'b1',
  pluginId: '@winsendotai/ovo-carrier-exotel',
  workspaceId: 'w1',
  config: {
    accountSid: account,
    apiKey: 'fixture-api-key',
    region: 'in',
    exophone: '0XXXXXX4890',
    appId: 'fixture-app',
    sampleRate: 8000,
    streamEndTerminatesCall: true,
  },
  secret: 'fixture-api-token',
};
const host = createFakeCarrierHostPorts({ bindings: { b1: binding } });

function request(
  purpose: 'media-url' | 'status',
  values: Record<string, string>,
  requestId?: string,
): CarrierHttpRequest {
  const externalUrl = host.callbackUrl(
    'exotel',
    'b1',
    purpose,
    requestId ? { requestId } : undefined,
  );
  return {
    method: 'POST',
    externalUrl,
    bindingId: 'b1',
    query: Object.fromEntries(new URL(externalUrl).searchParams),
    headers: {},
    rawBody: new TextEncoder().encode(new URLSearchParams(values).toString()),
  };
}

const media = request('media-url', {
  CallSid: call,
  CustomField: 'dial-1',
  From: '+919876543210',
  To: '+911234567890',
});
const status = request(
  'status',
  {
    CallSid: call,
    Status: 'busy',
    EventType: 'terminal',
    DateUpdated: '2024-01-15 14:30:45',
    CustomField: 'dial-1',
  },
  'dial-1',
);
const upgradeUrl = new URL('wss://ovo.example.test/carriers/exotel/b1/media');

describeCarrier(
  'Exotel v2',
  ({ net }) => ({ control: exotelControlFactory(net), ingress: exotelIngress }),
  {
    binding,
    transcripts: [
      {
        fixture: loadJsonlFixture(new URL('./fixtures/exotel-media.jsonl', import.meta.url)),
      },
    ],
    rest: {
      dial: {
        scripts: [
          {
            host: 'api.in.exotel.com',
            source: 'https://developer.exotel.com/docs/voice-v1/api-reference/connect-to-flow',
            retrieved: '2026-09-22',
            steps: [
              {
                expect: 'http',
                method: 'POST',
                url: `https://api.in.exotel.com/v1/Accounts/${account}/Calls/connect.json`,
                body: 'form',
                where: {
                  From: '+15550100',
                  CallerId: '0XXXXXX4890',
                  Url: `http://my.exotel.com/${account}/exoml/start_voice/fixture-app`,
                  TimeLimit: '600',
                  TimeOut: '45',
                  'StatusCallbackEvents[0]': 'terminal',
                  'StatusCallbackEvents[1]': 'answered',
                  CustomField: 'dial-1',
                },
                reply: {
                  status: 200,
                  body: JSON.stringify({ Call: { Sid: call, Status: 'in-progress' } }),
                },
              },
            ],
          },
        ],
      },
      reconcile: {
        scripts: [
          {
            host: 'api.in.exotel.com',
            source: 'https://developer.exotel.com/docs/voice-v1/api-reference/call-details',
            retrieved: '2026-09-22',
            steps: [
              {
                expect: 'http',
                method: 'GET',
                url: `https://api.in.exotel.com/v1/Accounts/${account}/Calls/${call}.json`,
                reply: {
                  status: 200,
                  body: JSON.stringify({ Call: { Sid: call, Status: 'busy' } }),
                },
              },
            ],
          },
        ],
        query: { requestId: 'dial-1', carrierCallId: call },
        expect: 'ended',
        state: 'busy',
      },
      hangup: { scripts: [], query: { carrierCallId: call }, expect: 'unsupported' },
    },
    vectors: {
      http: [
        { purpose: 'media-url', request: media, valid: true },
        {
          purpose: 'media-url',
          request: { ...media, query: { ...media.query, t: 'bad' } },
          valid: false,
        },
      ],
      upgrade: [
        {
          request: {
            url: upgradeUrl,
            externalUrl: upgradeUrl.origin + upgradeUrl.pathname,
            headers: { authorization: basicAuthorization('fixture-api-key', 'fixture-api-token') },
          },
          valid: true,
        },
        {
          request: {
            url: upgradeUrl,
            externalUrl: upgradeUrl.origin + upgradeUrl.pathname,
            headers: { authorization: basicAuthorization('fixture-api-key', 'wrong') },
          },
          valid: false,
        },
      ],
    },
    statusMap: { map: mapExotelStatus, expected: EXOTEL_STATUSES },
    requests: { 'media-url': media, status },
    hangupMarkup: /exotel_route_ended/,
    outboundPayload: (frame) => {
      const parsed = JSON.parse(frame) as { event: string; media?: { payload: string } };
      return parsed.event === 'media' && parsed.media
        ? new Uint8Array(Buffer.from(parsed.media.payload, 'base64'))
        : undefined;
    },
  },
);
