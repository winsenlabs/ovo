import { describe, expect, it } from 'vitest';
import type {
  Behavior,
  MediaDuplex,
  PartialUtterance,
  SessionInput,
  TurnSpeculation,
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
  variables: { name: 'Ravi', amount_due: 12500 },
  maxCallSeconds: 600,
  acknowledgements: [],
};

function harness(behavior: Behavior & TurnSpeculation) {
  const clock = new FakeClock();
  const scheduler = new BoundedSpeechScheduler({
    async play() {
      return { state: 'completed', evidence: 'confirmed' };
    },
    async interrupt() {},
  });
  const ended: { reason: DriverEndReason; detail?: string }[] = [];
  const driver = new TurnDriver(
    behavior,
    scheduler,
    session,
    new VoiceEventBus(),
    new TurnLatency(clock, () => undefined),
    (reason, detail) => ended.push({ reason, ...(detail ? { detail } : {}) }),
    4,
    { sessionId: 's-1', playbackEvidence: 'carrier-played' } as MediaDuplex,
    clock,
  );
  const settle = async () => {
    for (let index = 0; index < 5; index += 1) await flushMicrotasks();
  };
  return { driver, ended, settle };
}

/** Ends its first turn with `reason`, once the line has been said. */
function ending(reason: string) {
  let complete = false;
  const behavior: Behavior = {
    respond: async () => '',
    async *respondStream() {
      complete = true;
      yield 'Please hold.';
    },
    isComplete: () => complete,
    completionReason: () => (complete ? reason : undefined),
  };
  return behavior;
}

describe('a completion that hands the call on (AGT-15)', () => {
  it('ends a transfer reason as transferred, keeping the reason as the detail', async () => {
    const { driver, ended, settle } = harness(ending('transfer:flow:human'));
    driver.initial('');
    await settle();
    expect(ended).toEqual([{ reason: 'transferred', detail: 'transfer:flow:human' }]);
  });

  it('still ends any other completion as behavior_completed', async () => {
    const { driver, ended, settle } = harness(ending('decision:flow:goodbye'));
    driver.initial('');
    await settle();
    expect(ended).toEqual([{ reason: 'behavior_completed', detail: 'decision:flow:goodbye' }]);
  });
});

describe('partials carry the call variables (LAT-4, speculation #6)', () => {
  it('hands each partial the session variables, as the turn will get them', () => {
    const prepared: (PartialUtterance & { variables?: Record<string, unknown> })[] = [];
    const finalized: string[] = [];
    const behavior: Behavior & TurnSpeculation & { seen: string[] } = {
      seen: [],
      respond: async () => '',
      prepare(partial) {
        // `this` is the behaviour itself, never a wrapper.
        this.seen.push(partial.text);
        prepared.push(partial);
      },
      finalize: (final) => finalized.push(final.text),
    };
    const { driver } = harness(behavior);
    driver.decide({ type: 'turn.partial', turnId: 't-1', text: 'I will', stable: false });
    expect(prepared).toEqual([
      { turnId: 't-1', text: 'I will', stable: false, variables: session.variables },
    ]);
    expect(behavior.seen).toEqual(['I will']);
    // A copy: the behaviour cannot change the call's own variables.
    prepared[0]!.variables!.name = 'changed';
    expect(session.variables.name).toBe('Ravi');
  });
});
