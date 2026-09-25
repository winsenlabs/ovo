import { describe, expect, it } from 'vitest';
import { MULAW_8K, type SessionInput, type TextToSpeech } from '@winsendotai/ovo-contracts';
import { createFakeCarrier } from '../../conformance/src/drivers/fake-carrier.ts';
import { BoundedSpeechScheduler } from '../src/scheduler.ts';
import { NativeStreamingSpeechOutput } from '../src/speech/media-output-v2.ts';
import { markdownFilter, urlFilter } from '../src/speech/text-filters.ts';

const session: SessionInput = {
  mode: 'faq',
  language: 'en-US',
  inputEnabled: false,
  variables: {},
  maxCallSeconds: 60,
  acknowledgements: [],
};

function tts(firstByteMs = 40): TextToSpeech {
  return {
    capabilities: {
      outputFormats: [MULAW_8K],
      languages: ['en-US'],
      interim: false,
      wordTimestamps: false,
      turnSignals: [],
      forceEndpoint: false,
    },
    cacheIdentity: () => ({ provider: 'fixture', model: 'test', voice: 'v', revision: '1' }),
    async *synthesize(input) {
      await new Promise((resolve) => setTimeout(resolve, firstByteMs));
      input.signal.throwIfAborted();
      yield new Uint8Array(160).fill(input.text === 'first' ? 1 : 2);
    },
  };
}

