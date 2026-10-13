import { MULAW_8K, type UsageMeter } from '@winsendotai/ovo-contracts';
import { createNodeNet } from '@winsendotai/ovo-plugin-kit';
import { describe, expect, it } from 'vitest';
import { CartesiaTts } from '../src/tts.ts';

// Env-gated smoke test against the real API (C7). It never runs in CI or on fixture-only hosts:
// set OVO_LIVE_CARTESIA_API_KEY (and optionally OVO_LIVE_CARTESIA_VOICE_ID) to run it. It logs
// time to first audio (TTFA) and settles the README's UNCONFIRMED items 1-4 when run.
const key = process.env.OVO_LIVE_CARTESIA_API_KEY;
const voiceId = process.env.OVO_LIVE_CARTESIA_VOICE_ID ?? '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc';

const now = () => performance.now();

describe.skipIf(!key)('Cartesia Sonic live smoke (OVO_LIVE_CARTESIA_API_KEY)', () => {
  it('streams μ-law for two utterances on one socket and logs TTFA', async () => {
    const net = createNodeNet();
    const tts = new CartesiaTts(net, key!, { voiceId, normalization: 'en-IN' });
    const usage: UsageMeter[] = [];
    try {
      const warmStart = now();
      await tts.warm({ format: MULAW_8K });
      const warmMs = now() - warmStart;
      for (const text of ['Hello, this is a short test.', 'Your EMI of 4,250 rupees is due.']) {
        const started = now();
        let ttfaMs: number | undefined;
        let bytes = 0;
        for await (const piece of tts.synthesize({
          sessionId: 'live-smoke',
          text,
          format: MULAW_8K,
          language: 'en-IN',
          signal: AbortSignal.timeout(15_000),
          onUsage: (meter) => usage.push(meter),
        })) {
          ttfaMs ??= now() - started;
          bytes += piece.byteLength;
        }
        console.log(JSON.stringify({ event: 'cartesia_live_tts', warmMs, ttfaMs, bytes }));
        // 8000 μ-law bytes are one second; a short sentence is well over half of that.
        expect(bytes).toBeGreaterThan(4000);
      }
      expect(usage).toHaveLength(2);
    } finally {
      tts.dispose();
      await net.close();
    }
  }, 60_000);

  it('renders a two-segment reply, ending each segment at its flush_done', async () => {
    const net = createNodeNet();
    const tts = new CartesiaTts(net, key!, { voiceId });
    const usage: UsageMeter[] = [];
    try {
      const reply = await tts.openReply({
        sessionId: 'live-reply',
        format: MULAW_8K,
        language: 'en-IN',
        signal: AbortSignal.timeout(15_000),
        onUsage: (meter) => usage.push(meter),
      });
      const sizes: number[] = [];
      const segments = ['Your payment is due on the fifth.', 'Shall I send a link?'].map((text) =>
        reply.segment(text, AbortSignal.timeout(15_000)),
      );
      for (const segment of segments) {
        let bytes = 0;
        for await (const piece of segment) bytes += piece.byteLength;
        sizes.push(bytes);
      }
      await reply.close();
      console.log(JSON.stringify({ event: 'cartesia_live_reply', sizes, usage }));
      expect(sizes.every((size) => size > 4000)).toBe(true);
    } finally {
      tts.dispose();
      await net.close();
    }
  }, 60_000);
});
