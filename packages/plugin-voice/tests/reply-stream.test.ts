import { describe, expect, it } from 'vitest';
import {
  MULAW_8K,
  type IncrementalTts,
  type SessionInput,
  type SynthesisInput,
  type TextToSpeech,
  type TtsReply,
} from '@winsendotai/ovo-contracts';
import { createFakeCarrier } from '../../conformance/src/drivers/fake-carrier.ts';
import { FakeClock } from '../../conformance/src/drivers/fake-clock.ts';
import { BoundedSpeechScheduler } from '../src/scheduler.ts';
import {
  NativeStreamingSpeechOutput,
  REPLY_IDLE_MS,
  ReplyStreams,
  warmSessionTts,
} from '../src/speech/media-output-v2.ts';

const session: SessionInput = {
  mode: 'agent',
  language: 'en-IN',
  inputEnabled: true,
  variables: {},
  maxCallSeconds: 60,
  acknowledgements: [],
};

const capabilities = {
  outputFormats: [MULAW_8K],
  languages: ['*'],
  interim: false,
  wordTimestamps: false,
  turnSignals: [] as const,
  forceEndpoint: false,
  incrementalText: true,
};

/**
 * A provider on the fake clock. The costs are fixture assumptions, not ElevenLabs measurements:
 * connecting the session socket (TLS + upgrade), setting up a fresh context (its first frame
 * carries the voice settings) and the time to first audio of a flushed segment.
 */
interface Costs {
  connectMs: number;
  contextMs: number;
  ttfbMs: number;
}

interface Model extends TextToSpeech {
  log: string[];
  replies: { segments: string[]; closed: boolean }[];
}

function modelTts(clock: FakeClock, costs: Costs, use: { reply: boolean }): Model {
  const sleep = (ms: number) => new Promise<void>((resolve) => clock.setTimeout(resolve, ms));
  let connected: Promise<void> | undefined;
  const connect = () => (connected ??= sleep(costs.connectMs));
  // 8 μ-law bytes per ms; 20 ms of audio per character keeps the numbers readable.
  const audio = (text: string) => new Uint8Array(text.length * 20 * 8).fill(0x7f);
  const log: string[] = [];
  const replies: Model['replies'] = [];
  const tts: Model = {
    log,
    replies,
    capabilities,
    cacheIdentity: () => ({ provider: 'model', model: 'm', voice: 'v', revision: '1' }),
    async *synthesize(input) {
      log.push(`synthesize:${input.text}`);
      await connect();
      await sleep(costs.contextMs + costs.ttfbMs);
      yield audio(input.text);
    },
    async warm() {
      log.push('warm');
      await connect();
    },
    async open(input): Promise<IncrementalTts> {
      await connect();
      let text = '';
      const flushed = Promise.withResolvers<void>();
      log.push('open');
      return {
        push: (more) => void (text += more),
        flush: () => flushed.resolve(),
        audio: (async function* () {
          await flushed.promise;
          await sleep(costs.contextMs + costs.ttfbMs);
          input.signal.throwIfAborted();
          yield audio(text);
        })(),
        close: async () => void log.push(`close:${text}`),
      };
    },
  };
  if (use.reply)
    tts.openReply = async (input: Omit<SynthesisInput, 'text'>): Promise<TtsReply> => {
      await connect();
      const record = { segments: [] as string[], closed: false };
      replies.push(record);
      log.push('openReply');
      let tail: Promise<void> = Promise.resolve();
      return {
        segment(text, signal) {
          record.segments.push(text);
          // Only the context's first segment pays for setting the context up.
          const due = sleep((record.segments.length === 1 ? costs.contextMs : 0) + costs.ttfbMs);
          // The provider renders a context's segments in order.
          const done = Promise.all([tail, due]).then(() => undefined);
          tail = done;
          return (async function* () {
            await done;
            signal.throwIfAborted();
            input.signal.throwIfAborted();
            yield audio(text);
          })();
        },
        async close() {
          record.closed = true;
        },
      };
    };
  return tts;
}

function rig(tts: TextToSpeech, clock: FakeClock) {
  const carrier = createFakeCarrier({ clock });
  const output = new NativeStreamingSpeechOutput(
    tts,
    carrier.duplex,
    session,
    () => undefined,
    {},
    clock,
  );
  const speech = new BoundedSpeechScheduler(output);
  speech.configurePipeline(2);
  return { carrier, output, speech };
}

async function run(clock: FakeClock, ms: number): Promise<void> {
  for (let step = 0; step < ms; step += 5) await clock.advanceAsync(5);
}

