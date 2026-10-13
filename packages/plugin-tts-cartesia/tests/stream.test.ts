import { FakeClock } from '@winsendotai/ovo-conformance';
import {
  PCM16_8K,
  type NetPort,
  type UsageMeter,
  type WebSocketLike,
} from '@winsendotai/ovo-contracts';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { describe, expect, it } from 'vitest';
import { CartesiaTts } from '../src/tts.ts';
import { doneEvent, errorEvent, sent, socketOpen } from '../src/testing.ts';
import { VOICE, chunk, drain, input, said, settle, wsScript } from './support.ts';

const opens = (net: ReturnType<typeof createFixtureNet>) =>
  net.log.filter((entry) => entry.kind === 'ws-open').length;
const cancel = (contextId: string) =>
  ({ expect: 'ws-send', match: 'json', where: { context_id: contextId, cancel: true } }) as const;

/** A socket that never opens: the handshake hangs until the connect deadline. */
function hangingNet(): NetPort & { closed: number[] } {
  const closed: number[] = [];
  return {
    closed,
    fetch: () => Promise.reject(new Error('no http')),
    websocket(): WebSocketLike {
      return {
        readyState: 0,
        send() {
          throw new Error('not open');
        },
        close(code) {
          closed.push(code ?? 1005);
        },
        on: () => () => undefined,
      } as WebSocketLike;
    },
  };
}

describe('Cartesia TTS connection (C2)', () => {
  it('pools one socket per session with X-API-Key and numbers contexts ovo-1, ovo-2', async () => {
    const net = createFixtureNet([
      wsScript([
        socketOpen(),
        ...said('ovo-1', 'Hello. '),
        { send: chunk('ovo-1', [1, 2]) },
        { send: doneEvent('ovo-1') },
        ...said('ovo-2', 'Bye. '),
        { send: chunk('ovo-2', [3]) },
        { send: doneEvent('ovo-2') },
      ]),
    ]);
    const usage: UsageMeter[] = [];
    const tts = new CartesiaTts(net, 'fixture-key', { voiceId: VOICE });
    expect(await drain(tts.synthesize({ ...input(usage), text: 'Hello. ' }))).toEqual([1, 2]);
    expect(await drain(tts.synthesize({ ...input(usage), text: 'Bye. ' }))).toEqual([3]);
    expect(opens(net)).toBe(1);
    expect(usage.map((meter) => [meter.requestId, meter.quantity, meter.state])).toEqual([
      ['cartesia:call-1:1', '7', 'estimated'],
      ['cartesia:call-1:2', '5', 'estimated'],
    ]);
    net.assertComplete();
  });

  it('reopens lazily after the provider closes an idle socket', async () => {
    const clock = new FakeClock();
    const net = createFixtureNet(
      [
        wsScript([
          socketOpen(),
          ...said('ovo-1', 'One. '),
          { send: chunk('ovo-1', [1]) },
          { send: doneEvent('ovo-1') },
          { delayMs: 300_000 },
          { close: { code: 1000, reason: 'idle timeout' } },
        ]),
        wsScript([
          socketOpen(),
          ...said('ovo-2', 'Two. '),
          { send: chunk('ovo-2', [2]) },
          { send: doneEvent('ovo-2') },
        ]),
      ],
      { clock },
    );
    const tts = new CartesiaTts(net, 'fixture-key', { voiceId: VOICE }, clock);
    expect(await drain(tts.synthesize({ ...input(), text: 'One. ' }))).toEqual([1]);
    clock.advance(300_000);
    await settle();
    expect(await drain(tts.synthesize({ ...input(), text: 'Two. ' }))).toEqual([2]);
    expect(opens(net)).toBe(2);
    net.assertComplete();
  });

  it('warm() opens the socket the first utterance then uses, and never rejects', async () => {
    const net = createFixtureNet([
      wsScript([
        socketOpen(),
        ...said('ovo-1', 'Hi. '),
        { send: chunk('ovo-1', [7]) },
        { send: doneEvent('ovo-1') },
      ]),
    ]);
    const tts = new CartesiaTts(net, 'fixture-key', { voiceId: VOICE });
    await tts.warm({ format: input().format });
    expect(opens(net)).toBe(1);
    expect(await drain(tts.synthesize({ ...input(), text: 'Hi. ' }))).toEqual([7]);
    expect(opens(net)).toBe(1);
    await expect(
      new CartesiaTts(createFixtureNet([]), 'k', { voiceId: VOICE }).warm({ format: PCM16_8K }),
    ).resolves.toBeUndefined();
  });

  it('warm() gives up at the connect deadline and closes the hanging socket', async () => {
    const clock = new FakeClock();
    const net = hangingNet();
    const tts = new CartesiaTts(net, 'k', { voiceId: VOICE, connectTimeoutMs: 1500 }, clock);
    let warmed = false;
    void tts.warm({ format: input().format }).then(() => (warmed = true));
    await settle();
    expect(warmed).toBe(false);
    clock.advance(1500);
    await settle();
    expect(warmed).toBe(true);
    expect(net.closed).toHaveLength(1);
  });

  it('holds at most maxContexts contexts per session; a waiter can abort', async () => {
    const net = createFixtureNet([
      wsScript([
        socketOpen(),
        ...said('ovo-1', 'First. '),
        { send: chunk('ovo-1', [1]) },
        { send: doneEvent('ovo-1') },
        ...said('ovo-2', 'Second. '),
        { send: chunk('ovo-2', [2]) },
        { send: doneEvent('ovo-2') },
      ]),
    ]);
    const tts = new CartesiaTts(net, 'fixture-key', { voiceId: VOICE, maxContexts: 1 });
    const first = await tts.open(input());
    let second: Awaited<ReturnType<typeof tts.open>> | undefined;
    const waiting = tts.open(input()).then((stream) => (second = stream));
    const gone = new AbortController();
    const aborted = tts.open(input([], { signal: gone.signal }));
    await settle();
    expect(second).toBeUndefined();
    gone.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    first.push('First. ');
    first.flush();
    expect(await drain(first.audio)).toEqual([1]);
    await first.close();
    await waiting;
    second!.push('Second. ');
    second!.flush();
    expect(await drain(second!.audio)).toEqual([2]);
    await second!.close();
    net.assertComplete();
  });
});

