import { MULAW_8K, type UsageMeter } from '@winsendotai/ovo-contracts';
import { createNodeNet } from '@winsendotai/ovo-plugin-kit';
import { describe, expect, it } from 'vitest';
import { RumikTts } from '../src/tts.ts';
import type { RumikTtsBinding } from '../src/binding.ts';
import { recordingLogger } from './support.ts';

// Env-gated smoke test against the real Silk API (R8). Never runs in CI or on fixture-only hosts:
// set OVO_LIVE_RUMIK_API_KEY (an `rk_live_` key with the tts and streaming scopes) to run it.
// Each run is billed: about 600 characters on pay-as-you-go (₹0.30 on mulberry).
const key = process.env.OVO_LIVE_RUMIK_API_KEY;
const MULBERRY: RumikTtsBinding = {
  description: 'a warm 30s female hindi voice, clear, conversational pacing, like a support agent',
};

/** Speaks `text` and reports bytes and the time to first byte. */
async function speak(tts: RumikTts, text: string, usage: UsageMeter[]) {
  const started = performance.now();
  let firstByteMs: number | undefined;
  let bytes = 0;
  for await (const chunk of tts.synthesize({
    sessionId: 'live-smoke',
    text,
    format: MULAW_8K,
    language: 'hi-IN',
    signal: AbortSignal.timeout(20_000),
    onUsage: (meter) => usage.push(meter),
  })) {
    firstByteMs ??= performance.now() - started;
    bytes += chunk.byteLength;
  }
  return { bytes, firstByteMs };
}

describe.skipIf(!key)('Rumik live smoke (OVO_LIVE_RUMIK_API_KEY)', () => {
  it('streams μ-law for two lines over one minted socket, and over HTTP', async () => {
    const net = createNodeNet();
    // No HTTP fallback on the socket instance, so a broken socket path fails instead of passing.
    const socket = new RumikTts(net, key!, { ...MULBERRY, httpFallback: false });
    const logger = recordingLogger();
    const http = new RumikTts(net, key!, { ...MULBERRY, transport: 'http' }, undefined, logger);
    const usage: UsageMeter[] = [];
    try {
      await socket.warm({ format: MULAW_8K });
      // 8000 μ-law bytes are one second; a short sentence is well over 4000.
      const first = await speak(socket, 'Namaste, main aapki kaise madad kar sakti hoon?', usage);
      const second = await speak(socket, 'Aapka agla EMI paanch tareekh ko due hai.', usage);
      const overHttp = await speak(http, 'Yeh line HTTP se aayi hai.', usage);
      // TTFB per serialized segment is the LAT-5 risk (README): record it from India.
      console.log(
        JSON.stringify({ event: 'rumik_live', first, second, overHttp, usage, http: logger.lines }),
      );
      for (const run of [first, second, overHttp]) expect(run.bytes).toBeGreaterThan(4000);
      expect(usage).toHaveLength(3);
    } finally {
      socket.dispose();
      http.dispose();
      await net.close();
    }
  }, 90_000);

  it('cancels a muga line mid-stream and keeps the socket for the next one', async () => {
    const net = createNodeNet();
    const tts = new RumikTts(net, key!, {
      model: 'muga',
      defaultTone: 'happy',
      httpFallback: false,
    });
    const usage: UsageMeter[] = [];
    try {
      const abort = new AbortController();
      let heard = 0;
      await expect(
        (async () => {
          for await (const chunk of tts.synthesize({
            sessionId: 'live-cancel',
            text: '<laugh> Arre yaar, yeh toh bahut lambi kahani hai, main shuru se sunati hoon.',
            format: MULAW_8K,
            language: 'hi-IN',
            signal: abort.signal,
            onUsage: (meter) => usage.push(meter),
          })) {
            heard += chunk.byteLength;
            abort.abort();
          }
        })(),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(heard).toBeGreaterThan(0);
      const after = await speak(tts, 'Theek hai, chhoti baat karte hain.', usage);
      console.log(JSON.stringify({ event: 'rumik_live_cancel', heard, after, usage }));
      expect(after.bytes).toBeGreaterThan(4000);
    } finally {
      tts.dispose();
      await net.close();
    }
  }, 90_000);
});