/** Carrier timeline from the audio sends: when the first byte went out, and the silence after. */
function timeline(log: ReturnType<typeof createFakeCarrier>['log']) {
  const sends = log.filter((entry) => entry.type === 'audio' && entry.bytes > 0) as {
    bytes: number;
    atMs: number;
  }[];
  let playing = 0;
  let silence = 0;
  for (const send of sends) {
    if (send.atMs > playing && playing) silence += send.atMs - playing;
    playing = Math.max(playing, send.atMs) + send.bytes / 8;
  }
  return { firstAudioMs: sends[0]?.atMs, silenceMs: silence };
}

describe('LAT-5 reply streams', () => {
  it('speaks every segment of a reply in one context, each with its own mark and receipt', async () => {
    const clock = new FakeClock();
    const tts = modelTts(clock, { connectMs: 0, contextMs: 0, ttfbMs: 50 }, { reply: true });
    const { carrier, output, speech } = rig(tts, clock);
    const receipts = ['Hello.', 'Your EMI is due.', 'Pay online.'].map((text) =>
      speech.speak(text),
    );
    await run(clock, 1_000);
    await expect(Promise.all(receipts)).resolves.toMatchObject([
      { text: 'Hello.', state: 'completed' },
      { text: 'Your EMI is due.', state: 'completed' },
      { text: 'Pay online.', state: 'completed' },
    ]);
    expect(tts.replies).toEqual([
      { segments: ['Hello.', 'Your EMI is due.', 'Pay online.'], closed: false },
    ]);
    expect(tts.log).not.toContain('open');
    expect(carrier.log.filter((entry) => entry.type === 'mark')).toHaveLength(3);
    // A reply that has gone quiet gives its context back.
    await run(clock, REPLY_IDLE_MS);
    expect(tts.replies[0]!.closed).toBe(true);
    output.dispose();
    await speech.dispose();
  });

  it('a barge-in closes only that reply; the next epoch opens its own', async () => {
    const clock = new FakeClock();
    const tts = modelTts(clock, { connectMs: 0, contextMs: 0, ttfbMs: 50 }, { reply: true });
    const { output, speech } = rig(tts, clock);
    const first = speech.speak('This is a long first answer that keeps going.');
    const second = speech.speak('And a second sentence.');
    await run(clock, 200);
    await speech.interrupt();
    await expect(first).resolves.toMatchObject({ state: 'interrupted' });
    await expect(second).resolves.toMatchObject({ state: 'interrupted' });
    expect(tts.replies.map((reply) => reply.closed)).toEqual([true]);
    const answer = speech.speak('Sorry, go ahead.');
    await run(clock, 1_000);
    await expect(answer).resolves.toMatchObject({ state: 'completed' });
    expect(tts.replies).toEqual([
      {
        segments: ['This is a long first answer that keeps going.', 'And a second sentence.'],
        closed: true,
      },
      { segments: ['Sorry, go ahead.'], closed: false },
    ]);
    output.dispose();
    await clock.advanceAsync(0);
    expect(tts.replies[1]!.closed).toBe(true);
    await speech.dispose();
  });

  it('speaks segment by segment when the provider cannot open a reply', async () => {
    const clock = new FakeClock();
    const tts = modelTts(clock, { connectMs: 0, contextMs: 0, ttfbMs: 10 }, { reply: true });
    tts.openReply = () => Promise.reject(new Error('reply refused'));
    const { output, speech } = rig(tts, clock);
    const receipts = [speech.speak('One.'), speech.speak('Two.')];
    await run(clock, 1_000);
    await expect(Promise.all(receipts)).resolves.toMatchObject([
      { state: 'completed' },
      { state: 'completed' },
    ]);
    expect(tts.log.filter((line) => line.startsWith('close:'))).toEqual([
      'close:One.',
      'close:Two.',
    ]);
    output.dispose();
    await speech.dispose();
  });

  it('synthesizes each sentence on its own for a provider without incremental text (OpenAI)', async () => {
    const clock = new FakeClock();
    const tts = modelTts(clock, { connectMs: 0, contextMs: 0, ttfbMs: 10 }, { reply: false });
    const batch: TextToSpeech = {
      capabilities: { ...capabilities, incrementalText: false },
      cacheIdentity: tts.cacheIdentity,
      synthesize: tts.synthesize,
    };
    const { output, speech } = rig(batch, clock);
    const receipts = [speech.speak('One.'), speech.speak('Two.')];
    await run(clock, 1_000);
    await expect(Promise.all(receipts)).resolves.toMatchObject([
      { state: 'completed' },
      { state: 'completed' },
    ]);
    expect(tts.log).toEqual(['synthesize:One.', 'synthesize:Two.']);
    output.dispose();
    await speech.dispose();
  });
});

