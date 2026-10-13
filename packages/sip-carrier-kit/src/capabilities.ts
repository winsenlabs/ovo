import { MULAW_8K, type CarrierCapabilities, type HandoffTarget } from '@winsendotai/ovo-contracts';

/**
 * The carrier declaration every SIP-delivered carrier shares (W11 §5.6). The sip-gateway transcodes
 * A-law, reframes to 20 ms and paces playout itself, so the worker sees a Twilio-like μ-law stream
 * with carrier-played marks. Handoff stays empty unless the B2BUA path is proven for a carrier.
 */
export function sipCarrierCapabilities(
  carrierId: string,
  overrides: { handoff?: HandoffTarget['kind'][] } = {},
): CarrierCapabilities {
  return Object.freeze({
    carrierId,
    media: {
      formats: [MULAW_8K],
      playbackEvidence: 'carrier-played',
      clear: true,
      clearFlushesMarkers: true,
      dtmf: true,
      queryOnMediaUrl: false,
    },
    control: {
      callIdTiming: 'at-dial',
      streamParams: 'at-dial',
      streamCallIdMatchesDial: true,
      cancelBeforeAnswer: true,
      handoff: Object.freeze([...(overrides.handoff ?? [])]),
      amd: 'none',
      maxDuration: true,
      reconcile: 'by-request-id',
      hangup: 'rest',
    },
    continuation: 'markup-after-stream',
    webhookAuth: 'hmac-signature',
    pacing: { cps: 1 },
  } satisfies CarrierCapabilities);
}
