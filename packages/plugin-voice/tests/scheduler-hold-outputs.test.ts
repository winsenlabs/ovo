import { describe, expect, it } from 'vitest';
import {
  MULAW_8K,
  type Behavior,
  type BehaviorEvent,
  type SessionInput,
  type SpeechOutput,
  type SpeechSegment,
  type TextToSpeech,
} from '@winsendotai/ovo-contracts';
import { createFakeCarrier } from '../../conformance/src/drivers/fake-carrier.ts';
import { FakeClock } from '../../conformance/src/drivers/fake-clock.ts';
import { BoundedSpeechScheduler } from '../src/scheduler.ts';
import { NativeStreamingSpeechOutput } from '../src/speech/media-output-v2.ts';
import { driverHarness, sleep } from './turn-harness.ts';

const session: SessionInput = {
  mode: 'agent',
  language: 'en-IN',
  inputEnabled: true,
  variables: {},
  maxCallSeconds: 60,
  acknowledgements: [],
};

/**
 * A reply-streaming provider (LAT-5) on the fake clock. Each segment's audio arrives `ttfbMs` after
 * it is pushed; on abort a segment drops at once, as the ElevenLabs plugin's part audio does, or
 * (`prompt` false) only when its audio would have come.
 */
function replyTts(clock: FakeClock, ttfbMs: number, prompt = true) {
  const pushed: string[] = [];
  const tts: TextToSpeech = {
    capabilities: {
      outputFormats: [MULAW_8K],
      languages: ['*'],
      interim: false,
      wordTimestamps: false,
      turnSignals: [],
      forceEndpoint: false,
      incrementalText: true,
    },
    cacheIdentity: () => ({ provider: 'model', model: 'm', voice: 'v', revision: '1' }),
    async *synthesize() {
      throw new Error('reply streams only');
    },
    async openReply() {
      return {
        segment(text, signal) {
          pushed.push(text);
          return (async function* () {
            await sleep(clock, ttfbMs, prompt ? signal : undefined);
            signal.throwIfAborted();
            // 40 ms of audio.
            yield new Uint8Array(320).fill(0x7f);
          })();
        },
        async close() {},
      };
    },
  };
  return { tts, pushed };
}

async function run(clock: FakeClock, ms: number): Promise<void> {
  for (let step = 0; step < ms; step += 5) await clock.advanceAsync(5);
}

/**
 * Wave 6 review: a line taken back while the native output was synthesising it was put back in
 * the queue before that play had unwound. Released in the same tick or soon after, the replay
 * shared the line's per-segment state with the old play, whose cleanup then deleted it: a
 * TypeError in media-output-v2, the receipt rejected, and the call ended with error:turn.
 */
