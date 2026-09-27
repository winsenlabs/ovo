import { MULAW_8K, type CarrierCapabilities } from '@winsendotai/ovo-contracts';

export const twilioCapabilities: CarrierCapabilities = Object.freeze({
  carrierId: 'twilio',
  media: {
    queryOnMediaUrl: false,
    dtmf: true,
    clearFlushesMarkers: true,
    clear: true,
    playbackEvidence: 'carrier-played',
    formats: [MULAW_8K],
  },
  control: {
    hangup: 'rest',
    reconcile: 'by-call-id',
    maxDuration: true,
    amd: 'async',
    handoff: ['phone', 'queue', 'resume', 'end'],
    cancelBeforeAnswer: false,
    streamCallIdMatchesDial: true,
    streamParams: 'at-dial',
    callIdTiming: 'at-dial',
  },
  continuation: 'markup-after-stream',
  webhookAuth: 'hmac-signature',
  pacing: { cps: 1 },
} as const satisfies CarrierCapabilities);
