import { PCM16_8K, PCM16_16K, type CarrierCapabilities } from '@winsendotai/ovo-contracts';

export const exotelCapabilities: CarrierCapabilities = {
  carrierId: 'exotel',
  media: {
    formats: [PCM16_8K, PCM16_16K],
    outboundChunk: { minBytes: 3200, maxBytes: 102400, multipleOf: 320 },
    playbackEvidence: 'carrier-processed',
    clear: true,
    clearFlushesMarkers: 'unknown',
    dtmf: true,
    queryOnMediaUrl: true,
  },
  control: {
    callIdTiming: 'at-dial',
    streamParams: 'on-answer',
    streamCallIdMatchesDial: 'unknown',
    cancelBeforeAnswer: false,
    handoff: [],
    amd: 'none',
    maxDuration: true,
    reconcile: 'by-call-id',
    hangup: 'close-stream',
  },
  continuation: 'none',
  webhookAuth: 'url-secret',
  pacing: { cps: 1 },
};
