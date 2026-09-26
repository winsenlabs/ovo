import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { PCM16_8K, type SpeechSegment } from '@winsendotai/ovo-contracts';
import {
  createFakeCarrier,
  installEgressSentinel,
  realClock,
  type EgressSentinel,
} from '@winsendotai/ovo-conformance/drivers';
import { Evidence } from '../src/evidence.ts';
let sentinel: EgressSentinel;
beforeAll(() => {
  sentinel = installEgressSentinel({ allowLoopback: false });
});
afterAll(() => {
  try {
    expect(sentinel.attempts).toEqual([]);
  } finally {
    sentinel.restore();
  }
});

async function setup(
  evidence: 'carrier-played' | 'carrier-processed' | 'none' = 'carrier-played',
  weak = false,
) {
  const { initializeLogger } = await import('@livekit/agents');
  initializeLogger({ pretty: false, level: 'silent' });
  const { AudioFrame } = await import('@livekit/rtc-node');
  const { CarrierAudioOutput } = await import('../src/carrier-output.ts');
  const carrier = createFakeCarrier({
    format: PCM16_8K,
    playback: 'manual',
    playbackEvidence: evidence,
    clearFlushesMarkers: true,
  });
  const events: string[] = [];
  const bus = new Evidence(realClock);
  bus.subscribe((e) => {
    if (e.type === 'speech') events.push(e.evidence.phase);
  });
  const output = new CarrierAudioOutput(carrier.duplex, bus, weak, 5);
  const segment: SpeechSegment = {
    id: 'segment-1',
    text: 'Exact prompt?',
    epoch: 1,
    kind: 'response',
    generatedAt: 0,
  };
  const receipt = output.begin(segment);
  let finishes = 0;
  output.on('playbackFinished', () => {
    finishes++;
  });
  await output.captureFrame(
    new AudioFrame(new Int16Array(160), 8000, 1, 160, { segmentId: segment.id }),
  );
  output.flush();
  return { carrier, output, receipt, events, finishes: () => finishes };
}

describe('carrier mark receipt boundary', () => {
  it('flushes a real mark and finishes exactly once on matching acknowledgement', async () => {
    const s = await setup();
    try {
      expect(s.finishes()).toBe(0);
      expect(s.carrier.log.map((e) => e.type)).toContain('mark');
      s.carrier.drain();
      s.carrier.drain();
      expect(await s.receipt).toMatchObject({
        id: 'segment-1',
        text: 'Exact prompt?',
        state: 'completed',
        evidence: 'confirmed',
      });
      expect(s.events).toEqual(['started', 'sent', 'acknowledged', 'completed']);
      expect(s.finishes()).toBe(1);
    } finally {
      s.output.close();
    }
  });
  it('invalidates pending marks before clear synchronously flushes their callbacks', async () => {
    const s = await setup();
    try {
      s.output.clearBuffer();
      s.carrier.drain();
      expect(await s.receipt).toMatchObject({ state: 'interrupted', evidence: 'estimated' });
      expect(s.carrier.log.some((e) => e.type === 'played' && e.flushed)).toBe(true);
      expect(s.events).not.toContain('acknowledged');
      expect(s.finishes()).toBe(1);
    } finally {
      s.output.close();
    }
  });
  it('times out with estimated evidence and ignores the late acknowledgement', async () => {
    const s = await setup();
    try {
      expect(await s.receipt).toMatchObject({ state: 'completed', evidence: 'estimated' });
      s.carrier.drain();
      expect(s.finishes()).toBe(1);
    } finally {
      s.output.close();
    }
  });
  it.each([false, true])(
    'maps weak carrier evidence only with acknowledgement=%s',
    async (weak) => {
      const s = await setup('carrier-processed', weak);
      try {
        s.carrier.drain();
        expect(await s.receipt).toMatchObject({
          evidence: weak ? 'confirmed' : 'estimated',
          ...(weak ? { evidenceSource: 'carrier-processed' } : {}),
        });
      } finally {
        s.output.close();
      }
    },
  );
});
