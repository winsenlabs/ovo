import { readFileSync } from 'node:fs';
import { silence } from '@winsendotai/ovo-audio';
import {
  MULAW_8K,
  type NetPort,
  type SpeechToText,
  type SttEvent,
  type UsageMeter,
} from '@winsendotai/ovo-contracts';
import { createNodeNet } from '@winsendotai/ovo-plugin-kit';
import { describe, expect, it } from 'vitest';
import { CartesiaAutoStt } from '../src/auto.ts';
import { CartesiaManualStt } from '../src/manual.ts';

// Env-gated smoke tests against the real API (C7). They never run in CI or on fixture-only hosts.
// OVO_LIVE_CARTESIA_API_KEY enables them; OVO_LIVE_CARTESIA_STT_AUDIO (raw 8 kHz μ-law speech,
// e.g. `ffmpeg -i call.wav -ar 8000 -ac 1 -f mulaw call.ulaw`) adds the transcript checks and
// TTFS. Without it, 2 s of silence still proves the handshake, the format and the close path.
// They log time to connect, to first transcript (TTFS) and to final, and settle the README's
// UNCONFIRMED items 1, 5, 6 and 7 when run with Indian-English or Hinglish audio.
const key = process.env.OVO_LIVE_CARTESIA_API_KEY;
const audioPath = process.env.OVO_LIVE_CARTESIA_STT_AUDIO;
const language = process.env.OVO_LIVE_CARTESIA_STT_LANGUAGE ?? 'en-IN';

const now = () => performance.now();
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function run(name: string, make: (net: NetPort) => SpeechToText, manual: boolean) {
  const net = createNodeNet();
  const stt = make(net);
  const events: SttEvent[] = [];
  const usage: UsageMeter[] = [];
  const marks: Record<string, number> = {};
  const started = now();
  const audio = audioPath ? new Uint8Array(readFileSync(audioPath)) : silence(MULAW_8K, 2000);
  try {
    const session = await stt.start({
      sessionId: `live-${name}`,
      format: MULAW_8K,
      language,
      signal: AbortSignal.timeout(60_000),
      onEvent: (event) => {
        events.push(event);
        if (event.type !== 'transcript') return;
        marks.ttfsMs ??= now() - started;
        if (event.segment.stability === 'final') marks.finalMs ??= now() - started;
      },
      onUsage: (meter) => usage.push(meter),
    });
    marks.connectMs = now() - started;
    // Real time: 100 ms of audio per 100 ms, as the provider asks.
    for (let at = 0; at < audio.byteLength; at += 800) {
      await session.write(audio.subarray(at, at + 800));
      await pause(100);
    }
    if (manual) await session.forceEndpoint!();
    await session.finish();
    const finals = events.flatMap((event) =>
      event.type === 'transcript' && event.segment.stability === 'final'
        ? [event.segment.text]
        : [],
    );
    console.log(JSON.stringify({ event: `cartesia_live_stt_${name}`, ...marks, finals, usage }));
    expect(usage).toHaveLength(1);
    if (audioPath) expect(finals.join(' ').trim()).not.toBe('');
  } finally {
    await net.close();
  }
}

describe.skipIf(!key)('Cartesia Ink live smoke (OVO_LIVE_CARTESIA_API_KEY)', () => {
  it('Auto (turns, ink-2): connects, streams μ-law in real time and closes', async () => {
    await run('auto', (net) => new CartesiaAutoStt(net, key!, {}), false);
  }, 120_000);

  it('Manual (ink-2): finalize yields one final at flush_done, then close and done', async () => {
    await run('manual', (net) => new CartesiaManualStt(net, key!, {}), true);
  }, 120_000);
});
