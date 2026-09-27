import { type TurnDecision, type TurnDetectorFactory } from '@winsendotai/ovo-contracts';
import { expect, it } from 'vitest';
import { createFakeCarrier } from '../../conformance/src/drivers/fake-carrier.ts';
import { NativeVoiceSessionEngine } from '../src/engine/session-engine.ts';
import { BoundedSpeechScheduler } from '../src/scheduler.ts';

it('starts the next turn when an interrupted behavior stream never yields again', async () => {
  const carrier = createFakeCarrier();
  const inputs: string[] = [];
  const spoken: string[] = [];
  let releaseStream!: () => void;
  const stalled = new Promise<void>((resolve) => (releaseStream = resolve));
  let waitingForNext = false;
  let decide!: (decision: TurnDecision) => void;
  const detector: TurnDetectorFactory = {
    create() {
      const listeners = new Set<(decision: TurnDecision) => void>();
      decide = (decision) => {
        for (const listener of listeners) listener(decision);
      };
      return {
        observe() {},
        on(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        dispose() {},
      };
    },
  };
  const engine = new NativeVoiceSessionEngine({
    behavior: {
      respond: async () => '',
      async *respondStream(input) {
        inputs.push(input);
        yield `${input} reply`;
        if (input === 'first') {
          waitingForNext = true;
          await stalled;
          yield 'late stale reply';
        }
      },
      cancel() {}, // a real provider can ignore cancellation after yielding a chunk
    },
    scheduler: new BoundedSpeechScheduler({
      async play(segment) {
        spoken.push(segment.text);
        return { state: 'completed', evidence: 'simulated' };
      },
      async interrupt() {},
    }),
    media: carrier.duplex,
    turnDetector: detector,
    session: {
      mode: 'faq',
      language: 'en-US',
      inputEnabled: false,
      variables: {},
      maxCallSeconds: 60,
      acknowledgements: [],
    },
  });
  try {
    await engine.start();
    decide({
      type: 'turn.stopped',
      turnId: 'first',
      input: { kind: 'speech', text: 'first', segments: 1 },
    });
    await until(() => waitingForNext);
    decide({ type: 'interrupt', reason: 'transcript' });
    decide({
      type: 'turn.stopped',
      turnId: 'second',
      input: { kind: 'speech', text: 'second', segments: 1 },
    });
    await until(() => inputs.includes('second'));
    expect(inputs).toEqual(['first', 'second']);
    releaseStream();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(spoken).not.toContain('late stale reply');
  } finally {
    releaseStream();
    await engine.dispose('drain');
  }
});

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('next turn did not start after interrupt');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
