import type { AudioFormat } from '../audio.ts';
import type { PlaybackEvidence } from '../voice/media.ts';
import type { HandoffTarget } from './control.ts';

/** What a carrier can do. Every carrier plugin declares it as `manifest.capabilities` (§2.8). */
export interface CarrierCapabilities {
  carrierId: string;
  media: {
    formats: readonly AudioFormat[];
    outboundChunk?: { minBytes: number; maxBytes: number; multipleOf: number };
    playbackEvidence: PlaybackEvidence;
    clear: boolean;
    clearFlushesMarkers: boolean | 'unknown';
    dtmf: boolean;
    /** Exotel true (its dynamic URL may carry at most 3 pairs); Twilio and Plivo false. */
    queryOnMediaUrl: boolean;
  };
  control: {
    callIdTiming: 'at-dial' | 'after-answer';
    /** 'at-dial' fills `DialRequest.media.routeParams`; 'on-answer' fetches them via `streamForDial`. */
    streamParams: 'at-dial' | 'on-answer';
    streamCallIdMatchesDial: boolean | 'unknown';
    cancelBeforeAnswer: boolean;
    handoff: readonly HandoffTarget['kind'][];
    amd: 'async' | 'sync' | 'none';
    maxDuration: boolean;
    reconcile: 'by-call-id' | 'by-request-id' | 'none';
    /** 'close-stream' carriers need the `streamEndTerminatesCall` binding attestation (§4.10). */
    hangup: 'rest' | 'close-stream';
  };
  continuation: 'markup-after-stream' | 'none';
  webhookAuth: 'hmac-signature' | 'url-secret';
  pacing: { cps: number };
}
