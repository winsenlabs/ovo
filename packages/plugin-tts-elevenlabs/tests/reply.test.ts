import { MULAW_8K, PCM16_16K, type UsageMeter } from '@winsendotai/ovo-contracts';
import { FakeClock } from '@winsendotai/ovo-conformance';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { describe, expect, it } from 'vitest';
import { spokenCount, unspokenText } from '../src/reply-part.ts';
import { socketOpen } from '../src/testing.ts';
import { ElevenLabsTts } from '../src/tts.ts';
import {
  audioFrame,
  drain,
  finalFrame,
  httpScript,
  sent,
  streamStep,
  ttsInput,
  wsScript,
} from './support.ts';

const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64');
const fill = (length: number, value: number) => Array<number>(length).fill(value);
/** An audio frame whose alignment names `chars`, starting at the given ms from the frame start. */
const aligned = (contextId: string, bytes: number[], chars: string, startsMs: number[]) =>
  JSON.stringify({
    audio: b64(bytes),
    contextId,
    alignment: { chars: [...chars], charStartTimesMs: startsMs, charDurationsMs: startsMs },
  });
const outFrames = (net: ReturnType<typeof createFixtureNet>) =>
  net.log
    .filter((entry) => entry.kind === 'ws-out')
    .map((entry) => JSON.parse(String(entry.data)) as Record<string, unknown>);
const live = () => new AbortController().signal;