describe('a held line replays only after its old play has unwound (P1 review)', () => {
  for (const { releaseAfterMs, prompt } of [
    { releaseAfterMs: 0, prompt: true },
    { releaseAfterMs: 200, prompt: false },
  ]) {
    const drops = prompt ? 'drops at once' : 'drops late';
    it(`over the native output, released ${releaseAfterMs} ms after the hold (synthesis ${drops})`, async () => {
      const clock = new FakeClock();
      const { tts, pushed } = replyTts(clock, 500, prompt);
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
      // The opening has reached the carrier, so the output is known to report 'sent'.
      const opening = speech.speak('Hello.');
      await run(clock, 1_000);
      await expect(opening).resolves.toMatchObject({ state: 'completed' });

      const reply = speech.speak('Your EMI is due tomorrow.');
      const next = speech.speak('Can you pay today?');
      await run(clock, 100);
      speech.hold();
      if (releaseAfterMs) await run(clock, releaseAfterMs);
      speech.release();
      await run(clock, 2_000);

      await expect(Promise.all([reply, next])).resolves.toMatchObject([
        { text: 'Your EMI is due tomorrow.', state: 'completed' },
        { text: 'Can you pay today?', state: 'completed' },
      ]);
      expect(speech.history.filter((entry) => entry.phase === 'failed')).toEqual([]);
      // Each line reached the carrier once, in order, with its own mark.
      expect(
        carrier.log.filter((entry) => entry.type === 'mark').map((entry) => entry.name),
      ).toEqual(['speech-1:0', 'speech-2:0', 'speech-3:0']);
      expect(pushed.filter((text) => text === 'Your EMI is due tomorrow.')).toHaveLength(2);
      output.dispose();
      await speech.dispose();
    });
  }

  it('keeps the synthesis of a line taken back before the output began playing it', async () => {
    const prepared = Promise.withResolvers<void>();
    const signals: AbortSignal[] = [];
    const played: string[] = [];
    let sent = false;
    const output: SpeechOutput = {
      async prepare(segment: SpeechSegment, signal: AbortSignal) {
        signals.push(signal);
        if (segment.text === 'Slow.') await prepared.promise;
      },
      async play(segment, { report }) {
        played.push(segment.text);
        if (!sent) report?.('sent', 'estimated');
        sent = true;
        return { state: 'completed', evidence: 'confirmed' };
      },
      async interrupt() {},
    };
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    const speech = new BoundedSpeechScheduler(output);
    speech.configurePipeline(1);
    await speech.speak('Hello.');
    const slow = speech.speak('Slow.');
    await tick();
    speech.hold();
    prepared.resolve();
    await tick();
    // Prepared while held: it waits, and nothing was aborted.
    expect(played).toEqual(['Hello.']);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    speech.release();
    await expect(slow).resolves.toMatchObject({ state: 'completed' });
    expect(played).toEqual(['Hello.', 'Slow.']);
    // Played under the signal it was prepared with: the output's synthesis is the one it kept.
    expect(new Set(signals.slice(1)).size).toBe(1);
    await speech.dispose();
  });
});

describe('a turn the detector mutes at once (P1 review)', () => {
  it('holds nothing and loses no line when a talker is muted while a tool runs', async () => {
    const clock = new FakeClock();
    const listeners = new Set<(event: BehaviorEvent) => void>();
    const emit = (type: 'tool.started' | 'tool.settled') => {
      for (const listener of listeners)
        listener({ type, toolId: 'web_search', operationId: 'op-1' });
    };
    const behavior: Behavior = {
      respond: async () => '',
      async *respondStream(_input, variables = {}) {
        if (variables.inputEvent === 'opening') {
          yield 'Hello, this is Asha.';
          return;
        }
        yield 'Let me check that for you.';
        emit('tool.started');
        await sleep(clock, 3_000);
        emit('tool.settled');
        yield 'Your EMI is due tomorrow.';
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const { tts } = replyTts(clock, 300);
    const carrier = createFakeCarrier({ clock });
    const output = new NativeStreamingSpeechOutput(
      tts,
      carrier.duplex,
      session,
      () => undefined,
      {},
      clock,
    );
    const h = driverHarness(clock, behavior, { output });
    h.scheduler.configurePipeline(2);
    await h.greet();
    h.caller('when is my EMI due');
    // 'Let me check that for you.' is synthesising; a background talker's words arrive and the
    // detector, muted while the tool runs, starts and drops the turn in the same tick.
    await clock.advanceAsync(100);
    h.turn.started('turn-2');
    h.driver.decide({ type: 'turn.reset', turnId: 'turn-2', reason: 'muted' });
    await run(clock, 6_000);

    expect(h.endings).toEqual([]);
    const phases = (text: string) =>
      h.scheduler.history.filter((entry) => entry.text === text).map((entry) => entry.phase);
    // Started once: the muted turn did not take the line back and make it synthesise again.
    expect(phases('Let me check that for you.').filter((phase) => phase === 'started')).toEqual([
      'started',
    ]);
    expect(phases('Let me check that for you.')).toContain('completed');
    expect(phases('Your EMI is due tomorrow.')).toContain('completed');
    output.dispose();
    await h.driver.dispose();
  });
});
