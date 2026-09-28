import { definePlugin } from '@winsendotai/ovo-runtime';
import { Cap, type CarrierIngress, type CarrierMediaEvent } from '@winsendotai/ovo-contracts';
import { twilioCapabilities } from './capabilities.ts';
import { twilioControlFactory } from './control.ts';
import { twilioRoutes } from './routes.ts';
import { twilioMediaSerializer } from './serializer.ts';
import { createTwilioFixtureFrameEncoder, twilioFixtureInboundFrame } from './testing.ts';

export const twilioIngress: CarrierIngress & {
  fixtureInboundFrame(event: CarrierMediaEvent): string;
  createFixtureFrameEncoder(): (event: CarrierMediaEvent) => string;
} = {
  carrierId: 'twilio',
  capabilities: twilioCapabilities,
  serializer: twilioMediaSerializer,
  fixtureInboundFrame: twilioFixtureInboundFrame,
  createFixtureFrameEncoder: createTwilioFixtureFrameEncoder,
  routes: twilioRoutes,
  operatorUrls: [
    {
      purpose: 'inbound',
      label: 'Twilio Voice URL',
      help: 'Paste this URL into the phone number Voice webhook. Twilio POSTs inbound calls here.',
    },
    {
      purpose: 'status',
      label: 'Twilio status callback',
      help: 'Paste this URL into the phone number status callback field.',
    },
  ],
  legacyPaths: {
    '/twilio/media': { purpose: 'media', bindingId: 'env' },
    '/twilio/status': { purpose: 'status', bindingId: 'env' },
    '/twilio/inbound': { purpose: 'inbound', bindingId: 'env' },
  },
};

export const twilioCarrierPlugin = definePlugin(
  {
    id: '@winsendotai/ovo-carrier-twilio',
    version: '0.1.0',
    contractVersion: 2,
    scope: 'process',
    kind: 'carrier',
    provider: 'twilio',
    provides: [Cap.carrierControl, Cap.carrierIngress],
    requires: [],
    configSchema: { type: 'object', additionalProperties: false },
    bindingSchema: {
      type: 'object',
      required: ['accountSid'],
      properties: {
        accountSid: { type: 'string', pattern: '^AC[0-9a-fA-F]{32}$' },
        fromNumbers: { type: 'array', items: { type: 'string' } },
        cps: { type: 'number', exclusiveMinimum: 0 },
      },
      additionalProperties: false,
    },
    secretFields: ['/credentialRef'],
    capabilities: twilioCapabilities,
    meters: [
      {
        key: 'twilio.carrier.audio_seconds',
        unit: 'audio_seconds',
        label: 'Twilio call audio',
        role: 'carrier',
      },
    ],
    runtime: { egressHosts: ['api.twilio.com'] },
    conformance: ['carrier@1'],
    ui: { label: 'Twilio Programmable Voice', vendor: 'Twilio', slot: 'carrier' },
  } as const,
  (ctx) => {
    ctx.provide(Cap.carrierControl, twilioControlFactory(ctx.net));
    ctx.provide(Cap.carrierIngress, twilioIngress);
  },
);

export const plugins = [twilioCarrierPlugin];
