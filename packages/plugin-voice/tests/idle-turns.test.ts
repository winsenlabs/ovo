import { describe, expect, it } from 'vitest';
import type {
  Behavior,
  EngineEvent,
  MediaDuplex,
  SessionInput,
  TurnDecision,
} from '@winsendotai/ovo-contracts';
import { FakeClock, flushMicrotasks } from '../../conformance/src/drivers/fake-clock.ts';
import { VoiceEventBus } from '../src/engine/events.ts';
import { TurnLatency } from '../src/engine/latency.ts';
import { TurnDriver, type DriverEndReason } from '../src/engine/turn-driver.ts';
import { BoundedSpeechScheduler } from '../src/scheduler.ts';

const session: SessionInput = {
  mode: 'agent',
  language: 'en-IN',
  inputEnabled: true,
  variables: {},
  maxCallSeconds: 600,
  acknowledgements: [],
};

/** A behaviour that handles silence itself: two prompts, then it ends the call. */
function silent(idleTimeoutMs?: number) {
  const asked: Record<string, unknown>[] = [];
  let silences = 0;
  let complete = false;
  const behavior: Behavior & { idleTimeoutMs(): number | undefined } = {
    respond: async () => '',
    async *respondStream(input, variables = {}) {
      asked.push({ input, ...variables });
      if (variables.inputEvent === 'idle') {
        silences += 1;
        if (silences > 2) complete = true;
        yield silences > 2 ? 'Goodbye.' : `Hello? (${silences})`;
      } else {
        silences = 0;
        yield `You said ${input}.`;
      }
    },
    speechKind: (text) => (text.startsWith('Hello?') ? 'idle-prompt' : undefined),
    isComplete: () => complete,
    completionReason: () => (complete ? 'idle:no-input' : undefined),
    idleTimeoutMs: () => idleTimeoutMs,
  };
  return { behavior, asked };
}

function harness(behavior: Behavior) {
  const clock = new FakeClock();
  const bus = new VoiceEventBus();
  const spoken: { text: string; kind?: string }[] = [];
  const scheduler = new BoundedSpeechScheduler({
    async play(segment) {
      spoken.push({ text: segment.text, kind: segment.kind });
      return { state: 'completed', evidence: 'confirmed' };
    },
    async interrupt() {},
  });
  const ended: { reason: DriverEndReason; detail?: string }[] = [];
  const engine: EngineEvent[] = [];
  bus.onEngine((event) => engine.push(event));
  const driver = new TurnDriver(
    behavior,
    scheduler,
    session,
    bus,
    new TurnLatency(clock, () => undefined),
    (reason, detail) => ended.push({ reason, ...(detail ? { detail } : {}) }),
    4,
    { sessionId: 's-1', playbackEvidence: 'carrier-played' } as MediaDuplex,
    clock,
  );
  const settle = async () => {
    for (let index = 0; index < 5; index += 1) await flushMicrotasks();
  };
  const caller = (text: string) =>
    driver.decide({
      type: 'turn.stopped',
      turnId: `t-${text}`,
      input: { kind: 'speech', text, segments: 1 },
    } satisfies TurnDecision);
  return { clock, bus, driver, spoken, ended, engine, settle, caller };
}

describe('behaviour-driven idle turns (AGT-11)', () => {
  it('arms once the agent has finished speaking and runs an idle turn on silence', async () => {
    const { behavior, asked } = silent(5000);
    const { clock, driver, spoken, settle, engine } = harness(behavior);
    driver.opening();
    await settle();
    expect(spoken.map((line) => line.text)).toEqual(['You said .']);
    await clock.advanceAsync(4999);
    expect(asked).toHaveLength(1);
    await clock.advanceAsync(1);
    await settle();
    expect(asked[1]).toMatchObject({ input: '', inputEvent: 'idle' });
    expect(spoken.at(-1)).toEqual({ text: 'Hello? (1)', kind: 'idle-prompt' });
    expect(engine).toContainEqual({ type: 'user.turn', phase: 'idle', turnId: 'idle-1' });
  });

  it('escalates on each silence and ends the call as no input after the final line', async () => {
    const { behavior } = silent(5000);
    const { clock, driver, spoken, ended, settle } = harness(behavior);
    driver.opening();
    await settle();
    for (let silence = 0; silence < 3; silence += 1) {
      await clock.advanceAsync(5000);
      await settle();
    }
    expect(spoken.map((line) => line.text)).toEqual([
      'You said .',
      'Hello? (1)',
      'Hello? (2)',
      'Goodbye.',
    ]);
    expect(ended).toEqual([{ reason: 'caller_idle', detail: 'idle:no-input' }]);
  });

  it('never fires while the caller is speaking, and starts over after their turn', async () => {
    const { behavior, asked } = silent(5000);
    const { clock, bus, driver, settle, caller } = harness(behavior);
    driver.opening();
    await settle();
    await clock.advanceAsync(3000);
    bus.observe({ type: 'vad.start', atMs: clock.now() });
    await clock.advanceAsync(10_000);
    expect(asked).toHaveLength(1);
    // Speech that came to nothing re-arms the full timeout.
    bus.observe({ type: 'vad.stop', atMs: clock.now() });
    await clock.advanceAsync(4000);
    bus.observe({
      type: 'stt',
      event: { type: 'transcript', segment: { segmentId: 'a', text: 'I', stability: 'interim' } },
      atMs: clock.now(),
    } as never);
    caller('I will pay');
    await settle();
    expect(asked.map((entry) => entry.input)).toEqual(['', 'I will pay']);
    await clock.advanceAsync(5000);
    await settle();
    expect(asked.at(-1)).toMatchObject({ inputEvent: 'idle' });
  });

  it("ignores the turn detector's own idle prompts and hang-up", async () => {
    const { behavior } = silent(5000);
    const { driver, spoken, ended, settle } = harness(behavior);
    driver.decide({ type: 'idle', retry: 1, final: false, prompt: 'Are you still there?' });
    driver.decide({ type: 'idle', retry: 2, final: true });
    await settle();
    expect(spoken).toEqual([]);
    expect(ended).toEqual([]);
  });

  it('keeps the turn detector idle path for a behaviour without an idle policy', async () => {
    const { behavior } = silent();
    const { clock, driver, spoken, ended, settle } = harness(behavior);
    driver.opening();
    await settle();
    await clock.advanceAsync(60_000);
    driver.decide({ type: 'idle', retry: 1, final: false, prompt: 'Are you still there?' });
    await settle();
    expect(spoken.at(-1)).toEqual({ text: 'Are you still there?', kind: 'idle-prompt' });
    driver.decide({ type: 'idle', retry: 2, final: true });
    expect(ended).toEqual([{ reason: 'caller_idle' }]);
  });

  it('stops timing silence once disposed', async () => {
    const { behavior, asked } = silent(5000);
    const { clock, driver, settle } = harness(behavior);
    driver.opening();
    await settle();
    await driver.dispose();
    await clock.advanceAsync(20_000);
    expect(asked).toHaveLength(1);
    expect(clock.pendingTimers).toBe(0);
  });
});
