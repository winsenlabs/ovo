import { describe, expect, it } from 'vitest';
import { MULAW_8K, type Behavior, type EngineEvent } from '@winsendotai/ovo-contracts';
import { createFakeCarrier } from '../../conformance/src/drivers/fake-carrier.ts';
import { FakeClock, flushMicrotasks } from '../../conformance/src/drivers/fake-clock.ts';
import { NativeVoiceSessionEngine } from '../src/engine/session-engine.ts';
import { BoundedSpeechScheduler } from '../src/scheduler.ts';

/** Greets first, then handles caller silence itself: one prompt, then a goodbye that ends it. */
function greeter(): Behavior & { idleTimeoutMs(): number } {
  let silences = 0;
  return {
    respond: async () => '',
    async *respondStream(_input, variables = {}) {
      if (variables.inputEvent === 'opening') yield 'Hello Ravi.';
      if (variables.inputEvent === 'idle') yield ++silences === 1 ? 'Are you there?' : 'Goodbye.';
    },
    speaksFirst: () => true,
    isComplete: () => silences > 1,
    completionReason: () => 'idle:no-input',
    idleTimeoutMs: () => 8000,
  };
}

describe('per-agent idle on the native engine (AGT-11)', () => {
  it("times the caller's silence on the engine clock and ends the call as no input", async () => {
    const clock = new FakeClock();
    const carrier = createFakeCarrier({ clock });
    const spoken: string[] = [];
    const engine = new NativeVoiceSessionEngine({
      clock,
      media: carrier.duplex,
      behavior: greeter(),
      scheduler: new BoundedSpeechScheduler({
        async play(segment) {
          spoken.push(segment.text);
          return { state: 'completed', evidence: 'confirmed' };
        },
        async interrupt() {},
      }),
      stt: {
        capabilities: {
          inputFormats: [MULAW_8K],
          languages: ['en-IN'],
          interim: true,
          wordTimestamps: false,
          turnSignals: ['end-of-turn'],
          forceEndpoint: false,
        },
        async start() {
          return { async write() {}, async finish() {}, async cancel() {} };
        },
      },
      textFilters: [],
      session: {
        mode: 'agent',
        language: 'en-IN',
        inputEnabled: true,
        variables: {},
        maxCallSeconds: 600,
        acknowledgements: [],
      },
    });
    const events: EngineEvent[] = [];
    engine.subscribe((event) => events.push(event));
    await engine.start();
    await expect.poll(() => spoken).toEqual(['Hello Ravi.']);
    await flushMicrotasks();
    await clock.advanceAsync(8000);
    await expect.poll(() => spoken).toEqual(['Hello Ravi.', 'Are you there?']);
    await flushMicrotasks();
    await clock.advanceAsync(8000);
    expect(await engine.ended).toEqual({ reason: 'caller_idle', outcome: 'no_input' });
    expect(spoken).toEqual(['Hello Ravi.', 'Are you there?', 'Goodbye.']);
    expect(events).toContainEqual({ type: 'end', reason: 'caller_idle', detail: 'idle:no-input' });
  });
});