describe('Cartesia TTS retries before the first audio (C2)', () => {
  it('pauses 250 ms after a 429 and replays the text on a fresh context id', async () => {
    const clock = new FakeClock();
    const net = createFixtureNet(
      [
        wsScript([
          socketOpen(),
          ...said('ovo-1', 'Hello '),
          { send: errorEvent('ovo-1', 429, 'concurrency_limited', 'Too many concurrent requests') },
          ...said('ovo-1-r1', 'Hello '),
          { send: chunk('ovo-1-r1', [5]) },
          { send: doneEvent('ovo-1-r1') },
        ]),
      ],
      { clock },
    );
    const usage: UsageMeter[] = [];
    const tts = new CartesiaTts(net, 'fixture-key', { voiceId: VOICE }, clock);
    let heard: number[] | undefined;
    void drain(tts.synthesize({ ...input(usage), text: 'Hello ' })).then(
      (bytes) => (heard = bytes),
    );
    await settle();
    clock.advance(249);
    await settle();
    expect(net.log.some((entry) => String(entry.data).includes('ovo-1-r1'))).toBe(false);
    clock.advance(1);
    await settle();
    expect(heard).toEqual([5]);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ quantity: '6', requestId: 'cartesia:call-1:1' });
    net.assertComplete();
  });

  it('gives up after two retries (250 then 750 ms) and meters a refused context at zero', async () => {
    const clock = new FakeClock();
    const net = createFixtureNet(
      [
        wsScript([
          socketOpen(),
          ...said('ovo-1', 'Hi '),
          { send: errorEvent('ovo-1', 429, 'concurrency_limited') },
          ...said('ovo-1-r1', 'Hi '),
          { send: errorEvent('ovo-1-r1', 503, null, 'Service unavailable') },
          ...said('ovo-1-r2', 'Hi '),
          { send: errorEvent('ovo-1-r2', 500, null, 'Unexpected error') },
        ]),
      ],
      { clock },
    );
    const usage: UsageMeter[] = [];
    const tts = new CartesiaTts(net, 'fixture-key', { voiceId: VOICE }, clock);
    let failure: unknown;
    void drain(tts.synthesize({ ...input(usage), text: 'Hi ' })).catch(
      (error) => (failure = error),
    );
    await settle();
    clock.advance(250);
    await settle();
    clock.advance(749);
    await settle();
    expect(failure).toBeUndefined();
    clock.advance(1);
    await settle();
    expect(failure).toMatchObject({ name: 'CartesiaTtsError', status: 500, retryable: true });
    expect(usage).toEqual([expect.objectContaining({ quantity: '0' })]);
    net.assertComplete();
  });

  it('never retries a final refusal or a failure after audio was heard', async () => {
    const net = createFixtureNet([
      wsScript([
        socketOpen(),
        ...said('ovo-1', 'Who? '),
        { send: errorEvent('ovo-1', 404, 'voice_not_found', 'Voice not found') },
        ...said('ovo-2', 'Then this. '),
        { send: chunk('ovo-2', [1]) },
        { send: errorEvent('ovo-2', 500, null) },
      ]),
    ]);
    const usage: UsageMeter[] = [];
    const tts = new CartesiaTts(net, 'fixture-key', { voiceId: VOICE });
    await expect(drain(tts.synthesize({ ...input(usage), text: 'Who? ' }))).rejects.toMatchObject({
      code: 'voice_not_found',
      retryable: false,
    });
    const heard: number[] = [];
    await expect(
      (async () => {
        for await (const piece of tts.synthesize({ ...input(usage), text: 'Then this. ' }))
          heard.push(...piece);
      })(),
    ).rejects.toMatchObject({ status: 500 });
    expect(heard).toEqual([1]);
    expect(usage.map((meter) => meter.quantity)).toEqual(['0', '11']);
    net.assertComplete();
  });

  it('reconnects when the whole socket fails before audio', async () => {
    const clock = new FakeClock();
    const net = createFixtureNet(
      [
        wsScript([
          socketOpen(),
          ...said('ovo-1', 'Again '),
          { close: { code: 1011, reason: 'internal' } },
        ]),
        wsScript([
          socketOpen(),
          ...said('ovo-1-r1', 'Again '),
          { send: chunk('ovo-1-r1', [4]) },
          { send: doneEvent('ovo-1-r1') },
        ]),
      ],
      { clock },
    );
    const tts = new CartesiaTts(net, 'fixture-key', { voiceId: VOICE }, clock);
    let heard: number[] | undefined;
    void drain(tts.synthesize({ ...input(), text: 'Again ' })).then((bytes) => (heard = bytes));
    await settle();
    clock.advance(250);
    await settle();
    expect(heard).toEqual([4]);
    expect(opens(net)).toBe(2);
    net.assertComplete();
  });
});

