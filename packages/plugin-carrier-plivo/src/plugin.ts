import {
  Cap,
  MULAW_8K,
  PCM16_8K,
  PCM16_16K,
  type CarrierCapabilities,
  type CarrierIngress,
} from '@winsendotai/ovo-contracts';
import { definePlugin } from '@winsendotai/ovo-runtime';
import { plivoControl } from './control.ts';
import { plivoRoutes } from './routes.ts';
import { plivoSerializer } from './serializer.ts';

export const plivoCapabilities = {
  carrierId: 'plivo',
  media: {
    formats: [MULAW_8K, PCM16_8K, PCM16_16K],
    outboundChunk: { minBytes: 1, maxBytes: 12_000, multipleOf: 1 },
    playbackEvidence: 'carrier-played',
    clear: true,
    clearFlushesMarkers: 'unknown',
    dtmf: true,
    queryOnMediaUrl: false,
  },
  control: {
    callIdTiming: 'after-answer',
    streamParams: 'on-answer',
    streamCallIdMatchesDial: true,
    cancelBeforeAnswer: true,
    handoff: ['end'],
    amd: 'async',
    maxDuration: true,
    reconcile: 'by-call-id',
    hangup: 'rest',
  },
  continuation: 'markup-after-stream',
  webhookAuth: 'hmac-signature',
  pacing: { cps: 2 },
} as const satisfies CarrierCapabilities;

export const plivoIngress: CarrierIngress = {
  carrierId: 'plivo',
  capabilities: plivoCapabilities,
  serializer: plivoSerializer,
  routes: plivoRoutes(),
  operatorUrls: [
    {
      purpose: 'inbound',
      label: 'Plivo Answer URL',
      help: 'Set as the POST answer URL on each inbound Plivo application.',
    },
    {
      purpose: 'status',
      label: 'Plivo Hangup URL',
      help: 'Plivo calls this binding-scoped status URL when a call ends.',
    },
  ],
};

export const plivoPlugin = definePlugin(
  {
    id: '@winsendotai/ovo-carrier-plivo',
    version: '0.1.0',
    contractVersion: 2,
    kind: 'carrier',
    provider: 'plivo',
    scope: 'process',
    provides: [Cap.carrierControl, Cap.carrierIngress],
    requires: [],
    configSchema: { type: 'object', additionalProperties: false },
    bindingSchema: {
      type: 'object',
      required: ['authId'],
      additionalProperties: false,
      properties: {
        authId: { type: 'string', minLength: 1 },
        fromNumbers: { type: 'array', items: { type: 'string' } },
        contentType: {
          type: 'string',
          enum: ['audio/x-mulaw;rate=8000', 'audio/x-l16;rate=8000', 'audio/x-l16;rate=16000'],
          default: 'audio/x-mulaw;rate=8000',
        },
        cps: { type: 'number', minimum: 1 },
        credentialRef: { type: 'object' },
      },
    },
    secretFields: ['/credentialRef'],
    capabilities: plivoCapabilities,
    meters: [
      {
        key: 'plivo.carrier.audio_seconds',
        unit: 'audio_seconds',
        label: 'Plivo call audio',
        role: 'carrier',
      },
    ],
    runtime: { egressHosts: ['api.plivo.com'] },
    conformance: ['carrier@1'],
    ui: {
      label: 'Plivo Voice',
      vendor: 'Plivo',
      docsUrl: 'https://www.plivo.com/docs/voice/xml/audio-streaming',
    },
  },
  (ctx) => {
    ctx.provide(Cap.carrierControl, plivoControl(ctx.net));
    ctx.provide(Cap.carrierIngress, plivoIngress);
  },
);
