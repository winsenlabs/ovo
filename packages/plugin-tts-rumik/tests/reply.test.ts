import { MULAW_8K, type SessionInput, type UsageMeter } from '@winsendotai/ovo-contracts';
import { FakeClock, acceleratedClock } from '@winsendotai/ovo-conformance';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { describe, expect, it } from 'vitest';
import { createFakeCarrier } from '../../conformance/src/drivers/fake-carrier.ts';
import { BoundedSpeechScheduler } from '../../plugin-voice/src/scheduler.ts';
import { NativeStreamingSpeechOutput } from '../../plugin-voice/src/speech/media-output-v2.ts';
import {
  FIXTURE_BINDING,
  FIXTURE_KEY,
  fixtureAudio,
  generationSteps,
  mintSteps,
  socketOpen,
} from '../src/testing.ts';
import { RumikTts } from '../src/tts.ts';
import { binary, drain, fill, flush, frame, script, sent, settle, ttsInput } from './support.ts';

const opening = () => [...mintSteps(MULAW_8K), socketOpen()];
const live = () => new AbortController().signal;

function replyInput(usage: UsageMeter[], signal = live()) {
  const { text: _text, ...input } = ttsInput(usage, { signal });
  return input;
}

describe('R4: a reply on Rumik', () => {
  it("sends each segment only after the previous segment's done", async () => {
    const clock = new FakeClock();
    const net = createFixtureNet(
      [
        script([
          ...opening(),
          sent({ text: 'Aapka EMI paanch tareekh ko hai.' }),
          binary(fill(400, 1)),
          { delayMs: 500 },
          frame({ type: 'done' }),
          sent({ text: 'Kya main link bhej doon?' }),
          binary(fill(400, 2)),
          frame({ type: 'done' }),
        ]),
      ],
      { clock },
    );
    const usage: UsageMeter[] = [];
    const tts = new RumikTts(net, FIXTURE_KEY, FIXTURE_BINDING, clock);
    const reply = await tts.openReply(replyInput(usage));
    // Both segments are pushed at once, as the speech output does; the second waits its turn.
    const first = drain(reply.segment('Aapka EMI paanch tareekh ko hai.', live()));
    const second = drain(reply.segment('Kya main link bhej doon?', live()));
    await flush();
    expect(net.log.filter((entry) => entry.kind === 'ws-out')).toHaveLength(1);
    await clock.advanceAsync(500);
    expect(await first).toEqual(fill(400, 1));
    expect(await second).toEqual(fill(400, 2));
    await reply.close();
    const kinds = net.log.map((entry) => `${entry.kind}:${String(entry.data).slice(0, 20)}`);
    expect(kinds.findIndex((entry) => entry.includes('Kya main'))).toBeGreaterThan(
      kinds.findIndex((entry) => entry.includes('"type":"done"')),
    );
    expect(usage.map((meter) => meter.requestId)).toEqual(['rumik:call-1:1', 'rumik:call-1:2']);
    net.assertComplete();
  });

  it('barge-in ends every unfinished segment at once: queued ones are never sent', async () => {
    const net = createFixtureNet([
      script([
        ...opening(),
        sent({ text: 'Pehla vaakya.' }),
        binary(fill(160, 1)),
        sent({ type: 'cancel' }),
        binary(fill(160, 9)),
        frame({ type: 'cancelled', request_id: 'r', reason: 'cancel' }),
        // The socket outlives the reply: the next line goes out on it, no new mint.
        sent({ text: 'Ji, boliye.' }),
        binary(fill(160, 4)),
        frame({ type: 'done' }),
      ]),
    ]);
    const usage: UsageMeter[] = [];
    const tts = new RumikTts(net, FIXTURE_KEY, FIXTURE_BINDING);
    const reply = await tts.openReply(replyInput(usage));
    const segments = ['Pehla vaakya.', 'Doosra vaakya.', 'Teesra vaakya.'].map((text) =>
      reply.segment(text, live()),
    );
    const iterator = segments[0]![Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual(new Uint8Array(fill(160, 1)));
    const closedAt = Date.now();
    await reply.close();
    // A closed reply's segments end quietly (no error), with nothing more to play.
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(await settle(segments[1]!)).toEqual({ bytes: [] });
    expect(await settle(segments[2]!)).toEqual({ bytes: [] });
    expect(Date.now() - closedAt).toBeLessThan(1000);
    expect(() => reply.segment('Late.', live())).toThrow(/closed/);
    expect(await drain(tts.synthesize(ttsInput(usage, { text: 'Ji, boliye.' })))).toEqual(
      fill(160, 4),
    );
    expect(usage.map((meter) => meter.requestId)).toEqual(['rumik:call-1:1', 'rumik:call-1:4']);
    expect(net.log.filter((entry) => entry.kind === 'http')).toHaveLength(1);
    net.assertComplete();
  });

  it("aborting one segment's signal drops that segment only; the reply goes on", async () => {
    const net = createFixtureNet([
      script([
        ...opening(),
        ...generationSteps('Ek baat.', MULAW_8K, 1),
        ...generationSteps('Doosri baat.', MULAW_8K, 2),
      ]),
    ]);
    const tts = new RumikTts(net, FIXTURE_KEY, FIXTURE_BINDING);
    const reply = await tts.openReply(replyInput([]));
    const skipped = new AbortController();
    skipped.abort();
    expect(await settle(reply.segment('Chhodo.', skipped.signal))).toMatchObject({
      bytes: [],
      error: { name: 'AbortError' },
    });
    expect(await drain(reply.segment('Ek baat.', live()))).toHaveLength(
      fixtureAudio(MULAW_8K, 'Ek baat.', 1).byteLength,
    );
    expect(await drain(reply.segment('Doosri baat.', live()))).toHaveLength(
      fixtureAudio(MULAW_8K, 'Doosri baat.', 2).byteLength,
    );
    await reply.close();
    net.assertComplete();
  });

  it("closes with the reply's own signal, and refuses a non-native format", async () => {
    const tts = new RumikTts(createFixtureNet([]), FIXTURE_KEY, FIXTURE_BINDING);
    const signal = new AbortController();
    const reply = await tts.openReply(replyInput([], signal.signal));
    signal.abort();
    expect(() => reply.segment('Hello.', live())).toThrow(/closed/);
    await expect(
      tts.openReply({ ...replyInput([]), format: { ...MULAW_8K, encoding: 'alaw' } }),
    ).rejects.toThrow(TypeError);
  });
});

// The speech output end to end: the scheduler speaks a reply sentence by sentence through
// `openReply`, and every sentence keeps its own carrier mark with exactly its own audio.
it('speaks a reply with one mark per sentence through the speech output', async () => {
  const session: SessionInput = {
    mode: 'agent',
    language: 'hi-IN',
    inputEnabled: true,
    variables: {},
    maxCallSeconds: 60,
    acknowledgements: [],
  };
  const texts = ['Aapka EMI 4,850 rupees ka hai.', 'Kya main link bhej doon?'];
  const net = createFixtureNet([
    script([
      ...opening(),
      ...texts.flatMap((text, index) => generationSteps(text, MULAW_8K, index + 1)),
      sent({ type: 'close' }),
    ]),
  ]);
  const tts = new RumikTts(net, FIXTURE_KEY, FIXTURE_BINDING);
  const carrier = createFakeCarrier({ clock: acceleratedClock(0) });
  const output = new NativeStreamingSpeechOutput(tts, carrier.duplex, session, () => undefined);
  const speech = new BoundedSpeechScheduler(output);
  speech.configurePipeline(2);
  const receipts = await Promise.all(texts.map((text) => speech.speak(text)));
  expect(receipts).toMatchObject([
    { text: texts[0], state: 'completed' },
    { text: texts[1], state: 'completed' },
  ]);
  const audio = carrier.log.filter((entry) => entry.type === 'audio');
  const marks = carrier.log.filter((entry) => entry.type === 'mark');
  expect(marks).toHaveLength(2);
  const before = (mark: (typeof marks)[number]) =>
    audio
      .filter((entry) => carrier.log.indexOf(entry) < carrier.log.indexOf(mark))
      .reduce((sum, entry) => sum + entry.bytes, 0);
  const first = fixtureAudio(MULAW_8K, texts[0]!, 1).byteLength;
  const second = fixtureAudio(MULAW_8K, texts[1]!, 2).byteLength;
  expect(before(marks[0]!)).toBe(first);
  expect(before(marks[1]!)).toBe(first + second);
  output.dispose();
  await speech.dispose();
  tts.dispose();
  expect(net.pending()).toEqual([]);
  expect(net.mismatches).toEqual([]);
});