describe('ElevenLabs reply context (LAT-5)', () => {
  it('renders every segment of a reply in one context and cuts the audio by alignment', async () => {
    const net = createFixtureNet([
      wsScript([
        socketOpen(MULAW_8K),
        sent('ovo-1', {
          text: ' ',
          voice_settings: { stability: 0.5, similarity_boost: 0.8, speed: 1 },
        }),
        sent('ovo-1', { text: 'Hi there. ', flush: true }),
        sent('ovo-1', { text: 'Bye. ', flush: true }),
        // μ-law 8 kHz: 8 bytes per ms. "Hi th" fills frame A.
        { send: aligned('ovo-1', fill(40, 1), 'Hi th', [0, 1, 2, 3, 4]) },
        // "ere." ends segment 1 and "B" starts segment 2 at 5 ms: the frame is cut at byte 40.
        { send: aligned('ovo-1', [...fill(40, 2), ...fill(8, 3)], 'ere. B', [0, 1, 2, 3, 4, 5]) },
        { send: aligned('ovo-1', fill(16, 4), 'ye.', [0, 1, 2]) },
        sent('ovo-1', { close_context: true }),
        { send: finalFrame('ovo-1') },
      ]),
    ]);
    const usage: UsageMeter[] = [];
    const tts = new ElevenLabsTts(net, 'fixture-key');
    const reply = await tts.openReply!(ttsInput(usage));
    const first = reply.segment('Hi there.', live());
    const second = reply.segment('  Bye.', live());
    expect(await drain(first)).toEqual([...fill(40, 1), ...fill(40, 2)]);
    expect(await drain(second)).toEqual([...fill(8, 3), ...fill(16, 4)]);
    await reply.close();
    // One context, metered per segment as each is done, so the last one never waits for close.
    expect(usage).toMatchObject([
      { quantity: '10', state: 'estimated', requestId: 'elevenlabs:call-1:1/1' },
      { quantity: '5', state: 'estimated', requestId: 'elevenlabs:call-1:1/2' },
    ]);
    expect(outFrames(net).filter((frame) => frame.voice_settings)).toHaveLength(1);
    net.assertComplete();
  });

  it('cuts PCM16 audio on whole samples', async () => {
    const net = createFixtureNet([
      wsScript([
        socketOpen(PCM16_16K),
        sent('ovo-1', { text: ' ' }),
        sent('ovo-1', { text: 'Ab. ', flush: true }),
        sent('ovo-1', { text: 'Cd. ', flush: true }),
        // PCM16 16 kHz: 32 bytes per ms; "C" at 0.53 ms rounds to sample 8 (byte 16), never 17.
        { send: aligned('ovo-1', fill(40, 1), 'Ab. Cd', [0, 0.1, 0.2, 0.3, 0.53, 0.8]) },
        sent('ovo-1', { close_context: true }),
      ]),
    ]);
    const tts = new ElevenLabsTts(net, 'fixture-key');
    const reply = await tts.openReply!(ttsInput([], { format: PCM16_16K }));
    const first = reply.segment('Ab.', live());
    const second = reply.segment('Cd.', live());
    expect(await drain(first)).toHaveLength(16);
    expect(await drain(second)).toHaveLength(24);
    await reply.close();
    net.assertComplete();
  });

  it('a barge-in closes only the reply context, and its late audio is dropped', async () => {
    const net = createFixtureNet([
      wsScript([
        socketOpen(MULAW_8K),
        sent('ovo-1', { text: ' ' }),
        sent('ovo-1', { text: 'A long answer. ', flush: true }),
        { send: aligned('ovo-1', [1], 'A', [0]) },
        sent('ovo-1', { close_context: true }),
        { send: aligned('ovo-1', [2], ' lo', [0, 0, 0]) },
        { send: finalFrame('ovo-1') },
        sent('ovo-2', { text: ' ' }),
        sent('ovo-2', { text: 'Sorry, go ahead. ', flush: true }),
        { send: aligned('ovo-2', [9], 'Sorry, go ahead.', fill(16, 0)) },
        sent('ovo-2', { close_context: true }),
      ]),
    ]);
    const tts = new ElevenLabsTts(net, 'fixture-key');
    const turn = new AbortController();
    const reply = await tts.openReply!(ttsInput([], { signal: turn.signal }));
    const iterator = reply.segment('A long answer.', live())[Symbol.asyncIterator]();
    expect([...(await iterator.next()).value!]).toEqual([1]);
    turn.abort(new DOMException('caller spoke', 'AbortError'));
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    const next = await tts.openReply!(ttsInput());
    expect(await drain(next.segment('Sorry, go ahead.', live()))).toEqual([9]);
    await next.close();
    expect(net.log.filter((entry) => entry.kind === 'ws-open')).toHaveLength(1);
    net.assertComplete();
  });

  it('drops one segment the consumer abandons and keeps routing the next', async () => {
    const net = createFixtureNet([
      wsScript([
        socketOpen(MULAW_8K),
        sent('ovo-1', { text: ' ' }),
        sent('ovo-1', { text: 'One. ', flush: true }),
        sent('ovo-1', { text: 'Two. ', flush: true }),
        { send: aligned('ovo-1', [1, 1, 2, 2], 'One.Tw', [0, 0, 0, 0, 0.25, 0.4]) },
        { send: aligned('ovo-1', [2], 'o', [0]) },
        sent('ovo-1', { close_context: true }),
      ]),
    ]);
    const tts = new ElevenLabsTts(net, 'fixture-key');
    const reply = await tts.openReply!(ttsInput());
    const skip = new AbortController();
    skip.abort(new DOMException('segment cancelled', 'AbortError'));
    const first = reply.segment('One.', skip.signal);
    const second = reply.segment('Two.', live());
    await expect(drain(first)).rejects.toMatchObject({ name: 'AbortError' });
    expect(await drain(second)).toEqual([2, 2, 2]);
    await reply.close();
    net.assertComplete();
  });

  it('replays the unheard rest over HTTP when the socket drops mid-reply', async () => {
    const net = createFixtureNet([
      wsScript([
        socketOpen(MULAW_8K),
        sent('ovo-1', { text: ' ' }),
        sent('ovo-1', { text: 'Your EMI is due on the fifth. ', flush: true }),
        sent('ovo-1', { text: 'Pay online. ', flush: true }),
        { send: aligned('ovo-1', [1, 1], 'Your EMI i', fill(10, 0)) },
        { close: { code: 1011, reason: 'internal error' } },
      ]),
      httpScript([
        // "Your EMI i" was heard up to the "i" of "is": the rest of that word is replayed.
        streamStep({ status: 200, chunks: [b64([5])] }, MULAW_8K, {
          text: 'is due on the fifth.',
        }),
        streamStep({ status: 200, chunks: [b64([6])] }, MULAW_8K, { text: 'Pay online.' }),
      ]),
    ]);
    const usage: UsageMeter[] = [];
    const tts = new ElevenLabsTts(net, 'fixture-key');
    const reply = await tts.openReply!(ttsInput(usage));
    const first = reply.segment('Your EMI is due on the fifth.', live());
    const second = reply.segment('Pay online.', live());
    expect(await drain(first)).toEqual([1, 1, 5]);
    expect(await drain(second)).toEqual([6]);
    await reply.close();
    // Segment 2 was never heard on the socket, so only its HTTP request is billed.
    expect(usage.map((meter) => [meter.requestId, meter.quantity])).toEqual([
      ['elevenlabs:call-1:2', '20'],
      ['elevenlabs:call-1:1/1', '30'],
      ['elevenlabs:call-1:3', '11'],
    ]);
    net.assertComplete();
  });

  it('fails the reply on a refusal (policy close) instead of replaying it', async () => {
    const net = createFixtureNet([
      wsScript([
        socketOpen(MULAW_8K),
        sent('ovo-1', { text: ' ' }),
        sent('ovo-1', { text: 'Hi. ', flush: true }),
        { close: { code: 1008, reason: 'quota exceeded' } },
      ]),
    ]);
    const tts = new ElevenLabsTts(net, 'fixture-key');
    const reply = await tts.openReply!(ttsInput());
    await expect(drain(reply.segment('Hi.', live()))).rejects.toMatchObject({ status: 1008 });
    await expect(drain(reply.segment('Again.', live()))).rejects.toMatchObject({ status: 1008 });
    await reply.close();
    net.assertComplete();
  });

  it('ends segments after a quiet gap when frames carry no alignment', async () => {
    const clock = new FakeClock();
    const net = createFixtureNet(
      [
        wsScript([
          socketOpen(MULAW_8K),
          sent('ovo-1', { text: ' ' }),
          sent('ovo-1', { text: 'One. ', flush: true }),
          sent('ovo-1', { text: 'Two. ', flush: true }),
          { send: audioFrame('ovo-1', [1, 2]) },
          { send: audioFrame('ovo-1', [3]) },
          sent('ovo-1', { close_context: true }),
        ]),
      ],
      { clock },
    );
    const tts = new ElevenLabsTts(net, 'fixture-key', {}, clock);
    const reply = await tts.openReply!(ttsInput());
    const first = drain(reply.segment('One.', live()));
    const second = drain(reply.segment('Two.', live()));
    await clock.advanceAsync(599);
    let settled = false;
    void first.then(() => (settled = true));
    await clock.advanceAsync(0);
    expect(settled).toBe(false);
    await clock.advanceAsync(1);
    // Without alignment every byte stays with the oldest segment; nothing is lost or reordered.
    expect(await first).toEqual([1, 2, 3]);
    expect(await second).toEqual([]);
    await reply.close();
    net.assertComplete();
  });

  it('ends exactly the flushed segment on an isFinal per flush (if the provider sends one)', async () => {
    const net = createFixtureNet([
      wsScript([
        socketOpen(MULAW_8K),
        sent('ovo-1', { text: ' ' }),
        sent('ovo-1', { text: 'One. ', flush: true }),
        sent('ovo-1', { text: 'Two. ', flush: true }),
        { send: audioFrame('ovo-1', [1, 2]) },
        { send: finalFrame('ovo-1') },
        { send: audioFrame('ovo-1', [3]) },
        { send: finalFrame('ovo-1') },
        sent('ovo-1', { close_context: true }),
      ]),
    ]);
    const tts = new ElevenLabsTts(net, 'fixture-key');
    const reply = await tts.openReply!(ttsInput());
    const first = reply.segment('One.', live());
    const second = reply.segment('Two.', live());
    // No alignment and no quiet wait: each isFinal is that flush's end.
    expect(await drain(first)).toEqual([1, 2]);
    expect(await drain(second)).toEqual([3]);
    await reply.close();
    net.assertComplete();
  });

  it('renders a reply segment by segment over HTTP when the binding says so', async () => {
    const net = createFixtureNet([
      httpScript([
        streamStep({ status: 200, chunks: [b64([1])] }, MULAW_8K, { text: 'One.' }),
        streamStep({ status: 200, chunks: [b64([2])] }, MULAW_8K, { text: 'Two.' }),
      ]),
    ]);
    const usage: UsageMeter[] = [];
    const tts = new ElevenLabsTts(net, 'fixture-key', { transport: 'http' });
    const reply = await tts.openReply!(ttsInput(usage));
    const first = reply.segment('One.', live());
    const second = reply.segment('Two.', live());
    expect(await drain(second)).toEqual([2]);
    expect(await drain(first)).toEqual([1]);
    await reply.close();
    expect(usage.map((meter) => meter.requestId)).toEqual([
      'elevenlabs:call-1:2',
      'elevenlabs:call-1:3',
    ]);
    net.assertComplete();
  });

  it('is absent when the binding turns reply contexts off', () => {
    expect(new ElevenLabsTts(createFixtureNet([]), 'k', { replyStream: false }).openReply).toBe(
      undefined,
    );
    expect(new ElevenLabsTts(createFixtureNet([]), 'k').openReply).toBeTypeOf('function');
  });

  it('counts spoken characters and finds the unheard rest of a segment', () => {
    expect(spokenCount('Rs. 4,850 — नमस्ते!')).toBe(2 + 4 + 6);
    expect(unspokenText('Your EMI is due.', 0)).toBe('Your EMI is due.');
    expect(unspokenText('Your EMI is due.', 6)).toBe('EMI is due.');
    expect(unspokenText('Your EMI is due.', 7)).toBe('is due.');
    expect(unspokenText('Your EMI is due.', 8)).toBe('is due.');
    expect(unspokenText('Your EMI is due.', 12)).toBe('');
  });
});

