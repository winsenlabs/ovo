import {
  Cap,
  MULAW_8K,
  PCM16_8K,
  PCM16_16K,
  type CarrierCapabilities,
  type CarrierIngress,
  type CarrierMediaEvent,
} from '@winsendotai/ovo-contracts';
import { definePlugin } from '@winsendotai/ovo-runtime';
import { plivoControl } from './control.ts';
import { plivoRoutes } from './routes.ts';
import { plivoSerializer } from './serializer.ts';
import { createPlivoFixtureFrameEncoder } from './testing.ts';

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

export const plivoIngress: CarrierIngress & {
  createFixtureFrameEncoder(): (event: CarrierMediaEvent) => string;
} = {
  carrierId: 'plivo',
  capabilities: plivoCapabilities,
  serializer: plivoSerializer,
  createFixtureFrameEncoder: createPlivoFixtureFrameEncoder,
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
        // The dial and reconcile paths already refuse anything else (control.ts).
        authId: { type: 'string', minLength: 1, pattern: '^[A-Za-z0-9]+$' },
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
      description:
        'Plivo numbers, including Indian DIDs, streamed bidirectionally. See docs/runbooks/indian-did.md.',
      vendor: 'Plivo',
      docsUrl: 'https://www.plivo.com/docs/voice/xml/audio-streaming',
      slot: 'carrier',
      fields: {
        authId: {
          label: 'Auth ID',
          help: 'The account or subaccount Auth ID from the Plivo console (MA… or SA…). The Auth Token is the binding credential.',
          order: 1,
        },
        contentType: {
          label: 'Stream audio format',
          help: 'Keep 8 kHz mu-law: Scribe, AssemblyAI and ElevenLabs ulaw_8000 take it with no transcode, and the per-call clips are rendered in it. L16 is for providers that need linear PCM.',
          widget: 'select',
          order: 2,
        },
        fromNumbers: {
          label: 'Outbound caller IDs',
          help: 'E.164 numbers this binding may dial from, such as +918069450000.',
          order: 3,
        },
        cps: { label: 'Calls per second', help: 'The account dialing limit.', advanced: true },
      },
    },
  },
  (ctx) => {
    ctx.provide(Cap.carrierControl, plivoControl(ctx.net));
    ctx.provide(Cap.carrierIngress, plivoIngress);
  },
);
