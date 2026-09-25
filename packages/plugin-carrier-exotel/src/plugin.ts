import { Cap, type CarrierIngress } from '@winsendotai/ovo-contracts';
import { definePlugin } from '@winsendotai/ovo-runtime';
import { exotelCapabilities } from './capabilities.ts';
import { exotelControlFactory } from './control.ts';
import { exotelRoutes } from './routes.ts';
import { exotelMediaSerializer } from './serializer.ts';
import { createExotelFixtureFrameEncoder, exotelFixtureInboundFrame } from './testing.ts';

export const exotelIngress: CarrierIngress & {
  fixtureInboundFrame: typeof exotelFixtureInboundFrame;
  createFixtureFrameEncoder: typeof createExotelFixtureFrameEncoder;
} = {
  carrierId: 'exotel',
  capabilities: exotelCapabilities,
  serializer: exotelMediaSerializer,
  fixtureInboundFrame: exotelFixtureInboundFrame,
  createFixtureFrameEncoder: createExotelFixtureFrameEncoder,
  routes: exotelRoutes,
  operatorUrls: [
    {
      purpose: 'media-url',
      label: 'Exotel Voicebot dynamic URL',
      help: 'Paste this URL into the Voicebot applet. It contains a binding-level secret and returns a per-call WSS URL.',
    },
    {
      purpose: 'status',
      label: 'Exotel status callback',
      help: 'The call-specific status URL is passed automatically on outbound dials.',
    },
  ],
};

export const exotelCarrierPlugin = definePlugin(
  {
    id: '@winsendotai/ovo-carrier-exotel',
    version: '0.1.0',
    contractVersion: 2,
    scope: 'process',
    kind: 'carrier',
    provider: 'exotel',
    provides: [Cap.carrierControl, Cap.carrierIngress],
    requires: [],
    configSchema: { type: 'object', additionalProperties: false },
    bindingSchema: {
      type: 'object',
      required: ['accountSid', 'apiKey', 'exophone', 'appId', 'streamEndTerminatesCall'],
      additionalProperties: false,
      properties: {
        accountSid: { type: 'string', minLength: 1 },
        apiKey: { type: 'string', minLength: 1 },
        region: { type: 'string', enum: ['sg', 'in'], default: 'in' },
        exophone: { type: 'string', minLength: 1 },
        appId: { type: 'string', minLength: 1 },
        sampleRate: { type: 'integer', enum: [8000, 16000], default: 8000 },
        allowedCidrs: { type: 'array', items: { type: 'string', minLength: 1 } },
        cps: { type: 'number', exclusiveMinimum: 0 },
        streamEndTerminatesCall: { const: true },
      },
    },
    secretFields: ['/credentialRef'],
    capabilities: exotelCapabilities,
    meters: [
      {
        key: 'exotel.carrier.audio_seconds',
        unit: 'audio_seconds',
        label: 'Exotel call audio',
        role: 'carrier',
      },
    ],
    runtime: { egressHosts: ['api.exotel.com', 'api.in.exotel.com'] },
    conformance: ['carrier@1'],
    ui: {
      label: 'Exotel Voicebot',
      vendor: 'Exotel',
      slot: 'carrier',
      fields: {
        streamEndTerminatesCall: {
          widget: 'switch',
          label: 'Voicebot flow ends with Hangup',
          help: 'Confirm the Exotel flow is Voicebot followed by Hangup. Closing the stream must end the call.',
        },
      },
    },
  } as const,
  (ctx) => {
    ctx.provide(Cap.carrierControl, exotelControlFactory(ctx.net));
    ctx.provide(Cap.carrierIngress, exotelIngress);
  },
);

export const plugins = [exotelCarrierPlugin];