describe('LAT-5 reply close (Wave 4 review)', () => {
  it('a new epoch closes the previous reply only after its last segment has played out', async () => {
    const tail = Promise.withResolvers<void>();
    const replies: { epoch: number; closed: boolean; aborted: () => boolean }[] = [];
    let epoch = 0;
    const tts: TextToSpeech = {
      capabilities,
      cacheIdentity: () => ({ provider: 'model', model: 'm', voice: 'v', revision: '1' }),
      synthesize: () => (async function* () {})(),
      async openReply(input) {
        const record = { epoch: ++epoch, closed: false, aborted: () => input.signal.aborted };
        replies.push(record);
        return {
          segment: (text) =>
            (async function* () {
              yield new Uint8Array([text.length]);
              // The segment's tail (trailing silence) is still on its way.
              if (record.epoch === 1) await tail.promise;
              if (input.signal.aborted) return;
              yield new Uint8Array([0]);
            })(),
          close: async () => void (record.closed = true),
        };
      },
    };
    const streams = ReplyStreams.for(tts, () => (async function* () {})())!;
    const input = {
      sessionId: 's',
      format: MULAW_8K,
      language: 'en-IN',
      signal: new AbortController().signal,
      onUsage: () => undefined,
    };
    const segment = (id: string, text: string, at: number) =>
      ({ id, text, epoch: at, kind: 'response', generatedAt: 0 }) as const;
    const goodbye = streams.audio(segment('a', 'Bye.', 1), input)[Symbol.asyncIterator]();
    expect(await goodbye.next()).toMatchObject({ value: new Uint8Array([4]) });
    // The next reply starts while the goodbye's tail is still arriving.
    const next = streams.audio(segment('b', 'Hello.', 2), input)[Symbol.asyncIterator]();
    expect(await next.next()).toMatchObject({ value: new Uint8Array([6]) });
    expect(replies.map((reply) => [reply.closed, reply.aborted()])).toEqual([
      [false, false],
      [false, false],
    ]);
    tail.resolve();
    expect(await goodbye.next()).toMatchObject({ value: new Uint8Array([0]) });
    expect(await goodbye.next()).toMatchObject({ done: true });
    expect(replies[0]!.closed).toBe(true);
    streams.dispose();
  });
});

describe('LAT-5 latency on the fake clock', () => {
  const costs: Costs = { connectMs: 300, contextMs: 100, ttfbMs: 150 };

  it('warming at session start takes the socket handshake off the first reply', async () => {
    const measure = async (warm: boolean) => {
      const clock = new FakeClock();
      const tts = modelTts(clock, costs, { reply: true });
      const { carrier, output, speech } = rig(tts, clock);
      if (warm) warmSessionTts(tts, MULAW_8K);
      // The caller's first turn ends 500 ms into the session.
      await run(clock, 500);
      const receipt = speech.speak('Hello, how can I help?');
      await run(clock, 2_000);
      await receipt;
      output.dispose();
      await speech.dispose();
      return timeline(carrier.log).firstAudioMs! - 500;
    };
    const cold = await measure(false);
    const warm = await measure(true);
    expect(cold).toBe(costs.connectMs + costs.contextMs + costs.ttfbMs);
    expect(warm).toBe(costs.contextMs + costs.ttfbMs);
  });

  it('a late sentence in the same reply skips the context setup, so the mid-reply gap shrinks', async () => {
    const measure = async (reply: boolean) => {
      const clock = new FakeClock();
      const tts = modelTts(clock, costs, { reply });
      const { carrier, output, speech } = rig(tts, clock);
      warmSessionTts(tts, MULAW_8K);
      await run(clock, 400);
      // "Okay." is 100 ms of audio; the model's next sentence arrives 300 ms later.
      const first = speech.speak('Okay.');
      await run(clock, 300);
      const second = speech.speak('Your EMI is due on the fifth.');
      await run(clock, 3_000);
      await Promise.all([first, second]);
      output.dispose();
      await speech.dispose();
      return timeline(carrier.log);
    };
    const perSegment = await measure(false);
    const perReply = await measure(true);
    expect(perReply.firstAudioMs).toBe(perSegment.firstAudioMs);
    expect(perSegment.silenceMs - perReply.silenceMs).toBe(costs.contextMs);
  });
});
