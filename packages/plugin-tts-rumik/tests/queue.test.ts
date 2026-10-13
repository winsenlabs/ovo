import { MULAW_8K, PCM16_24K, type UsageMeter } from '@winsendotai/ovo-contracts';
import { FakeClock } from '@winsendotai/ovo-conformance';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { describe, expect, it } from 'vitest';
import { CANCEL_ACK_MS } from '../src/lane.ts';
import {
  FIXTURE_BINDING,
  FIXTURE_KEY,
  fixtureAudio,
  generationSteps,
  mintSteps,
  socketOpen,
  synthesisStep,
} from '../src/testing.ts';
import { RumikTts } from '../src/tts.ts';
import {
  binary,
  drain,
  fill,
  flush,
  frame,
  httpScript,
  script,
  sent,
  settle,
  ttsInput,
} from './support.ts';

const opening = () => [...mintSteps(MULAW_8K), socketOpen()];
const cancelled = (reason = 'cancel') => frame({ type: 'cancelled', request_id: 'r', reason });

describe('R3: one generation at a time, in order', () => {
  it("sends the next text frame only after the previous generation's done", async () => {
    const clock = new FakeClock();
    // While the delay runs the script expects nothing from the client: an early second text frame
    // would be a fixture mismatch.
    const net = createFixtureNet(
      [
        script([
          ...opening(),
          sent({ text: 'Pehli line.' }),
          binary(fill(400, 1)),
          { delayMs: 300 },
          binary(fill(400, 2)),
          frame({ type: 'done', request_id: 'gen-a' }),
          sent({ text: 'Doosri line.' }),
          binary(fill(400, 3)),
          frame({ type: 'done', request_id: 'gen-b' }),
        ]),
      ],
      { clock },
    );
    const usage: UsageMeter[] = [];
    const tts = new RumikTts(net, FIXTURE_KEY, FIXTURE_BINDING, clock);
    const first = drain(tts.synthesize(ttsInput(usage, { text: 'Pehli line.' })));
    const second = drain(tts.synthesize(ttsInput(usage, { text: 'Doosri line.' })));
    await flush();
    await clock.advanceAsync(300);
    expect(await first).toEqual([...fill(400, 1), ...fill(400, 2)]);
    expect(await second).toEqual(fill(400, 3));
    expect(usage.map((meter) => meter.requestId)).toEqual(['rumik:call-1:1', 'rumik:call-1:2']);
    expect(net.mismatches).toEqual([]);
    net.assertComplete();
  });

  it('abort sends cancel, drops the late chunks until cancelled, then the queue moves on', async () => {
    const net = createFixtureNet([
      script([
        ...opening(),
        sent({ text: 'Lambi line jo beech mein kategi.' }),
        binary(fill(320, 1)),
        sent({ type: 'cancel' }),
        binary(fill(320, 9)),
        cancelled(),
        sent({ text: 'Agli line.' }),
        binary(fill(320, 2)),
        frame({ type: 'done', request_id: 'next' }),
      ]),
    ]);
    const usage: UsageMeter[] = [];
    const tts = new RumikTts(net, FIXTURE_KEY, FIXTURE_BINDING);
    const abort = new AbortController();
    const heard: number[] = [];
    let failure: unknown;
    const first = (async () => {
      try {
        for await (const chunk of tts.synthesize(
          ttsInput(usage, { text: 'Lambi line jo beech mein kategi.', signal: abort.signal }),
        )) {
          heard.push(...chunk);
          abort.abort(new DOMException('barge-in', 'AbortError'));
        }
      } catch (error) {
        failure = error;
      }
    })();
    const next = drain(tts.synthesize(ttsInput(usage, { text: 'Agli line.' })));
    await first;
    expect(heard).toEqual(fill(320, 1));
    expect(failure).toMatchObject({ name: 'AbortError' });
    expect(await next).toEqual(fill(320, 2));
    // The cancelled generation is still metered once (its text went out); the next one too.
    expect(usage.map((meter) => meter.requestId)).toEqual(['rumik:call-1:1', 'rumik:call-1:2']);
    net.assertComplete();
  });

  it('a cancel that lost the race to done is not read as the next line being cancelled', async () => {
    const net = createFixtureNet([
      script([
        ...opening(),
        sent({ text: 'Jaldi khatam.' }),
        binary(fill(160, 1)),
        sent({ type: 'cancel' }),
        frame({ type: 'done' }),
        sent({ text: 'Agli line.' }),
        // Rumik answers the late cancel after the next text frame went out (stray).
        cancelled(),
        binary(fill(160, 2)),
        frame({ type: 'done' }),
      ]),
    ]);
    const tts = new RumikTts(net, FIXTURE_KEY, FIXTURE_BINDING);
    const abort = new AbortController();
    const iterator = tts
      .synthesize(ttsInput([], { text: 'Jaldi khatam.', signal: abort.signal }))
      [Symbol.asyncIterator]();
    await iterator.next();
    const next = drain(tts.synthesize(ttsInput([], { text: 'Agli line.' })));
    abort.abort();
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
    expect(await next).toEqual(fill(160, 2));
    net.assertComplete();
  });

  it('a generation aborted while queued never reaches Rumik and is not metered', async () => {
    const clock = new FakeClock();
    const net = createFixtureNet(
      [
        script([
          ...opening(),
          sent({ text: 'Ek.' }),
          binary(fill(160, 1)),
          { delayMs: 100 },
          frame({ type: 'done' }),
          sent({ text: 'Teen.' }),
          binary(fill(160, 3)),
          frame({ type: 'done' }),
        ]),
      ],
      { clock },
    );
    const usage: UsageMeter[] = [];
    const tts = new RumikTts(net, FIXTURE_KEY, FIXTURE_BINDING, clock);
    const skip = new AbortController();
    const one = drain(tts.synthesize(ttsInput(usage, { text: 'Ek.' })));
    const two = settle(tts.synthesize(ttsInput(usage, { text: 'Do.', signal: skip.signal })));
    const three = drain(tts.synthesize(ttsInput(usage, { text: 'Teen.' })));
    await flush();
    skip.abort();
    await clock.advanceAsync(100);
    expect(await one).toEqual(fill(160, 1));
    expect(await two).toMatchObject({ bytes: [], error: { name: 'AbortError' } });
    expect(await three).toEqual(fill(160, 3));
    expect(usage.map((meter) => meter.requestId)).toEqual(['rumik:call-1:1', 'rumik:call-1:3']);
    net.assertComplete();
  });

  it('a recoverable error frame fails that line only; the socket takes the next one', async () => {
    const net = createFixtureNet([
      script([
        ...opening(),
        sent({ text: '...' }),
        frame({ error: true, code: 'INVALID_TEXT', recoverable: true }),
        sent({ text: 'Theek hai.' }),
        binary(fill(160, 4)),
        frame({ type: 'done' }),
      ]),
    ]);
    const usage: UsageMeter[] = [];
    const tts = new RumikTts(net, FIXTURE_KEY, FIXTURE_BINDING);
    const bad = await settle(tts.synthesize(ttsInput(usage, { text: '...' })));
    expect(bad.error).toMatchObject({ code: 'INVALID_TEXT', retryable: false });
    expect(await drain(tts.synthesize(ttsInput(usage, { text: 'Theek hai.' })))).toEqual(
      fill(160, 4),
    );
    // INVALID_TEXT is not charged; the next line is.
    expect(usage.map((meter) => meter.quantity)).toEqual([
      '0',
      String('Theek hai.'.length + FIXTURE_BINDING.description.length),
    ]);
    net.assertComplete();
  });

  it('a fatal error frame before any audio renders that line over HTTP and re-mints after', async () => {
    const text = 'Aapka payment mil gaya.';
    const audio = fixtureAudio(MULAW_8K, text);
    const net = createFixtureNet([
      script([
        ...opening(),
        sent({ text }),
        frame({ error: true, code: 'ENGINE_UNAVAILABLE', recoverable: false }),
        ...mintSteps(MULAW_8K, { token: 'tok-2' }),
        socketOpen('tok-2'),
        ...generationSteps('Dhanyavaad.', MULAW_8K, 2),
      ]),
      httpScript([synthesisStep(text, MULAW_8K, audio)]),
    ]);
    const usage: UsageMeter[] = [];
    const tts = new RumikTts(net, FIXTURE_KEY, FIXTURE_BINDING);
    expect(await drain(tts.synthesize(ttsInput(usage, { text })))).toEqual([...audio]);
    expect(await drain(tts.synthesize(ttsInput(usage, { text: 'Dhanyavaad.' })))).toHaveLength(
      fixtureAudio(MULAW_8K, 'Dhanyavaad.', 2).byteLength,
    );
    expect(usage).toHaveLength(2);
    net.assertComplete();
  });

  it('a socket failure after audio was heard ends the line with a retryable error, no replay', async () => {
    const net = createFixtureNet([
      script([
        ...opening(),
        sent({ text: 'Aadhi line.' }),
        binary(fill(160, 5)),
        { close: { code: 1011, reason: 'internal' } },
      ]),
    ]);
    const usage: UsageMeter[] = [];
    const result = await settle(
      new RumikTts(net, FIXTURE_KEY, FIXTURE_BINDING).synthesize(
        ttsInput(usage, { text: 'Aadhi line.' }),
      ),
    );
    expect(result).toMatchObject({ bytes: fill(160, 5), error: { retryable: true } });
    expect(usage).toHaveLength(1);
    net.assertComplete();
  });

  it('gives up a socket whose cancel is never acknowledged, and mints a new one', async () => {
    const clock = new FakeClock();
    const net = createFixtureNet(
      [
        script([
          ...opening(),
          sent({ text: 'Ruko.' }),
          binary(fill(160, 1)),
          sent({ type: 'cancel' }),
          ...mintSteps(MULAW_8K, { token: 'tok-2' }),
          socketOpen('tok-2'),
          sent({ text: 'Haan ji.' }),
          binary(fill(160, 2)),
          frame({ type: 'done' }),
        ]),
      ],
      { clock },
    );
    const tts = new RumikTts(net, FIXTURE_KEY, FIXTURE_BINDING, clock);
    const abort = new AbortController();
    const iterator = tts
      .synthesize(ttsInput([], { text: 'Ruko.', signal: abort.signal }))
      [Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual(new Uint8Array(fill(160, 1)));
    abort.abort();
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
    const next = drain(tts.synthesize(ttsInput([], { text: 'Haan ji.' })));
    await clock.advanceAsync(CANCEL_ACK_MS - 1);
    expect(net.log.filter((entry) => entry.kind === 'ws-open')).toHaveLength(1);
    await clock.advanceAsync(1);
    expect(await next).toEqual(fill(160, 2));
    net.assertComplete();
  });

  it('re-cuts PCM chunks split mid-sample into whole samples', async () => {
    const net = createFixtureNet([
      script([
        ...mintSteps(PCM16_24K),
        socketOpen(),
        sent({ text: 'Namaste.' }),
        binary([1, 2, 3]),
        binary([4, 5, 6]),
        frame({ type: 'done' }),
        sent({ text: 'Phir se.' }),
        binary([7, 8, 9]),
        frame({ type: 'done' }),
      ]),
    ]);
    const tts = new RumikTts(net, FIXTURE_KEY, FIXTURE_BINDING);
    const chunks: number[] = [];
    for await (const chunk of tts.synthesize(
      ttsInput([], { text: 'Namaste.', format: PCM16_24K }),
    )) {
      expect(chunk.byteLength % 2).toBe(0);
      chunks.push(...chunk);
    }
    expect(chunks).toEqual([1, 2, 3, 4, 5, 6]);
    const odd = await settle(tts.synthesize(ttsInput([], { text: 'Phir se.', format: PCM16_24K })));
    // A stream that ends mid-sample is an error, never a stray byte on the line.
    expect(odd.error).toMatchObject({ message: /incomplete PCM sample/ });
    expect(odd.bytes.length % 2).toBe(0);
    net.assertComplete();
  });

  it('ends the queue at session end: queued lines fail, the running one stops', async () => {
    const net = createFixtureNet([
      script([
        ...opening(),
        sent({ text: 'Chal rahi hai.' }),
        binary(fill(160, 1)),
        sent({ type: 'close' }),
      ]),
    ]);
    const usage: UsageMeter[] = [];
    const tts = new RumikTts(net, FIXTURE_KEY, FIXTURE_BINDING);
    const iterator = tts
      .synthesize(ttsInput(usage, { text: 'Chal rahi hai.' }))
      [Symbol.asyncIterator]();
    await iterator.next();
    const queued = settle(tts.synthesize(ttsInput(usage, { text: 'Kabhi nahi.' })));
    tts.dispose();
    await expect(iterator.next()).rejects.toThrow(/session closed/);
    expect(await queued).toMatchObject({ bytes: [], error: { message: /session closed/ } });
    await flush();
    expect(usage).toHaveLength(1);
    net.assertComplete();
  });
});
