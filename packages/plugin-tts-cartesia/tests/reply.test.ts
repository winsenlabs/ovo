import { FakeClock } from '@winsendotai/ovo-conformance';
import {
  MULAW_8K,
  PCM16_16K,
  PCM16_24K,
  PCM16_8K,
  type NetFixtureStep,
  type UsageMeter,
} from '@winsendotai/ovo-contracts';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { describe, expect, it } from 'vitest';
import { CartesiaTts } from '../src/tts.ts';
import {
  errorEvent,
  flushDoneEvent,
  replyBargeIn,
  sent,
  socketOpen,
  sonicAudio,
} from '../src/testing.ts';
import { VOICE, chunk, drain, input, settle, wsScript } from './support.ts';

/** One segment's two client frames on `contextId`. */
const segment = (contextId: string, text: string): NetFixtureStep[] => [
  sent(contextId, MULAW_8K, { transcript: `${text} `, continue: true }),
  sent(contextId, MULAW_8K, { transcript: '', continue: true, flush: true }),
];
const live = () => new AbortController().signal;

describe('Cartesia TTS reply (C3)', () => {
  it('ends each segment at its flush_done and meters each segment once', async () => {
    const net = createFixtureNet([
      wsScript([
        socketOpen(),
        ...segment('ovo-1', 'One.'),
        ...segment('ovo-1', 'Two.'),
        { send: chunk('ovo-1', [1]) },
        { send: chunk('ovo-1', [2]) },
        { send: flushDoneEvent('ovo-1', 1) },
        { send: chunk('ovo-1', [3]) },
        { send: flushDoneEvent('ovo-1', 2) },
      ]),
    ]);
    const usage: UsageMeter[] = [];
    const tts = new CartesiaTts(net, 'fixture-key', { voiceId: VOICE });
    const reply = await tts.openReply(input(usage));
    const one = reply.segment('One.', live());
    const two = reply.segment('Two.', live());
    // Punctuation alone renders nothing: it never goes out and its iterable just ends.
    expect(await drain(reply.segment(' ... ', live()))).toEqual([]);
    expect(await drain(one)).toEqual([1, 2]);
    expect(await drain(two)).toEqual([3]);
    await reply.close();
    expect(usage.map((meter) => [meter.requestId, meter.quantity])).toEqual([
      ['cartesia:call-1:1/1', '5'],
      ['cartesia:call-1:1/2', '5'],
    ]);
    net.assertComplete();
  });

  it('barge-in cancels the context and discards the chunk that was still generating', async () => {
    const net = createFixtureNet([
      wsScript([
        socketOpen(),
        ...segment('ovo-1', 'A long first sentence.'),
        ...segment('ovo-1', 'And a second.'),
        { send: chunk('ovo-1', [1]) },
        { expect: 'ws-send', match: 'json', where: { context_id: 'ovo-1', cancel: true } },
        { send: chunk('ovo-1', [9]) },
        { send: flushDoneEvent('ovo-1', 1) },
      ]),
    ]);
    const usage: UsageMeter[] = [];
    const tts = new CartesiaTts(net, 'fixture-key', { voiceId: VOICE });
    const reply = await tts.openReply(input(usage));
    const first = reply.segment('A long first sentence.', live())[Symbol.asyncIterator]();
    const second = reply.segment('And a second.', live());
    expect(Array.from((await first.next()).value as Uint8Array)).toEqual([1]);
    await reply.close();
    await settle();
    expect((await first.next()).done).toBe(true);
    expect(await drain(second)).toEqual([]);
    expect(usage.map((meter) => meter.requestId)).toEqual([
      'cartesia:call-1:1/1',
      'cartesia:call-1:1/2',
    ]);
    expect(() => reply.segment('Too late.', live())).toThrow(/closed/);
    net.assertComplete();
  });

  it('drops the late chunk after a barge-in in every native format (fixture template)', async () => {
    const texts = ['Your EMI is due on the fifth.', 'Shall I send a link?'] as const;
    for (const format of [MULAW_8K, PCM16_8K, PCM16_16K, PCM16_24K]) {
      const net = createFixtureNet(replyBargeIn(format, texts));
      const usage: UsageMeter[] = [];
      const tts = new CartesiaTts(net, 'fixture-key', { voiceId: VOICE });
      const reply = await tts.openReply(input(usage, { format }));
      const first = reply.segment(texts[0], live())[Symbol.asyncIterator]();
      const second = reply.segment(texts[1], live());
      const head = (await first.next()).value as Uint8Array;
      await reply.close();
      await settle();
      const rest = await drain({ [Symbol.asyncIterator]: () => first });
      expect(await drain(second)).toEqual([]);
      // Whole samples of the first half only: nothing of the late half reached the caller.
      const total = sonicAudio(format, texts[0]).byteLength;
      expect(head.byteLength + rest.length).toBeLessThan(total / 2 + 2);
      expect(head.byteLength % (format.encoding === 'pcm_s16le' ? 2 : 1)).toBe(0);
      expect(new Set(usage.map((meter) => meter.requestId)).size).toBe(usage.length);
      net.assertComplete();
    }
  });

  it('reuses the context within 800 ms of quiet and opens a fresh id after it', async () => {
    const clock = new FakeClock();
    const net = createFixtureNet(
      [
        wsScript([
          socketOpen(),
          ...segment('ovo-1', 'First.'),
          { send: chunk('ovo-1', [1]) },
          { send: flushDoneEvent('ovo-1', 1) },
          ...segment('ovo-1', 'Second.'),
          { send: chunk('ovo-1', [2]) },
          { send: flushDoneEvent('ovo-1', 2) },
          ...segment('ovo-1-2', 'Third.'),
          { send: chunk('ovo-1-2', [3]) },
          { send: flushDoneEvent('ovo-1-2', 1) },
        ]),
      ],
      { clock },
    );
    const tts = new CartesiaTts(net, 'fixture-key', { voiceId: VOICE }, clock);
    const reply = await tts.openReply(input());
    expect(await drain(reply.segment('First.', live()))).toEqual([1]);
    clock.advance(800);
    expect(await drain(reply.segment('Second.', live()))).toEqual([2]);
    clock.advance(801);
    expect(await drain(reply.segment('Third.', live()))).toEqual([3]);
    await reply.close();
    net.assertComplete();
  });

  it('an aborted segment drops its own audio and the reply goes on', async () => {
    const net = createFixtureNet([
      wsScript([
        socketOpen(),
        ...segment('ovo-1', 'Skip me.'),
        ...segment('ovo-1', 'Keep me.'),
        { send: chunk('ovo-1', [1]) },
        { send: flushDoneEvent('ovo-1', 1) },
        { send: chunk('ovo-1', [2]) },
        { send: flushDoneEvent('ovo-1', 2) },
      ]),
    ]);
    const tts = new CartesiaTts(net, 'fixture-key', { voiceId: VOICE });
    const reply = await tts.openReply(input());
    const skip = new AbortController();
    const skipped = reply.segment('Skip me.', skip.signal);
    const kept = reply.segment('Keep me.', live());
    skip.abort();
    await expect(drain(skipped)).rejects.toMatchObject({ name: 'AbortError' });
    expect(await drain(kept)).toEqual([2]);
    await reply.close();
    net.assertComplete();
  });

  it('a 429 before any audio resends the unheard segments on a fresh context after 250 ms', async () => {
    const clock = new FakeClock();
    const net = createFixtureNet(
      [
        wsScript([
          socketOpen(),
          ...segment('ovo-1', 'Hello there.'),
          { send: errorEvent('ovo-1', 429, 'concurrency_limited') },
          ...segment('ovo-1-2', 'Hello there.'),
          { send: chunk('ovo-1-2', [6]) },
          { send: flushDoneEvent('ovo-1-2', 1) },
        ]),
      ],
      { clock },
    );
    const usage: UsageMeter[] = [];
    const tts = new CartesiaTts(net, 'fixture-key', { voiceId: VOICE }, clock);
    const reply = await tts.openReply(input(usage));
    let heard: number[] | undefined;
    void drain(reply.segment('Hello there.', live())).then((bytes) => (heard = bytes));
    await settle();
    clock.advance(249);
    await settle();
    expect(heard).toBeUndefined();
    clock.advance(1);
    await settle();
    expect(heard).toEqual([6]);
    expect(usage).toEqual([
      expect.objectContaining({ requestId: 'cartesia:call-1:1/1', quantity: '13' }),
    ]);
    await reply.close();
    net.assertComplete();
  });

  it('a socket drop between segments reconnects for the next one, nothing repeated', async () => {
    const net = createFixtureNet([
      wsScript([
        socketOpen(),
        ...segment('ovo-1', 'One.'),
        { send: chunk('ovo-1', [1]) },
        { send: flushDoneEvent('ovo-1', 1) },
        { close: { code: 1006 } },
      ]),
      wsScript([
        socketOpen(),
        ...segment('ovo-1-2', 'Two.'),
        { send: chunk('ovo-1-2', [2]) },
        { send: flushDoneEvent('ovo-1-2', 1) },
      ]),
    ]);
    const usage: UsageMeter[] = [];
    const tts = new CartesiaTts(net, 'fixture-key', { voiceId: VOICE });
    const reply = await tts.openReply(input(usage));
    expect(await drain(reply.segment('One.', live()))).toEqual([1]);
    await settle();
    expect(await drain(reply.segment('Two.', live()))).toEqual([2]);
    await reply.close();
    expect(usage.map((meter) => [meter.requestId, meter.quantity])).toEqual([
      ['cartesia:call-1:1/1', '5'],
      ['cartesia:call-1:1/2', '5'],
    ]);
    net.assertComplete();
  });

  it('a 429 on the second segment after the first played resends only the second', async () => {
    const clock = new FakeClock();
    const net = createFixtureNet(
      [
        wsScript([
          socketOpen(),
          ...segment('ovo-1', 'One.'),
          { send: chunk('ovo-1', [1]) },
          { send: flushDoneEvent('ovo-1', 1) },
          ...segment('ovo-1', 'Two.'),
          { send: errorEvent('ovo-1', 429, 'concurrency_limited') },
          ...segment('ovo-1-2', 'Two.'),
          { send: chunk('ovo-1-2', [2]) },
          { send: flushDoneEvent('ovo-1-2', 1) },
        ]),
      ],
      { clock },
    );
    const tts = new CartesiaTts(net, 'fixture-key', { voiceId: VOICE }, clock);
    const reply = await tts.openReply(input());
    expect(await drain(reply.segment('One.', live()))).toEqual([1]);
    let heard: number[] | undefined;
    void drain(reply.segment('Two.', live())).then((bytes) => (heard = bytes));
    await settle();
    expect(heard).toBeUndefined();
    clock.advance(250);
    await settle();
    expect(heard).toEqual([2]);
    await reply.close();
    net.assertComplete();
  });

  it('a drop after a segment was partly heard fails the reply rather than repeat its words', async () => {
    const net = createFixtureNet([
      wsScript([
        socketOpen(),
        ...segment('ovo-1', 'One.'),
        { send: chunk('ovo-1', [1]) },
        { close: { code: 1006 } },
      ]),
    ]);
    const tts = new CartesiaTts(net, 'fixture-key', { voiceId: VOICE });
    const reply = await tts.openReply(input());
    await expect(drain(reply.segment('One.', live()))).rejects.toThrow(/1006/);
    await expect(drain(reply.segment('Two.', live()))).rejects.toThrow(/1006/);
    await reply.close();
    net.assertComplete();
  });

  it('a final refusal fails the open segments and every later one', async () => {
    const net = createFixtureNet([
      wsScript([
        socketOpen(),
        ...segment('ovo-1', 'Hello.'),
        { send: errorEvent('ovo-1', 402, 'quota_exceeded', 'Quota exceeded') },
      ]),
    ]);
    const usage: UsageMeter[] = [];
    const tts = new CartesiaTts(net, 'fixture-key', { voiceId: VOICE });
    const reply = await tts.openReply(input(usage));
    await expect(drain(reply.segment('Hello.', live()))).rejects.toMatchObject({
      code: 'quota_exceeded',
    });
    await expect(drain(reply.segment('Again.', live()))).rejects.toMatchObject({
      code: 'quota_exceeded',
    });
    await reply.close();
    expect(usage).toEqual([expect.objectContaining({ quantity: '0' })]);
    net.assertComplete();
  });
});
