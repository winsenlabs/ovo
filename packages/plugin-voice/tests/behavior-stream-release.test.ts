import { expect, it } from 'vitest';
import type { Behavior, SessionInput } from '@winsendotai/ovo-contracts';
import { createFakeCarrier } from '../../conformance/src/drivers/fake-carrier.ts';
import { NativeVoiceSessionEngine } from '../src/engine/session-engine.ts';
import { BoundedSpeechScheduler } from '../src/scheduler.ts';

const session: SessionInput = {
  mode: 'faq',
  language: 'en-US',
  inputEnabled: false,
  initialInput: 'first',
  variables: {},
  maxCallSeconds: 60,
  acknowledgements: [],
};

it.each(['barge-in', 'hangup', 'dispose', 'epoch-change'] as const)(
  'releases a no-cancel behavior generator after %s',
  async (exit) => {
    const carrier = createFakeCarrier();
    const inputs: string[] = [];
    const spoken: string[] = [];
    let releaseProvider!: () => void;
    const pendingProvider = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    let finishPlayback!: () => void;
    const pendingPlayback = new Promise<void>((resolve) => {
      finishPlayback = resolve;
    });
    let nextPending = false;
    let playing = false;
    let released = 0;
    let firstStream: AsyncGenerator<string> | undefined;
    const behavior: Behavior = {
      respond: async () => '',
      respondStream(input) {
        async function* generate() {
          inputs.push(input);
          try {
            yield `${input} reply`;
            if (input === 'first') {
              nextPending = true;
              await pendingProvider;
              yield 'late stale reply';
            }
          } finally {
            if (input === 'first') released++;
          }
        }
        const stream = generate();
        if (input === 'first') firstStream = stream;
        return stream;
      },
    };
    const speech = new BoundedSpeechScheduler({
      async play(segment) {
        spoken.push(segment.text);
        if (segment.text === 'first reply') {
          playing = true;
          await pendingPlayback;
          playing = false;
        }
        return { state: 'completed', evidence: 'simulated' };
      },
      async interrupt() {
        if (playing) finishPlayback();
      },
    });
    const engine = new NativeVoiceSessionEngine({
      behavior,
      scheduler: speech,
      media: carrier.duplex,
      session,
    });
    try {
      expect(behavior.cancel).toBeUndefined();
      await engine.start();
      await expect.poll(() => nextPending && playing).toBe(true);
      if (exit === 'barge-in') {
        // Real carrier DTMF -> production fallback controller -> TurnDriver interruption.
        carrier.caller.dtmf('1');
        carrier.caller.dtmf('#');
        await expect.poll(() => inputs).toEqual(['first', '1']);
      } else if (exit === 'hangup') {
        carrier.caller.hangup();
        await expect(engine.ended).resolves.toMatchObject({ reason: 'caller_hangup' });
      } else if (exit === 'dispose') {
        await expect(engine.dispose('drain')).resolves.toMatchObject({ reason: 'drain' });
      } else await speech.beginEpoch();
      // Async-generator return queues behind an in-flight next. Neither interruption
      // nor disposal may wait for this provider; once it settles, finally must run.
      expect(released).toBe(0);
      releaseProvider();
      await expect.poll(() => released).toBe(1);
      expect(spoken).not.toContain('late stale reply');
    } finally {
      releaseProvider();
      finishPlayback();
      await engine.dispose('drain');
      await firstStream?.return(undefined);
    }
  },
);

it.each(['done', 'next-error', 'return-reject', 'return-throw', 'no-return'] as const)(
  'settles a no-cancel iterator on %s without making cleanup a new turn failure',
  async (path) => {
    const carrier = createFakeCarrier();
    let returns = 0;
    const iterator: AsyncIterator<string> = {
      next: async () => {
        if (path === 'next-error') throw new Error('provider failed');
        return { done: true, value: undefined };
      },
      ...(path === 'no-return'
        ? {}
        : {
            return() {
              returns++;
              if (path === 'return-throw') throw new Error('synchronous cleanup failure');
              if (path === 'return-reject') return Promise.reject(new Error('cleanup rejected'));
              return Promise.resolve({ done: true as const, value: undefined });
            },
          }),
    };
    const behavior: Behavior = {
      respond: async () => '',
      respondStream: () => ({ [Symbol.asyncIterator]: () => iterator }),
      isComplete: () => true,
    };
    const engine = new NativeVoiceSessionEngine({
      behavior,
      media: carrier.duplex,
      session,
      scheduler: new BoundedSpeechScheduler({
        async play() {
          return { state: 'completed', evidence: 'simulated' };
        },
        async interrupt() {},
      }),
    });
    try {
      await engine.start();
      await expect(engine.ended).resolves.toMatchObject({
        reason: path === 'next-error' ? 'error:turn' : 'behavior_completed',
      });
      expect(returns).toBe(path === 'no-return' ? 0 : 1);
    } finally {
      await engine.dispose('drain');
    }
  },
);