describe('native speech pipelining', () => {
  it('keeps outputs without prepare serial even when the engine requests pipelining', async () => {
    const started: string[] = [];
    let finishFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => (finishFirst = resolve));
    const speech = new BoundedSpeechScheduler({
      async play(segment) {
        started.push(segment.text);
        if (segment.text === 'first') await firstGate;
        return { state: 'completed', evidence: 'simulated' };
      },
      async interrupt() {},
    });
    speech.configurePipeline(2);
    const first = speech.speak('first');
    const second = speech.speak('second');
    try {
      await waitFor(() => started.length > 0);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(started).toEqual(['first']);
      finishFirst();
      await Promise.all([first, second]);
      expect(started).toEqual(['first', 'second']);
    } finally {
      finishFirst();
      await speech.dispose();
    }
  });

  it('does not interleave chunks while an earlier carrier send is deferred', async () => {
    const carrier = createFakeCarrier({ playback: 'manual' });
    const sent: number[] = [];
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => (releaseSend = resolve));
    const media = {
      ...carrier.duplex,
      async sendAudio(bytes: Uint8Array, signal?: AbortSignal) {
        sent.push(bytes[0]!);
        if (bytes[0] === 2) await sendGate;
        await carrier.duplex.sendAudio(bytes, signal);
      },
    };
    const multiChunk: TextToSpeech = {
      ...tts(0),
      async *synthesize(input) {
        if (input.text === 'first') {
          yield Uint8Array.of(1);
          yield Uint8Array.of(2);
        } else {
          yield Uint8Array.of(3);
          yield Uint8Array.of(4);
        }
      },
    };
    const output = new NativeStreamingSpeechOutput(multiChunk, media, session, () => undefined, {
      markTimeoutMs: 5000,
    });
    const speech = new BoundedSpeechScheduler(output);
    speech.configurePipeline(2);
    const first = speech.speak('first');
    const second = speech.speak('second');
    try {
      await waitFor(() => sent.includes(2));
      expect(sent).toEqual([1, 2]);
      releaseSend();
      await waitFor(() => carrier.log.filter((entry) => entry.type === 'mark').length === 2);
      expect(sent).toEqual([1, 2, 3, 4]);
      carrier.drain();
      await Promise.all([first, second]);
    } finally {
      releaseSend();
      carrier.drain();
      await Promise.allSettled([first, second]);
      output.dispose();
      await speech.dispose();
    }
  });

  it('sends the next segment within one frame while receipts wait for their own marks', async () => {
    const carrier = createFakeCarrier({ playback: 'manual' });
    const output = new NativeStreamingSpeechOutput(
      tts(),
      carrier.duplex,
      session,
      () => undefined,
      { markTimeoutMs: 5000 },
    );
    const speech = new BoundedSpeechScheduler(output);
    speech.configurePipeline(2);
    let settled = 0;
    const first = speech.speak('first').then((receipt) => {
      settled++;
      return receipt;
    });
    const second = speech.speak('second').then((receipt) => {
      settled++;
      return receipt;
    });
    await waitFor(() => carrier.log.filter((entry) => entry.type === 'mark').length === 2);
    const audio = carrier.log.filter((entry) => entry.type === 'audio');
    expect(audio).toHaveLength(2);
    expect(audio[1]!.atMs - audio[0]!.atMs).toBeLessThanOrEqual(20);
    expect(settled).toBe(0);
    carrier.drain();
    expect((await first).evidence).toBe('confirmed');
    expect((await second).evidence).toBe('confirmed');
    output.dispose();
    await speech.dispose();
  });

  it('cancels prefetched audio and pending marks before a clear echo', async () => {
    const carrier = createFakeCarrier({ playback: 'manual', clearFlushesMarkers: true });
    const output = new NativeStreamingSpeechOutput(
      tts(1),
      carrier.duplex,
      session,
      () => undefined,
    );
    const speech = new BoundedSpeechScheduler(output);
    speech.configurePipeline(2);
    const first = speech.speak('first');
    const second = speech.speak('second');
    await waitFor(() => carrier.log.filter((entry) => entry.type === 'mark').length === 2);
    await speech.beginEpoch();
    expect((await first).state).toBe('interrupted');
    expect((await second).state).toBe('interrupted');
    expect(carrier.log.some((entry) => entry.type === 'played' && entry.flushed)).toBe(true);
    expect(speech.history.some((entry) => entry.phase === 'acknowledged')).toBe(false);
    output.dispose();
    await speech.dispose();
  });

  it('applies filters in order and returns exactly the spoken text', async () => {
    const seen: string[] = [];
    const speech = new BoundedSpeechScheduler({
      async play(segment) {
        seen.push(segment.text);
        return { state: 'completed', evidence: 'simulated' };
      },
      async interrupt() {},
    });
    speech.configureFilters([urlFilter, markdownFilter], 'en-US');
    const receipt = await speech.speak('**Visit** https://example.com');
    expect(seen).toEqual(['Visit example dot com']);
    expect(receipt.text).toBe('Visit example dot com');
    await speech.dispose();
  });

  it('starts a fresh epoch while an aborted TTS iterator ignores cancellation', async () => {
    const carrier = createFakeCarrier({ playback: 'manual' });
    let releaseOld!: () => void;
    const blocked = new Promise<void>((resolve) => (releaseOld = resolve));
    let oldStarted = false;
    const stubborn: TextToSpeech = {
      ...tts(0),
      async *synthesize(input) {
        if (input.text === 'old') {
          oldStarted = true;
          await blocked;
        }
        yield new Uint8Array(160).fill(input.text === 'old' ? 1 : 2);
      },
    };
    const output = new NativeStreamingSpeechOutput(
      stubborn,
      carrier.duplex,
      session,
      () => undefined,
      {
        markTimeoutMs: 100,
      },
    );
    let oldPlayStarted = false;
    const play = output.play.bind(output);
    output.play = (segment, options) => {
      if (segment.text === 'old') oldPlayStarted = true;
      return play(segment, options);
    };
    const speech = new BoundedSpeechScheduler(output);
    speech.configurePipeline(2);
    const old = speech.speak('old');
    let fresh: Promise<Awaited<typeof old>> | undefined;
    try {
      await waitFor(() => oldStarted && oldPlayStarted);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await speech.beginEpoch();
      fresh = speech.speak('fresh');
      await waitFor(() => carrier.log.some((event) => event.type === 'audio'));
      expect(carrier.log.filter((event) => event.type === 'audio')).toHaveLength(1);
      carrier.drain();
      expect((await fresh).state).toBe('completed');
      expect((await old).state).toBe('interrupted');
    } finally {
      releaseOld();
      carrier.drain();
      await Promise.allSettled([old, fresh]);
      output.dispose();
      await speech.dispose();
    }
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for carrier marks');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
