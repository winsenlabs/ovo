import { MULAW_8K, type NetFixtureScript, type UsageMeter } from '@winsendotai/ovo-contracts';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { describe, expect, it } from 'vitest';
import { SarvamStt } from '../src/stt.ts';
import { SarvamTts } from '../src/tts.ts';
import { sarvamTtsTemplate } from '../src/testing.ts';

// Wave 2 request 4: the worker dedupes usage on (sourceKind, requestId, unit), so a call whose
// utterances or STT sessions share an id is billed for the first one only.

const STT_SOURCE =
  'https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming';

function refusedStt(): NetFixtureScript {
  return {
    host: 'api.sarvam.ai',
    source: STT_SOURCE,
    retrieved: '2026-10-06',
    steps: [
      { expect: 'ws-open', url: /^wss:\/\/api\.sarvam\.ai\/speech-to-text-realtime\/ws\?/ },
      { close: { code: 1011, reason: 'provider failure' } },
    ],
  };
}

const ttsInput = (usage: UsageMeter[], text: string) => ({
  sessionId: 'sarvam-ids',
  format: MULAW_8K,
  language: 'hi-IN',
  text,
  signal: new AbortController().signal,
  onUsage: (meter: UsageMeter) => usage.push(meter),
});

describe('Sarvam usage request ids are distinct per utterance and per session', () => {
  it('meters two utterances of one call under two ids, even when the provider repeats its id', async () => {
    const texts = ['नमस्ते', 'धन्यवाद'];
    // The fixture replays one provider request_id for both sockets.
    const net = createFixtureNet(
      sarvamTtsTemplate({
        format: MULAW_8K,
        language: 'hi-IN',
        sessionId: 'sarvam-ids',
        turns: [],
        agentTexts: texts,
      }),
    );
    const tts = new SarvamTts(net, 'fixture-key');
    const usage: UsageMeter[] = [];
    for (const text of texts) for await (const _ of tts.synthesize(ttsInput(usage, text)));
    expect(usage.map((meter) => meter.requestId)).toEqual([
      'sarvam-tts-fixture/1',
      'sarvam-tts-fixture/2',
    ]);
    net.assertComplete();
  });

  it('numbers incremental sessions on the same instance', async () => {
    const net = createFixtureNet(
      sarvamTtsTemplate({
        format: MULAW_8K,
        language: 'hi-IN',
        sessionId: 'sarvam-ids',
        turns: [],
        agentTexts: ['एक', 'दो'],
      }),
    );
    const tts = new SarvamTts(net, 'fixture-key');
    const usage: UsageMeter[] = [];
    for (const text of ['एक', 'दो']) {
      const { text: _, ...input } = ttsInput(usage, text);
      const session = await tts.open(input);
      session.push(text);
      session.flush();
      for await (const _chunk of session.audio);
      await session.close();
    }
    expect(new Set(usage.map((meter) => meter.requestId)).size).toBe(2);
  });

  it('gives a reconnect its own synthetic STT id', async () => {
    const net = createFixtureNet([refusedStt(), refusedStt()]);
    const stt = new SarvamStt(net, 'fixture-key');
    const usage: UsageMeter[] = [];
    const input = {
      sessionId: 'sarvam-ids',
      format: MULAW_8K,
      language: 'hi-IN',
      signal: new AbortController().signal,
      onEvent: () => undefined,
      onUsage: (meter: UsageMeter) => usage.push(meter),
    };
    await expect(stt.start(input)).rejects.toThrow();
    await expect(stt.start(input)).rejects.toThrow();
    expect(usage.map((meter) => meter.requestId)).toEqual([
      'sarvam:sarvam-ids:1',
      'sarvam:sarvam-ids:2',
    ]);
  });
});