describe('ElevenLabs open() replay (Wave 2 review note)', () => {
  it('replays an incremental utterance over HTTP when the socket drops before audio', async () => {
    const net = createFixtureNet([
      wsScript([
        socketOpen(MULAW_8K),
        sent('ovo-1', { text: 'Your EMI ' }),
        { close: { code: 1011, reason: 'internal error' } },
      ]),
      httpScript([
        streamStep({ status: 200, chunks: [b64([4, 2])] }, MULAW_8K, {
          text: 'Your EMI is due.',
        }),
      ]),
    ]);
    const usage: UsageMeter[] = [];
    const tts = new ElevenLabsTts(net, 'fixture-key');
    const context = await tts.open(ttsInput(usage));
    context.push('Your EMI ');
    await new Promise((resolve) => setImmediate(resolve));
    // The socket is gone: the rest of the text is still taken, then replayed in one request.
    context.push('is due.');
    context.flush();
    expect(await drain(context.audio)).toEqual([4, 2]);
    await context.close();
    expect(usage.map((meter) => meter.requestId)).toEqual(['elevenlabs:call-1:2']);
    net.assertComplete();
  });

  it('keeps the error after the first byte (no duplicate audio)', async () => {
    const net = createFixtureNet([
      wsScript([
        socketOpen(MULAW_8K),
        sent('ovo-1', { text: 'Hello.' }),
        sent('ovo-1', { text: '', flush: true }),
        sent('ovo-1', { close_context: true }),
        { send: audioFrame('ovo-1', [1]) },
        { close: { code: 1011, reason: 'internal error' } },
      ]),
    ]);
    const usage: UsageMeter[] = [];
    const tts = new ElevenLabsTts(net, 'fixture-key');
    const context = await tts.open(ttsInput(usage));
    context.push('Hello.');
    context.flush();
    const heard: number[] = [];
    await expect(
      (async () => {
        for await (const chunk of context.audio) heard.push(...chunk);
      })(),
    ).rejects.toMatchObject({ status: 1011 });
    await context.close();
    expect(heard).toEqual([1]);
    expect(usage).toMatchObject([{ quantity: '6', requestId: 'elevenlabs:call-1:1' }]);
    net.assertComplete();
  });
});
