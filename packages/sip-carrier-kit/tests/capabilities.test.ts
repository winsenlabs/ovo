import { MULAW_8K } from '@winsendotai/ovo-contracts';
import { describe, expect, it } from 'vitest';
import {
  SipDialRequestSchema,
  SipMediaFrameOutSchema,
  sipCarrierCapabilities,
} from '../src/index.ts';

describe('sipCarrierCapabilities (§5.6)', () => {
  it('declares the frozen SIP carrier table', () => {
    expect(sipCarrierCapabilities('tcn')).toEqual({
      carrierId: 'tcn',
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
        handoff: ['phone', 'sip'],
        amd: 'none',
        maxDuration: true,
        reconcile: 'by-request-id',
        hangup: 'rest',
      },
      continuation: 'markup-after-stream',
      webhookAuth: 'hmac-signature',
      pacing: { cps: 1 },
    });
  });

  it('takes a handoff override and stays frozen', () => {
    const caps = sipCarrierCapabilities('sip', { handoff: ['phone'] });
    expect(caps.control.handoff).toEqual(['phone']);
    expect(Object.isFrozen(caps)).toBe(true);
    expect(Object.isFrozen(caps.control.handoff)).toBe(true);
  });
});

describe('ovo-sip/1 control and media schemas', () => {
  const dial = {
    requestId: 'req-1',
    carrierId: 'sip',
    bindingId: 'b1',
    trunkId: 'trunk-a',
    to: '+919876543210',
    from: '+918000000001',
    media: { url: 'wss://ovo.example.test/carriers/sip/b1/media', routeParams: { sid: 's' } },
    callbacks: { status: 'https://ovo.example.test/carriers/sip/b1/status?r=req-1&t=x' },
    maxDurationSec: 600,
    credentials: null,
  };

  it('accepts the documented dial body and refuses non-wss media or http callbacks', () => {
    expect(SipDialRequestSchema.safeParse(dial).success).toBe(true);
    expect(
      SipDialRequestSchema.safeParse({ ...dial, media: { ...dial.media, url: 'https://x.test/m' } })
        .success,
    ).toBe(false);
    expect(
      SipDialRequestSchema.safeParse({ ...dial, callbacks: { status: 'http://x.test/s' } }).success,
    ).toBe(false);
    expect(SipDialRequestSchema.safeParse({ ...dial, to: '9876543210' }).success).toBe(false);
  });

  it('parses every gateway → sip-gateway frame and nothing else', () => {
    for (const frame of [
      { event: 'media', payload: '//8=' },
      { event: 'mark', name: 'm1' },
      { event: 'clear' },
      { event: 'terminate' },
    ])
      expect(SipMediaFrameOutSchema.safeParse(frame).success).toBe(true);
    expect(SipMediaFrameOutSchema.safeParse({ event: 'stop' }).success).toBe(false);
  });
});
