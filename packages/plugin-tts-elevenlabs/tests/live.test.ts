import { MULAW_8K, type UsageMeter } from '@winsendotai/ovo-contracts';
import { createNodeNet } from '@winsendotai/ovo-plugin-kit';
import { describe, expect, it } from 'vitest';
import { ElevenLabsTts } from '../src/tts.ts';

// Env-gated smoke test against the real API (TTS-12). Never runs in CI or on fixture-only hosts:
// set OVO_LIVE_ELEVENLABS_API_KEY (and optionally OVO_LIVE_ELEVENLABS_VOICE_ID) to run it.
const key = process.env.OVO_LIVE_ELEVENLABS_API_KEY;
const voiceId = process.env.OVO_LIVE_ELEVENLABS_VOICE_ID;

async function speak(tts: ElevenLabsTts, text: string, usage: UsageMeter[]): Promise<number> {
  let bytes = 0;
  for await (const chunk of tts.synthesize({
    sessionId: 'live-smoke',
    text,
    format: MULAW_8K,
    language: 'en-IN',
    signal: AbortSignal.timeout(15_000),
    onUsage: (meter) => usage.push(meter),
  }))
    bytes += chunk.byteLength;
  return bytes;
}

describe.skipIf(!key)('ElevenLabs live smoke (OVO_LIVE_ELEVENLABS_API_KEY)', () => {
  it('streams μ-law for two utterances over one socket, and over HTTP', async () => {
    const net = createNodeNet();
    // No HTTP fallback on the socket instance, so a broken socket path fails instead of passing over HTTP.
    const socket = new ElevenLabsTts(net, key!, {
      httpFallback: false,
      ...(voiceId ? { voiceId } : {}),
    });
    const http = new ElevenLabsTts(net, key!, {
      transport: 'http',
      ...(voiceId ? { voiceId } : {}),
    });
    const usage: UsageMeter[] = [];
    try {
      // 8000 μ-law bytes are one second; a short sentence is well over 4000.
      expect(await speak(socket, 'Hello, this is a short test.', usage)).toBeGreaterThan(4000);
      expect(await speak(socket, 'And this is the second line.', usage)).toBeGreaterThan(4000);
      expect(await speak(http, 'And this one came over HTTP.', usage)).toBeGreaterThan(4000);
      // A reconciled HTTP meter would confirm the UNCONFIRMED character-cost header on a live call.
      console.log(JSON.stringify({ event: 'elevenlabs_live_usage', usage }));
      expect(usage).toHaveLength(3);
    } finally {
      socket.dispose();
      await net.close();
    }
  }, 60_000);

  // LAT-5: confirms the UNCONFIRMED parts of the reply context on the real API. Both sentences
  // must get their own audio; if frames carried no alignment, every byte would land on the first.
  it('renders a two-sentence reply in one context and cuts it by alignment', async () => {
    const net = createNodeNet();
    const tts = new ElevenLabsTts(net, key!, {
      httpFallback: false,
      ...(voiceId ? { voiceId } : {}),
    });
    const usage: UsageMeter[] = [];
    try {
      await tts.warm({ format: MULAW_8K });
      const reply = await tts.openReply!({
        sessionId: 'live-reply',
        format: MULAW_8K,
        language: 'en-IN',
        signal: AbortSignal.timeout(15_000),
        onUsage: (meter) => usage.push(meter),
      });
      const sizes: number[] = [];
      const segments = ['Your EMI is due on the fifth.', 'Shall I send you a payment link?'].map(
        (text) => reply.segment(text, AbortSignal.timeout(15_000)),
      );
      for (const segment of segments) {
        let bytes = 0;
        for await (const chunk of segment) bytes += chunk.byteLength;
        sizes.push(bytes);
      }
      await reply.close();
      console.log(JSON.stringify({ event: 'elevenlabs_live_reply', sizes, usage }));
      expect(sizes[0]).toBeGreaterThan(4000);
      expect(sizes[1]).toBeGreaterThan(4000);
      expect(usage).toHaveLength(2);
    } finally {
      tts.dispose();
      await net.close();
    }
  }, 60_000);
});