describe('Cartesia TTS contexts (C3)', () => {
  it('barge-in sends cancel and drops the chunks still generating for that context', async () => {
    const net = createFixtureNet([
      wsScript([
        socketOpen(),
        sent('ovo-1', input().format, { transcript: 'A long sentence. ', continue: true }),
        sent('ovo-1', input().format, { transcript: '', continue: false }),
        { send: chunk('ovo-1', [1]) },
        cancel('ovo-1'),
        { send: chunk('ovo-1', [9, 9]) },
        { send: doneEvent('ovo-1') },
        ...said('ovo-2', 'Next. '),
        { send: chunk('ovo-2', [2]) },
        { send: doneEvent('ovo-2') },
      ]),
    ]);
    const usage: UsageMeter[] = [];
    const tts = new CartesiaTts(net, 'fixture-key', { voiceId: VOICE });
    const stream = await tts.open(input(usage));
    stream.push('A long sentence. ');
    stream.flush();
    const reader = stream.audio[Symbol.asyncIterator]();
    expect(Array.from((await reader.next()).value as Uint8Array)).toEqual([1]);
    await stream.close();
    await settle();
    expect((await reader.next()).done).toBe(true);
    expect(await drain(tts.synthesize({ ...input(usage), text: 'Next. ' }))).toEqual([2]);
    expect(usage.map((meter) => meter.quantity)).toEqual(['17', '6']);
    net.assertComplete();
  });

  it('re-cuts PCM16 chunks split on odd bytes into whole samples', async () => {
    const net = createFixtureNet([
      wsScript([
        socketOpen(),
        ...said('ovo-1', 'Hi. ', PCM16_8K),
        { send: chunk('ovo-1', [1, 2, 3]) },
        { send: chunk('ovo-1', [4, 5, 6, 7]) },
        { send: chunk('ovo-1', [8]) },
        { send: doneEvent('ovo-1') },
      ]),
    ]);
    const tts = new CartesiaTts(net, 'fixture-key', { voiceId: VOICE });
    const pieces: number[][] = [];
    for await (const piece of tts.synthesize({ ...input([], { format: PCM16_8K }), text: 'Hi. ' }))
      pieces.push(Array.from(piece));
    expect(pieces).toEqual([
      [1, 2],
      [3, 4, 5, 6],
      [7, 8],
    ]);
    net.assertComplete();
  });

  it('fails a context whose audio ends mid-sample', async () => {
    const net = createFixtureNet([
      wsScript([
        socketOpen(),
        ...said('ovo-1', 'Hi. ', PCM16_8K),
        { send: chunk('ovo-1', [1, 2, 3]) },
        { send: doneEvent('ovo-1') },
      ]),
    ]);
    const tts = new CartesiaTts(net, 'fixture-key', { voiceId: VOICE });
    await expect(
      drain(tts.synthesize({ ...input([], { format: PCM16_8K }), text: 'Hi. ' })),
    ).rejects.toThrow(/mid-sample/);
  });
});
